"""Replay a UTC window straight from the chain: every ETH-pair launch whose launch second had team
buys >= MIN_TEAM from >= MIN_WALLETS exempt wallets, with the backtest rule and the live rule applied
first in the +1 s block (per block). Prints the second-by-second path of each one, marking our
contract's own buys/sells.

  RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/<key> python3 replay_window.py START_TS END_TS
"""
import json,os,sys,time,urllib.request,collections,statistics as st
URL=os.environ['RPC_URL']; ETH=10**18; Q0=1_680_000_000_000_000_000; T0=10**27; FEE=100
MIN=float(os.environ.get('MIN_TEAM','0.02')); MINW=int(os.environ.get('MIN_WALLETS','2')); BUY=float(os.environ.get('BUY','0.003')); CAP=4.2
def rpc(m,p):
    req=urllib.request.Request(URL,json.dumps({'jsonrpc':'2.0','id':1,'method':m,'params':p}).encode(),{'content-type':'application/json'})
    r=json.load(urllib.request.urlopen(req,timeout=120)); 
    if 'error' in r: raise Exception(r['error'])
    return r['result']
def batch(calls):
    body=[{'jsonrpc':'2.0','id':i,'method':m,'params':p} for i,(m,p) in enumerate(calls)]
    req=urllib.request.Request(URL,json.dumps(body).encode(),{'content-type':'application/json'})
    out=json.load(urllib.request.urlopen(req,timeout=180)); return {x['id']:x.get('result') for x in out}
F='0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'
T_LAUNCH='0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607'
T_BUY='0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455'; T_SELL='0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df'
T_STC='0x3bc39a5562b28f5fe8f36cecabfbaa12bb969acf05717994709225fc412a9934'; T_EX='0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7'
T_XFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
u=lambda x:int(x,16); a=lambda t:'0x'+t[-40:]
BTS={}
def ts_of(blocks):
    need=[b for b in set(blocks) if b not in BTS]
    for i in range(0,len(need),500):
        chunk=need[i:i+500]; res=batch([('eth_getBlockByNumber',[hex(b),False]) for b in chunk])
        for j,b in enumerate(chunk):
            r=res.get(j); 
            if r: BTS[b]=u(r['timestamp'])
    return BTS
def block_at(ts):  # binary search a block number by timestamp
    hi=u(rpc('eth_blockNumber',[])); lo=hi-3_000_000
    while lo<hi:
        mid=(lo+hi)//2; t=u(rpc('eth_getBlockByNumber',[hex(mid),False])['timestamp'])
        if t<ts: lo=mid+1
        else: hi=mid
    return lo
start_ts=int(sys.argv[1]); end_ts=int(sys.argv[2])
b0=block_at(start_ts); b1=block_at(end_ts); print(f'blocks {b0}..{b1} ({b1-b0})',flush=True)
L=[]
for x in range(b0,b1+1,20000):
    L+=rpc('eth_getLogs',[{'fromBlock':hex(x),'toBlock':hex(min(x+19999,b1)),'address':F,'topics':[T_LAUNCH]}])
print('launches',len(L),flush=True)
ts_of([u(l['blockNumber']) for l in L])
def simulate(la,buy_eth,trail,sl,timeout,dump_exit,horizon=300):
    T0s=la['ts']; Q,T=Q0,T0; evs=la['evs']; ctax_bps=None
    for t in evs:
        if t['k']=='buy' and t['q']>0: ctax_bps=t['ctax']*10000//t['q']; break
    if ctax_bps is None: ctax_bps=100
    i=0
    def apply(t):
        nonlocal Q,T
        if t['k']=='buy': Q+=t['q']-t['fee']-t['ctax']; T-=t['tok']
        elif t['k']=='sell': T+=t['tok']; Q-=(t['q']+t['fee']+t['ctax'])
    while i<len(evs) and evs[i]['ts']<=T0s: apply(evs[i]); i+=1
    mcap=(Q/T)*1e9/ETH*ETH/1e18*1e18/1e18  # price*1e9 supply in ETH
    mcap=(Q/ETH)/(T/ETH)*1e9 if T else 1e9
    if mcap>CAP: return dict(pnl=0,reason='mcap_cap',skip=True)
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
        if sl and chg<=-sl: reason='sl'; val=liq(); break
    if reason is None: reason='end'; val=liq()
    return dict(pnl=val-buy_eth,reason=reason,skip=False,peak=(peak/entry_px-1)*100)
