import json,collections,statistics as st,itertools,sys,time
ETH=10**18; Q0=1_680_000_000_000_000_000; T0=10**27; FEE=100
BTS={int(k):v for k,v in json.load(open('block_ts.json')).items()}
TR=json.load(open('transfers.json'))
L=json.load(open('launches.json'))
T_BUY='0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455'; T_SELL='0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df'
T_STC='0x3bc39a5562b28f5fe8f36cecabfbaa12bb969acf05717994709225fc412a9934'; T_EX='0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7'
def u(x): return int(x,16)
def a(t): return '0x'+t[-40:]
lb={a(l['topics'][2]):u(l['blockNumber']) for l in L}
by=collections.defaultdict(list)
with open('events.jsonl') as f:
    for line in f:
        e=json.loads(line); c=e['address']
        if c in lb and u(e['blockNumber'])<=lb[c]+1500: by[c].append(e)
launches=[]
for l in L:
    pair='0x'+l['data'][26:66]
    if pair!='0x0000000000000000000000000000000000000000': continue
    token=a(l['topics'][1]); curve=a(l['topics'][2]); dep=a(l['topics'][3]); blk=u(l['blockNumber']); ts=BTS.get(blk)
    if ts is None: continue
    es=sorted(by.get(curve,[]),key=lambda e:(u(e['blockNumber']),u(e['logIndex'])))
    exempt={dep}|{a(e['topics'][1]) for e in es if e['topics'][0]==T_EX}
    stc=collections.defaultdict(list)
    for e in es:
        if e['topics'][0]==T_STC: stc[e['transactionHash']].append(u(e['data'][2:66]))
    evs=[]
    for e in es:
        t0=e['topics'][0]
        if t0 not in (T_BUY,T_SELL): continue
        b=u(e['blockNumber']); ets=BTS.get(b)
        if ets is None: continue
        d=e['data'][2:]; v=[u(d[i*64:(i+1)*64]) for i in range(4)]; rec=a(e['topics'][2])
        if t0==T_BUY:
            s=stc[e['transactionHash']].pop(0) if stc[e['transactionHash']] else 0
            evs.append(dict(k='buy',ts=ets,blk=b,li=u(e['logIndex']),rec=rec,q=v[0],tok=v[1],fee=v[2],ctax=v[3],stax=s,exempt=rec in exempt))
        else:
            evs.append(dict(k='sell',ts=ets,blk=b,li=u(e['logIndex']),rec=rec,tok=v[0],q=v[1],fee=v[2],ctax=v[3],stax=0,exempt=rec in exempt))
    for t in TR.get(token,[]):
        if t['f'] in exempt and t['t']!=curve and t['t']!='0x0000000000000000000000000000000000000000' and BTS.get(t['b']):
            evs.append(dict(k='dump',ts=BTS[t['b']],blk=t['b'],li=t['li'],rec=t['f'],to=t['t'],tok=t['v']))
    evs.sort(key=lambda e:(e['blk'],e['li']))
    launches.append(dict(token=token,curve=curve,dep=dep,ts=ts,blk=blk,exempt=exempt,evs=evs))
launches.sort(key=lambda x:(x['ts'],x['blk']))
print('ETH launches',len(launches),'span h %.1f'%((launches[-1]['ts']-launches[0]['ts'])/3600),'with dump events',sum(1 for la in launches if any(e['k']=='dump' for e in la['evs'])))
def fp(la):
    T=la['ts']; tr=[e for e in la['evs'] if e['k']!='dump']
    team=[t for t in tr if t['k']=='buy' and t['exempt'] and t['rec']!=la['dep'] and t['ts']==T]
    devb=[t for t in tr if t['k']=='buy' and t['rec']==la['dep'] and t['ts']==T]
    plus1=[t for t in tr if t['k']=='buy' and t['ts']==T+1]
    dumps=[e for e in la['evs'] if e['k']=='dump']
    return dict(team=len(team)>0,team_eth=sum(t['q'] for t in team)/ETH,dev=len(devb)>0,dev_eth=sum(t['q'] for t in devb)/ETH,n1=len(plus1),ntr=len(tr),first_dump=(dumps[0]['ts']-T) if dumps else None)
