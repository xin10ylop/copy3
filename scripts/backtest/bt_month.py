import json,collections,statistics as st,itertools,time,random,csv
ETH=10**18; Q0=1_680_000_000_000_000_000; T0=10**27; FEE=100
BTS={int(k):v for k,v in json.load(open('block_ts.json')).items()}
TR=json.load(open('transfers.json'))
T_BUY='0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455'; T_SELL='0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df'
T_STC='0x3bc39a5562b28f5fe8f36cecabfbaa12bb969acf05717994709225fc412a9934'; T_EX='0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7'
def u(x): return int(x,16)
def a(t): return '0x'+t[-40:]
L=[json.loads(l) for l in open('launches.jsonl')]
lb={a(l['topics'][2]):u(l['blockNumber']) for l in L}
by=collections.defaultdict(list)
for line in open('events.jsonl'):
    e=json.loads(line); by[e['address']].append(e)
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
        if t['f'] in exempt and t['t']!=curve and t['t']!='0x'+'0'*40 and BTS.get(t['b']):
            evs.append(dict(k='dump',ts=BTS[t['b']],blk=t['b'],li=t['li'],rec=t['f'],to=t['t'],tok=t['v']))
    evs.sort(key=lambda e:(e['blk'],e['li']))
    launches.append(dict(token=token,curve=curve,dep=dep,ts=ts,blk=blk,exempt=exempt,evs=evs,day=time.strftime('%Y-%m-%d',time.gmtime(ts))))