US='0x476ffafaab21b6523d4701dd16748bfb1b5a4dc7'; HEAD=u(rpc('eth_blockNumber',[]))
for l in L:
    pair='0x'+l['data'][26:66]
    if pair!='0x0000000000000000000000000000000000000000': continue
    token=a(l['topics'][1]); curve=a(l['topics'][2]); dep=a(l['topics'][3]); blk=u(l['blockNumber']); ts=BTS[blk]
    es=rpc('eth_getLogs',[{'fromBlock':hex(blk),'toBlock':hex(min(blk+1200,HEAD)),'address':curve,'topics':[[T_BUY,T_SELL,T_STC,T_EX]]}])
    xs=rpc('eth_getLogs',[{'fromBlock':hex(blk),'toBlock':hex(min(blk+1200,HEAD)),'address':token,'topics':[T_XFER]}])
    ts_of([u(e['blockNumber']) for e in es]+[u(x['blockNumber']) for x in xs])
    exempt={dep}|{a(e['topics'][1]) for e in es if e['topics'][0]==T_EX}
    evs=[]
    for e in es:
        t0=e['topics'][0]; ets=BTS[u(e['blockNumber'])]
        if t0 in (T_BUY,T_SELL):
            d=e['data'][2:]; v=[u(d[i*64:(i+1)*64]) for i in range(4)]; rec=a(e['topics'][2])
            if t0==T_BUY: evs.append(dict(k='buy',ts=ets,blk=u(e['blockNumber']),li=u(e['logIndex']),rec=rec,q=v[0],tok=v[1],fee=v[2],ctax=v[3],exempt=rec in exempt))
            else: evs.append(dict(k='sell',ts=ets,blk=u(e['blockNumber']),li=u(e['logIndex']),rec=rec,tok=v[0],q=v[1],fee=v[2],ctax=v[3],exempt=rec in exempt))
    for x in xs:
        f=a(x['topics'][1]); t=a(x['topics'][2])
        if f in exempt and t!=curve and t!='0x0000000000000000000000000000000000000000':
            evs.append(dict(k='dump',ts=BTS[u(x['blockNumber'])],blk=u(x['blockNumber']),li=u(x['logIndex']),rec=f))
    evs.sort(key=lambda t:(t['blk'],t['li']))
    tb=[t for t in evs if t['k']=='buy' and t['exempt'] and t['rec']!=dep and t['ts']==ts]
    team=sum(t['q'] for t in tb)/ETH; wallets=len({t['rec'] for t in tb})
    if team<MIN or wallets<MINW: continue
    print(f"\n=== {time.strftime('%H:%M:%S',time.gmtime(ts))} launch {l['transactionHash'][:12]} token {token[:10]} team {team:.3f} by {wallets}, exempt {len(exempt)}")
    # replay the curve, printing every event in the first 75 s, marking ours
    Q,T=Q0,T0; ctax=None
    for t in evs:
        if t['k']=='buy' and t['q']>0: ctax=t['ctax']*10000//t['q']; break
    ctax=ctax or 100; ours=None
    for t in evs:
        if t['ts']-ts>75: break
        if t['k']=='dump': print(f"  +{t['ts']-ts:3d}s blk+{t['blk']-blk:3d} DUMP transfer-out by exempt {t['rec'][:10]}"); continue
        if t['k']=='buy': Q+=t['q']-t['fee']-t['ctax']; T-=t['tok']
        else: T+=t['tok']; Q-=(t['q']+t['fee']+t['ctax'])
        mine=t['rec']==US
        if mine and t['k']=='buy' and ours is None: ours=dict(cost=t['q'],tok=t['tok'])
        val=''
        if ours: val=f" | our value {((Q*ours['tok']//(T+ours['tok']))*(10000-FEE-ctax)/10000/ours['cost']-1)*100:+.1f}%"
        print(f"  +{t['ts']-ts:3d}s blk+{t['blk']-blk:3d} {t['k'].upper():4s} {t['q']/ETH:.4f} ETH {'EXEMPT' if t['exempt'] else '      '} {'<<< US' if mine else t['rec'][:10]}{val}")
    r=simulate(dict(ts=ts,evs=evs),0.002,(50,20),40,60,True)
    print(f"  backtest rule (SL 40 on price) at 0.002: {r['reason']} pnl {r['pnl']:+.5f} ETH ({r['pnl']/0.002*100:+.1f}%), peak {r.get('peak',0):+.0f}%")
    # live rule now: SL 20 on sell value vs cost, trailing 50/20 on the same figure, timeout 60, dump exit
    Q,T=Q0,T0; i=0
    def ap(t):
        global Q,T
        if t['k']=='buy': Q+=t['q']-t['fee']-t['ctax']; T-=t['tok']
        elif t['k']=='sell': T+=t['tok']; Q-=(t['q']+t['fee']+t['ctax'])
    while i<len(evs) and evs[i]['ts']<=ts: ap(evs[i]); i+=1
    if (Q/ETH)/(T/ETH)*1e9>CAP: print('  live rule: skipped by the mcap cap'); continue
    g=int(0.002*ETH); net=g*(10000-FEE-ctax-618)//10000; tok=T*net//(Q+net); Q+=net; T-=tok
    liq=lambda:(Q*tok//(T+tok))*(10000-FEE-ctax)/10000/ETH
    peak=-1e9; reason=None; v=liq(); low=0
    while i<len(evs):
        t=evs[i]; i+=1
        if t['ts']-(ts+1)>=60: reason='timeout'; break
        if t['k']=='dump': reason='dump'; v=liq(); break
        ap(t); v=liq(); chg=(v/0.002-1)*100; peak=max(peak,chg,0); low=min(low,chg)
        if peak>=50 and (1+chg/100)/(1+peak/100)-1<=-0.2: reason='trail'; break
        if chg<=-20: reason='sl'; break
    print(f"  LIVE rule (SL 20) at 0.002: {reason or 'end'} pnl {v-0.002:+.5f} ETH ({(v/0.002-1)*100:+.1f}%), peak {peak:+.0f}%, low {low:+.0f}%")
