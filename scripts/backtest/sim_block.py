"""Per-block backtest over the 30-day dataset (docs/BACKTEST.md #3; files from run_chain.sh / phase2.py).

Exits are evaluated once per BLOCK (after all its trades) and the sell lands one block later: what a
bot that sees a sealed block and then sends can get. The per-trade scripts (backtest.py, bt_month.py)
act inside blocks and overstate the edge ~5x (docs/BACKTEST.md, correction of 31 Oct 2026).

  python3 sim_block.py DATA_DIR band      # execution-model bounds for the live rule
  python3 sim_block.py DATA_DIR sizes     # buy-size sensitivity
  python3 sim_block.py DATA_DIR grid      # per-block walk-forward exit grid
  python3 sim_block.py DATA_DIR hours     # qualifying launches by hour of day and per day
"""
import sys
import json,collections,statistics as st,time,itertools
D=sys.argv[1] if len(sys.argv)>1 else '.'
CMD=sys.argv[2] if len(sys.argv)>2 else 'band'
ETH=10**18; Q0=1_680_000_000_000_000_000; T0=10**27; FEE=100; CAP=4.2
BTS={int(k):v for k,v in json.load(open(D+'/block_ts.json')).items()}
TR=json.load(open(D+'/transfers.json'))
T_BUY='0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455'; T_SELL='0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df'
T_STC='0x3bc39a5562b28f5fe8f36cecabfbaa12bb969acf05717994709225fc412a9934'; T_EX='0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7'
def u(x): return int(x,16)
def a(t): return '0x'+t[-40:]
L=[json.loads(l) for l in open(D+'/launches.jsonl')]
want={a(l['topics'][2]) for l in L if '0x'+l['data'][26:66]=='0x0000000000000000000000000000000000000000'}
by=collections.defaultdict(list)
for line in open(D+'/events.jsonl'):
    e=json.loads(line)
    if e['address'] in want: by[e['address']].append(e)
print('events loaded',flush=True)
launches=[]; tax2=[]
for l in L:
    if '0x'+l['data'][26:66]!='0x0000000000000000000000000000000000000000': continue
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
            if ets==ts+2 and s>0 and v[0]>0: tax2.append(s/v[0])
        else:
            evs.append(dict(k='sell',ts=ets,blk=b,li=u(e['logIndex']),rec=rec,tok=v[0],q=v[1],fee=v[2],ctax=v[3],stax=0,exempt=rec in exempt))
    for t in TR.get(token,[]):
        if t['f'] in exempt and t['t']!=curve and t['t']!='0x'+'0'*40 and BTS.get(t['b']):
            evs.append(dict(k='dump',ts=BTS[t['b']],blk=t['b'],li=t['li'],to=t['t']))
    evs.sort(key=lambda e:(e['blk'],e['li']))
    tb=[t for t in evs if t['k']=='buy' and t['exempt'] and t['rec']!=dep and t['ts']==ts]
    b1=[t for t in evs if t['k']=='buy' and t['ts']==ts+1]
    s1=[t for t in evs if t['k']=='sell' and t['ts']<=ts+1]
    dumps1=[t for t in evs if t['k']=='dump' and t['ts']<=ts+1]
    devb=[t for t in evs if t['k']=='buy' and t['rec']==dep and t['ts']==ts]
    launches.append(dict(ts=ts,blk=blk,evs=evs,day=time.strftime('%Y-%m-%d',time.gmtime(ts)),
        team=sum(t['q'] for t in tb)/ETH,wallets=len({t['rec'] for t in tb}),dev=sum(t['q'] for t in devb)/ETH,
        n1=len(b1),v1=sum(t['q'] for t in b1)/ETH,ex1=sum(1 for t in b1 if t['exempt']),sold1=len(s1)>0 or len(dumps1)>0))