launches.sort(key=lambda x:(x['ts'],x['blk']))
by=None
out=[]
def P(*x): s=' '.join(str(y) for y in x); print(s,flush=True); out.append(s)
P('ETH launches',len(launches),'span days %.1f'%((launches[-1]['ts']-launches[0]['ts'])/86400),'with dump events',sum(1 for la in launches if any(e['k']=='dump' for e in la['evs'])))
# replay sanity per day + +1s tax ratio check
err_day=collections.defaultdict(list); tax_day=collections.defaultdict(list)
for la in launches:
    Q,T=Q0,T0
    for t in la['evs']:
        if t['k']=='buy':
            net=t['q']-t['fee']-t['ctax']
            if net>0 and t['tok']>0: err_day[la['day']].append(abs(T*net//(Q+net)-t['tok'])/t['tok'])
            Q+=net; T-=t['tok']
            if t['ts']==la['ts']+1 and t['stax']>0: tax_day[la['day']].append(t['stax']/t['q'])
        elif t['k']=='sell': T+=t['tok']; Q-=(t['q']+t['fee']+t['ctax'])
P('\n=== replay sanity per day: median tokensOut error | median snipe-tax ratio at +1 s (expect 0.0618) ===')
for d in sorted(err_day): P(f'  {d}: err {st.median(err_day[d]):.1e} (n={len(err_day[d])}) | tax {st.median(tax_day[d]) if tax_day[d] else float("nan"):.4f} (n={len(tax_day[d])})')
def fp(la):
    T=la['ts']; tr=[e for e in la['evs'] if e['k']!='dump']
    team=[t for t in tr if t['k']=='buy' and t['exempt'] and t['rec']!=la['dep'] and t['ts']==T]
    devb=[t for t in tr if t['k']=='buy' and t['rec']==la['dep'] and t['ts']==T]
    plus1=[t for t in tr if t['k']=='buy' and t['ts']==T+1]
    dumps=[e for e in la['evs'] if e['k']=='dump']
    return dict(team=len(team)>0,team_eth=sum(t['q'] for t in team)/ETH,team_n=len({t['rec'] for t in team}),dev=len(devb)>0,dev_eth=sum(t['q'] for t in devb)/ETH,n1=len(plus1),first_dump=(dumps[0]['ts']-T) if dumps else None)
for la in launches: la['fp']=fp(la)
def simulate(la,buy_eth,tp,trail,sl,timeout,pos='first',horizon=300,dump_exit=False):
    T0s=la['ts']; Q,T=Q0,T0; evs=la['evs']; ctax_bps=None
    for t in evs:
        if t['k']=='buy' and t['q']>0: ctax_bps=t['ctax']*10000//t['q']; break
    if ctax_bps is None: ctax_bps=100
    i=0
    def apply(t):
        nonlocal Q,T
        if t['k']=='buy': Q+=t['q']-t['fee']-t['ctax']; T-=t['tok']
        elif t['k']=='sell': T+=t['tok']; Q-=(t['q']+t['fee']+t['ctax'])
    cutoff=T0s if pos=='first' else T0s+1
    while i<len(evs) and evs[i]['ts']<=cutoff: apply(evs[i]); i+=1
    g=int(buy_eth*ETH); net=g*(10000-FEE-ctax_bps-618)//10000
    tok=T*net//(Q+net); Q+=net; T-=tok
    entry_px=Q/T; entry_ts=T0s+1; peak=entry_px; last_ts=entry_ts
    def liq(): return (Q*tok//(T+tok))*(10000-FEE-ctax_bps)/10000/ETH
    reason=None; val=None
    while i<len(evs):
        t=evs[i]
        if t['ts']-entry_ts>horizon: break
        if timeout and t['ts']-entry_ts>=timeout: reason='timeout'; val=liq(); break
        if t['k']=='dump':
            i+=1
            if dump_exit: reason='dump'; val=liq(); break
            continue
        apply(t); i+=1; last_ts=t['ts']
        px=Q/T; chg=(px/entry_px-1)*100; peak=max(peak,px)
        if trail and (peak/entry_px-1)*100>=trail[0] and (px/peak-1)*100<=-trail[1]: reason='trail'; val=liq(); break
        if tp and chg>=tp: reason='tp'; val=liq(); break
        if sl and chg<=-sl: reason='sl'; val=liq(); break
    if reason is None: reason='end'; val=liq()
    return val-buy_eth
BEST=dict(tp=None,trail=(50,20),sl=40,timeout=60,dump_exit=True)
VIDEO=dict(tp=150,trail=(100,25),sl=40,timeout=60)
segs={'all':lambda f:True,'team':lambda f:f['team'],'team>=0.1':lambda f:f['team'] and f['team_eth']>=0.1,'team>=0.2':lambda f:f['team'] and f['team_eth']>=0.2,'dev_only':lambda f:f['dev'] and not f['team'],'none':lambda f:not f['team'] and not f['dev']}
days=sorted({la['day'] for la in launches})
P('\n=== competition trend per day: launches | with >=1 taxed buy at +1 s | mean #buys at +1 s | team launches ===')
for d in days:
    sub=[la for la in launches if la['day']==d]
    P(f'  {d}: {len(sub):4d} | {sum(1 for la in sub if la["fp"]["n1"]>0):4d} | {st.mean(la["fp"]["n1"] for la in sub):.2f} | {sum(1 for la in sub if la["fp"]["team"]):3d}')
P('\n=== per-day PnL (ETH) at 0.07, best preset, first-in-block | last-in-block, by segment ===')
hdr='  day        '+' '.join(f'{k:>18s}' for k in segs); P(hdr)
tot=collections.defaultdict(lambda:[0,0,0])
for d in days:
    row=f'  {d} '
    for k,v in segs.items():
        sub=[la for la in launches if la['day']==d and v(la['fp'])]
        f=sum(simulate(la,0.07,**BEST) for la in sub); l=sum(simulate(la,0.07,pos='last',**BEST) for la in sub)
        tot[k][0]+=f; tot[k][1]+=l; tot[k][2]+=len(sub)
        row+=f'{f:+7.3f}/{l:+7.3f} n{len(sub):<3d}'
    P(row)
P('  TOTAL      '+' '.join(f'{tot[k][0]:+7.3f}/{tot[k][1]:+7.3f} n{tot[k][2]:<3d}' for k in segs))
P('\n=== threshold sensitivity (best preset, first): minTeamBuyEth ===')
for thr in (0.02,0.05,0.1,0.15,0.2,0.3,0.5):
    sub=[la for la in launches if la['fp']['team'] and la['fp']['team_eth']>=thr]
    if not sub: continue
    pn=[simulate(la,0.07,**BEST) for la in sub]; pl=[simulate(la,0.07,pos='last',**BEST) for la in sub]
    P(f'  >= {thr:4.2f}: n={len(sub):5d} ({len(sub)/len(days):.0f}/day) mean first {st.mean(pn):+.4f} last {st.mean(pl):+.4f} win {100*sum(1 for x in pn if x>0)/len(pn):.0f}% total first {sum(pn):+.2f} ETH')
P('\n=== dev-buy size sensitivity (no team), best preset, first ===')
for lo,hi in ((0,0.01),(0.01,0.05),(0.05,0.1),(0.1,0.3),(0.3,10)):
    sub=[la for la in launches if la['fp']['dev'] and not la['fp']['team'] and lo<=la['fp']['dev_eth']<hi]
    if len(sub)<20: continue
    pn=[simulate(la,0.07,**BEST) for la in sub]; P(f'  dev buy [{lo},{hi}): n={len(sub)} mean {st.mean(pn):+.4f} win {100*sum(1 for x in pn if x>0)/len(pn):.0f}%')
# weekly walk-forward on team segments with precomputed combos
grid=list(itertools.product([None,100,150,300],[None,(50,20),(100,25)],[None,40],[30,60],[False,True]))
P('\n=== weekly walk-forward (fit on all previous weeks, test next week) ===')
weeks=sorted({d[:4]+'-W'+str(time.strptime(d,'%Y-%m-%d').tm_yday//7) for d in days})
def wk(la): return la['day'][:4]+'-W'+str(time.strptime(la['day'],'%Y-%m-%d').tm_yday//7)
for seg in ('team','team>=0.1','team>=0.2'):
    sub=[la for la in launches if segs[seg](la['fp'])]
    pre={}
    for la in sub: pre[la['token']]={c:simulate(la,0.07,tp=c[0],trail=c[1],sl=c[2],timeout=c[3],dump_exit=c[4]) for c in grid}
    for w in weeks[1:]:
        fit=[la for la in sub if wk(la)<w]; test=[la for la in sub if wk(la)==w]
        if len(fit)<30 or len(test)<10: continue
        best=max(grid,key=lambda c: st.mean(pre[la['token']][c] for la in fit))
        fm=st.mean(pre[la['token']][best] for la in fit); tm=[pre[la['token']][best] for la in test]
        vb=[simulate(la,0.07,**VIDEO) for la in test]; bb=[pre[la['token']][(None,(50,20),40,60,True)] for la in test]
        P(f'  {seg:10s} week {w}: fit n={len(fit)} best={best} fitmean={fm:+.4f} -> test n={len(test)} mean {st.mean(tm):+.4f} total {sum(tm):+.3f} | fixed BEST {st.mean(bb):+.4f} | VIDEO {st.mean(vb):+.4f}')
# bootstrap losing-day probability per segment at 3 race win rates (whole month)
P('\n=== bootstrap daily PnL (best preset, 0.07) ===')
random.seed(11)
for seg in ('team>=0.1','team','team>=0.2'):
    sub=[la for la in launches if segs[seg](la['fp'])]
    first=[simulate(la,0.07,**BEST) for la in sub]; last=[simulate(la,0.07,pos='last',**BEST) for la in sub]
    n=max(1,int(round(len(sub)/len(days))))
    for wr in (1.0,0.75,0.5):
        tots=[]
        for _ in range(3000):
            s=0.0
            for _ in range(n):
                i=random.randrange(len(sub)); s+= first[i] if random.random()<wr else last[i]
            tots.append(s)
        tots.sort(); P(f'  {seg:10s} ~{n}/day race {wr:.0%}: P(losing day) {100*sum(1 for x in tots if x<0)/len(tots):.0f}%, median {tots[len(tots)//2]:+.3f}, p10 {tots[len(tots)//10]:+.3f}, p90 {tots[9*len(tots)//10]:+.3f}')
# operators
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
P('\n=== operators: clusters',len(cl),'sizes top',sizes[:15],'singletons',sum(1 for s in sizes if s==1))
rows=[]
for k,v in cl.items():
    if len(v)<10: continue
    pn=[simulate(la,0.07,**BEST) for la in v]; rows.append((len(v),sum(pn),100*sum(1 for x in pn if x>0)/len(pn),k,v))
rows.sort(key=lambda r:-r[1])
P('  top 12 by total PnL:')
for n,tot_,win,k,v in rows[:12]: P(f'    n={n:4d} total={tot_:+.3f} win={win:3.0f}% team={sum(1 for la in v if la["fp"]["team"])} days={len({la["day"] for la in v})} key={k[:16]}')
P('  worst 5:')
for n,tot_,win,k,v in rows[-5:]: P(f'    n={n:4d} total={tot_:+.3f} win={win:3.0f}% team={sum(1 for la in v if la["fp"]["team"])} key={k[:16]}')
P('\n=== operator selection weekly walk-forward (>=5 fit launches, fit total>0, win>=40%) ===')
for w in weeks[1:]:
    sel={k for k,v in cl.items() if len([la for la in v if wk(la)<w])>=5 and sum(simulate(la,0.07,**BEST) for la in v if wk(la)<w)>0 and 100*sum(1 for la in v if wk(la)<w and simulate(la,0.07,**BEST)>0)/len([la for la in v if wk(la)<w])>=40}
    test=[la for la in launches if la['cl'] in sel and wk(la)==w]
    if test:
        pn=[simulate(la,0.07,**BEST) for la in test]; P(f'  week {w}: operators={len(sel)} n={len(test)} mean {st.mean(pn):+.4f} total {sum(pn):+.3f} win {100*sum(1 for x in pn if x>0)/len(pn):.0f}%')
open('results_month.txt','w').write('\n'.join(out))
with open('per_launch_month.csv','w',newline='') as f:
    w=csv.writer(f); w.writerow(['token','curve','deployer','ts','day','team','team_eth','team_n','dev','dev_eth','n1','first_dump','pnl_best_first','pnl_best_last','cluster'])
    for la in launches: w.writerow([la['token'],la['curve'],la['dep'],la['ts'],la['day'],la['fp']['team'],round(la['fp']['team_eth'],4),la['fp']['team_n'],la['fp']['dev'],round(la['fp']['dev_eth'],4),la['fp']['n1'],la['fp']['first_dump'],round(simulate(la,0.07,**BEST),5),round(simulate(la,0.07,pos='last',**BEST),5),la['cl'][:20]])
print('DONE')