for la in launches: la['fp']=fp(la)
segs={'all':lambda f:True,'team':lambda f:f['team'],'team>=0.1':lambda f:f['team'] and f['team_eth']>=0.1,'dev_only':lambda f:f['dev'] and not f['team'],'none':lambda f:not f['team'] and not f['dev']}
print('segments',{k:sum(1 for la in launches if v(la['fp'])) for k,v in segs.items()})
print('+1s taxed-buy competition: launches with >=1 taxed buy at +1s %d/%d; #buys in +1s:'%(sum(1 for la in launches if la['fp']['n1']>0),len(launches)),sorted(collections.Counter(min(la['fp']['n1'],8) for la in launches).items()))
def simulate(la,buy_eth,tp,trail,sl,timeout,pos='first',horizon=300,dump_exit=False):
    T0s=la['ts']; Q,T=Q0,T0; evs=la['evs']; ctax_bps=None
    for t in evs:
        if t['k']=='buy' and t['q']>0: ctax_bps=t['ctax']*10000//t['q']; break
    if ctax_bps is None: ctax_bps=100
    i=0
    def apply(t):
        nonlocal Q,T
        if t['k']=='buy': Q+=t['q']-t['fee']-t['ctax']; T-=t['tok']  # fee already includes snipe tax
        elif t['k']=='sell': T+=t['tok']; Q-=(t['q']+t['fee']+t['ctax'])
    cutoff=T0s if pos=='first' else T0s+1
    while i<len(evs) and evs[i]['ts']<=cutoff: apply(evs[i]); i+=1
    g=int(buy_eth*ETH); net=g*(10000-FEE-ctax_bps-618)//10000
    tok=T*net//(Q+net); Q+=net; T-=tok
    entry_px=Q/T; entry_ts=T0s+1; peak=entry_px; last_ts=entry_ts
    def liq(): return (Q*tok//(T+tok))*(10000-FEE-ctax_bps)/10000/ETH
    reason=None; val=None; ets=None
    while i<len(evs):
        t=evs[i]
        if t['ts']-entry_ts>horizon: break
        if timeout and t['ts']-entry_ts>=timeout: reason='timeout'; val=liq(); ets=last_ts; break
        if t['k']=='dump':
            i+=1
            if dump_exit: reason='dump'; val=liq(); ets=t['ts']; break
            continue
        apply(t); i+=1; last_ts=t['ts']
        px=Q/T; chg=(px/entry_px-1)*100; peak=max(peak,px)
        if trail and (peak/entry_px-1)*100>=trail[0] and (px/peak-1)*100<=-trail[1]: reason='trail'; val=liq(); ets=t['ts']; break
        if tp and chg>=tp: reason='tp'; val=liq(); ets=t['ts']; break
        if sl and chg<=-sl: reason='sl'; val=liq(); ets=t['ts']; break
    if reason is None: reason='end'; val=liq(); ets=last_ts
    return dict(pnl=val-buy_eth,reason=reason,hold=ets-entry_ts,peak_pct=(peak/entry_px-1)*100)
def agg(res):
    if not res: return None
    p=[r['pnl'] for r in res]; return dict(n=len(p),win=100*sum(1 for x in p if x>0)/len(p),mean=st.mean(p),med=st.median(p),total=sum(p),worst=min(p),best=max(p),reasons=dict(collections.Counter(r['reason'] for r in res)))
def fmt(a_): return 'n=%d win=%.0f%% mean=%+.4f med=%+.4f total=%+.3f worst=%+.3f best=%+.3f %s'%(a_['n'],a_['win'],a_['mean'],a_['med'],a_['total'],a_['worst'],a_['best'],a_['reasons']) if a_ else 'n=0'
VIDEO=dict(tp=150,trail=(100,25),sl=40,timeout=60)
out=[]
def P(*x): s=' '.join(str(y) for y in x); print(s); out.append(s)
P('\n=== VIDEO preset, 0.07 ETH, first-in-block, 3-day dataset ===')
for k,v in segs.items():
    sub=[la for la in launches if v(la['fp'])]
    P(f'{k:10s} base     ',fmt(agg([simulate(la,0.07,**VIDEO) for la in sub])))
    P(f'{k:10s} +dumpexit',fmt(agg([simulate(la,0.07,dump_exit=True,**VIDEO) for la in sub])))
    P(f'{k:10s} last     ',fmt(agg([simulate(la,0.07,pos="last",**VIDEO) for la in sub])))
P('\n=== dump timing (team segment): first exempt transfer-out seconds after launch ===')
fd=[la['fp']['first_dump'] for la in launches if la['fp']['team'] and la['fp']['first_dump'] is not None]
if fd: xs=sorted(fd); P('n',len(xs),'p10',xs[len(xs)//10],'median',xs[len(xs)//2],'p90',xs[9*len(xs)//10])
# walk-forward by day
days=sorted({time.strftime('%Y-%m-%d',time.gmtime(la['ts'])) for la in launches})
P('\n=== walk-forward by UTC day',days,'===')
grid=list(itertools.product([None,100,150,300],[None,(50,20),(100,25)],[None,40],[30,60],[False,True]))
def best_grid(sub):
    best=None
    for tp,trail,sl,to,de in grid:
        a_=agg([simulate(la,0.07,tp=tp,trail=trail,sl=sl,timeout=to,dump_exit=de) for la in sub])
        if a_ and (best is None or a_['mean']>best[0]): best=(a_['mean'],tp,trail,sl,to,de)
    return best
for seg in ('team','team>=0.1','all'):
    for i in range(1,len(days)):
        fit=[la for la in launches if segs[seg](la['fp']) and time.strftime('%Y-%m-%d',time.gmtime(la['ts']))<days[i]]
        test=[la for la in launches if segs[seg](la['fp']) and time.strftime('%Y-%m-%d',time.gmtime(la['ts']))==days[i]]
        if len(fit)<20 or len(test)<10: continue
        b=best_grid(fit)
        res=[simulate(la,0.07,tp=b[1],trail=b[2],sl=b[3],timeout=b[4],dump_exit=b[5]) for la in test]
        P(f'{seg:10s} fit<{days[i]} n={len(fit)} best tp={b[1]} trail={b[2]} sl={b[3]} to={b[4]} dump={b[5]} fitmean={b[0]:+.4f} -> test {days[i]}:',fmt(agg(res)))
        P(f'{seg:10s}   video preset on {days[i]}:',fmt(agg([simulate(la,0.07,**VIDEO) for la in test])))
# operator clustering + selection walk-forward
parent={}
def find(x):
    parent.setdefault(x,x)
    while parent[x]!=x: parent[x]=parent[parent[x]]; x=parent[x]
    return x
for la in launches:
    keys=['dep:'+la['dep']]+['ex:'+x for x in la['exempt'] if x!=la['dep']]
    for k in keys[1:]: parent[find(keys[0])]=find(k)
    la['cl']=keys[0]
for la in launches: la['cl']=find(la['cl'])
cl=collections.defaultdict(list)
for la in launches: cl[la['cl']].append(la)
sizes=sorted((len(v) for v in cl.values()),reverse=True)
P('\n=== operators: clusters',len(cl),'sizes top',sizes[:12],'singletons',sum(1 for s in sizes if s==1),'===')
rows=[]
for k,v in cl.items():
    res=[simulate(la,0.07,dump_exit=True,**VIDEO) for la in v]; a_=agg(res)
    rows.append((len(v),a_['total'],a_['win'],st.median([r['peak_pct'] for r in res]),k,v))
rows.sort(key=lambda r:-r[0])
for n,tot,win,mp,k,v in rows[:15]:
    P(f'  n={n:3d} total={tot:+.3f} win={win:3.0f}% medPeak={mp:+.0f}% team={sum(1 for la in v if la["fp"]["team"])} dev={sum(1 for la in v if la["fp"]["dev"])} key={k[:16]} span_h={(v[-1]["ts"]-v[0]["ts"])/3600:.1f}')
P('\n=== operator selection walk-forward (select clusters with >=3 fit launches, fit total>0 and win>=40%; trade their launches next day, video preset + dump exit) ===')
for i in range(1,len(days)):
    d=days[i]; sel=set(); 
    for k,v in cl.items():
        fit=[la for la in v if time.strftime('%Y-%m-%d',time.gmtime(la['ts']))<d]
        if len(fit)>=3:
            a_=agg([simulate(la,0.07,dump_exit=True,**VIDEO) for la in fit])
            if a_['total']>0 and a_['win']>=40: sel.add(k)
    test=[la for la in launches if la['cl'] in sel and time.strftime('%Y-%m-%d',time.gmtime(la['ts']))==d]
    P(f'  {d}: selected operators={len(sel)} ->',fmt(agg([simulate(la,0.07,dump_exit=True,**VIDEO) for la in test])))
    test2=[la for la in launches if la['cl'] in sel and la['fp']['team'] and time.strftime('%Y-%m-%d',time.gmtime(la['ts']))==d]
    P(f'  {d}: selected AND team-buy fingerprint ->',fmt(agg([simulate(la,0.07,dump_exit=True,**VIDEO) for la in test2])))
open('results.txt','w').write('\n'.join(out))
json.dump([dict(token=la['token'],ts=la['ts'],dep=la['dep'],cl=la['cl'],fp=la['fp']) for la in launches],open('per_launch.json','w'))