launches.sort(key=lambda x:x['ts']); by=None
print('launches',len(launches),flush=True)
TAX2=round(st.median(tax2)*10000) if tax2 else 19   # snipe tax at +2 s (19 bps)
def sim(la,buy_eth,entry_sec,tax_bps,ahead=0,trail=(50,20),sl=40,timeout=60,dump_exit=True,dump_mode='block',lag='price',tp=None):
    Q,T_=Q0,T0; evs=la['evs']; ctax=None
    for t in evs:
        if t['k']=='buy' and t['q']>0: ctax=t['ctax']*10000//t['q']; break
    ctax=ctax or 100
    def ap(t):
        nonlocal Q,T_
        if t['k']=='buy': Q+=t['q']-t['fee']-t['ctax']; T_-=t['tok']
        elif t['k']=='sell': T_+=t['tok']; Q-=(t['q']+t['fee']+t['ctax'])
    i=0; T0s=la['ts']; cutoff=T0s+entry_sec-1
    while i<len(evs) and evs[i]['ts']<=cutoff: ap(evs[i]); i+=1
    n=0
    while n<ahead and i<len(evs) and evs[i]['ts']==T0s+entry_sec:
        if evs[i]['k']=='buy': n+=1
        ap(evs[i]); i+=1
    if (Q/ETH)/(T_/ETH)*1e9>CAP: return None
    g=int(buy_eth*ETH); net=g*(10000-FEE-ctax-tax_bps)//10000; tok=T_*net//(Q+net); Q+=net; T_-=tok
    entry_px=Q/T_; entry_ts=T0s+entry_sec; pk=entry_px
    liq=lambda:(Q*tok//(T_+tok))*(10000-FEE-ctax)/10000/ETH
    blocks=collections.OrderedDict()
    for t in evs[i:]: blocks.setdefault(t['blk'],[]).append(t)
    bl=list(blocks.items()); reason=None
    for bi,(b,be) in enumerate(bl):
        if be[0]['ts']-entry_ts>=timeout: reason='timeout'; break
        dumped=False
        for t in be:
            if t['k']=='dump':
                dumped=True
                if dump_exit and dump_mode=='event': reason='dump'; break   # sell at the transfer, before the rest of the block
            else: ap(t)
        if reason=='dump': break
        px=Q/T_; chg=(px/entry_px-1)*100; pk=max(pk,px)
        if dump_exit and dumped: reason='dump'
        elif trail and (pk/entry_px-1)*100>=trail[0] and (px/pk-1)*100<=-trail[1]: reason='trail'
        elif sl and chg<=-sl: reason='sl'
        elif tp and chg>=tp: reason='tp'
        if reason:
            if lag=='all' or (lag=='price' and reason!='dump'):
                for b2,be2 in bl[bi+1:bi+2]:
                    if b2-b<=2:   # the sell lands 1-2 blocks later: only trades in that window hit us
                        for t in be2:
                            if t['k']!='dump': ap(t)
            break
    return liq()-buy_eth
days=sorted({la['day'] for la in launches}); nd=len(days); last=days[-10:]
LIVE_MIN_TEAM=0.02; LIVE_MIN_WALLETS=2
live=lambda la:la['team']>=LIVE_MIN_TEAM and la['wallets']>=LIVE_MIN_WALLETS
lv=[la for la in launches if live(la)]
def tot(f,sub=lv):
    r=[f(la) for la in sub]; r=[x for x in r if x is not None]; return sum(r),len(r),(100*sum(1 for x in r if x>0)/len(r) if r else 0)
CUR=dict(trail=(50,20),sl=28,timeout=60,dump_exit=True)   # the live preset; SL 20 on sell value ≈ SL 28 on curve price
if CMD=='band':
    print('=== live rule, first in block, 0.07, current exits ===')
    for name,kw in (('per-block, no sell lag (optimistic)',dict(lag='none')),('per-block, 1-block lag on price exits (realistic)',dict(lag='price')),('per-block, 1-block lag on every exit (pessimistic)',dict(lag='all'))):
        t,n,w=tot(lambda la:sim(la,0.07,1,618,**CUR,**kw)); print(f'  {name:55s} {t:+7.2f} ETH  n={n}  win {w:.0f}%')
    t10=tot(lambda la:sim(la,0.07,1,618,**CUR),[la for la in lv if la['day'] in last])[0]; print(f'  last 10 days: {t10:+.2f} ETH')
elif CMD=='sizes':
    print(f'{"buy ETH":>8s} {"month":>9s} {"per trade":>10s} {"ROI/trade":>10s} {"win":>5s} {"last 10 days":>13s}')
    for b in (0.02,0.05,0.07,0.1,0.15,0.2,0.3,0.5,1.0):
        t,n,w=tot(lambda la:sim(la,b,1,618,**CUR)); t10=tot(lambda la:sim(la,b,1,618,**CUR),[la for la in lv if la['day'] in last])[0]
        print(f'{b:8.2f} {t:+9.2f} {t/n:+10.4f} {100*t/n/b:+9.2f}% {w:4.0f}% {t10:+13.2f}')
elif CMD=='grid':
    import itertools
    grid=list(itertools.product([None,30,50,100],[None,(20,10),(30,15),(50,20)],[10,20,28,40],[10,15,30,60],[True,False]))
    cut=int(len(lv)*0.6); IS,OOS=lv[:cut],lv[cut:]; res=[]
    for tp,trail,sl,to,de in grid:
        f=lambda la:sim(la,0.07,1,618,trail=trail,sl=sl,timeout=to,dump_exit=de,tp=tp); ti,ni,_=tot(f,IS); res.append((ti/ni,tp,trail,sl,to,de,f))
    res.sort(key=lambda x:-x[0])
    print('top 8 in-sample (first 60 %) with out-of-sample (last 40 %) and last-10-day results:')
    for m,tp,trail,sl,to,de,f in res[:8]:
        to_,no,wo=tot(f,OOS); tl=tot(f,[la for la in lv if la['day'] in last])[0]
        print(f'  tp={tp} trail={trail} sl={sl} timeout={to} dump={de}: IS {m:+.4f}/trade -> OOS {to_:+.2f} ETH ({to_/no:+.4f}/trade, win {wo:.0f}%)  last10d {tl:+.2f}')
    f=lambda la:sim(la,0.07,1,618,**CUR); ti,ni,_=tot(f,IS); to_,no,wo=tot(f,OOS); tl=tot(f,[la for la in lv if la['day'] in last])[0]
    print(f'  CURRENT preset: IS {ti/ni:+.4f}/trade  OOS {to_:+.2f} ETH ({to_/no:+.4f}/trade, win {wo:.0f}%)  last10d {tl:+.2f}')
elif CMD=='hours':
    h=collections.Counter(time.gmtime(la['ts']).tm_hour for la in lv); d=collections.Counter(la['day'] for la in lv)
    print('qualifying launches per hour of day (UTC), average per day:'); print(' '.join(f'{k:02d}:{h[k]/nd:4.1f}' for k in range(24)))
    print('per day:',' '.join(f'{k[5:]}:{d[k]}' for k in days))
