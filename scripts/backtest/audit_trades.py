"""Replay every live run of the sniper from the chain and compare three results per trade: the
backtest rule first in block, the backtest rule at our real race position, and the live rule now at
our real position. Input: trades.json, a list of
[decided_at_utc, symbol, buy_eth, live_pnl_or_null, live_exit, launch_tx_prefix_or_null, block_offset, buys_ahead, status].

  RPC_URL=… python3 audit_trades.py trades.json > audit.log    # writes audit.json next to it
"""
import json,os,sys,time,calendar,collections
import os
src=open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'replay_window.py')).read()
exec(src.split('start_ts=int')[0])   # rpc, batch, ts_of, block_at, constants
US='0x476ffafaab21b6523d4701dd16748bfb1b5a4dc7'; CAP=4.2
T=json.load(open(sys.argv[1] if len(sys.argv)>1 else 'trades.json'))
def utc(s): return calendar.timegm(time.strptime(s,'%Y-%m-%d %H:%M:%S'))
cache={}
def events_for(curve,token,blk):
    es=rpc('eth_getLogs',[{'fromBlock':hex(blk),'toBlock':hex(blk+1200),'address':curve,'topics':[[T_BUY,T_SELL,T_STC,T_EX]]}])
    xs=rpc('eth_getLogs',[{'fromBlock':hex(blk),'toBlock':hex(blk+1200),'address':token,'topics':[T_XFER]}])
    ts_of([u(e['blockNumber']) for e in es]+[u(x['blockNumber']) for x in xs])
    return es,xs
def build(l):
    token=a(l["topics"][1]); curve=a(l["topics"][2]); dep=a(l["topics"][3]); blk=u(l["blockNumber"]); ts_of([blk]); ts=BTS[blk]
    es,xs=events_for(curve,token,blk)
    exempt={dep}|{a(e['topics'][1]) for e in es if e['topics'][0]==T_EX}
    evs=[]
    for e in es:
        t0=e['topics'][0]; ets=BTS[u(e['blockNumber'])]
        if t0 in (T_BUY,T_SELL):
            d=e['data'][2:]; v=[u(d[i*64:(i+1)*64]) for i in range(4)]; rec=a(e['topics'][2])
            if t0==T_BUY: evs.append(dict(k='buy',ts=ets,blk=u(e['blockNumber']),li=u(e['logIndex']),tx=e['transactionHash'],rec=rec,q=v[0],tok=v[1],fee=v[2],ctax=v[3],exempt=rec in exempt))
            else: evs.append(dict(k='sell',ts=ets,blk=u(e['blockNumber']),li=u(e['logIndex']),tx=e['transactionHash'],rec=rec,tok=v[0],q=v[1],fee=v[2],ctax=v[3],exempt=rec in exempt))
    for x in xs:
        f=a(x['topics'][1]); t=a(x['topics'][2])
        if f in exempt and t!=curve and t!='0x'+'0'*40:
            evs.append(dict(k='dump',ts=BTS[u(x['blockNumber'])],blk=u(x['blockNumber']),li=u(x['logIndex']),rec=f))
    evs.sort(key=lambda t:(t['blk'],t['li']))
    tb=[t for t in evs if t['k']=='buy' and t['exempt'] and t['rec']!=dep and t['ts']==ts]
    return dict(token=token,curve=curve,dep=dep,blk=blk,ts=ts,exempt=exempt-{dep},evs=evs,team=sum(t['q'] for t in tb)/ETH,wallets=len({t['rec'] for t in tb}))
def sim(la,buy_eth,ahead=0,sl=20,sl_mode='liq',trail=(50,20),timeout=60,dump_exit=True,lag_blocks=1):
    """Entry in the T+1 block after `ahead` other buys of that block (0 = first in block). Exits are
    evaluated once per BLOCK (after all its trades), and the sell lands `lag_blocks` later, at the
    reserves after that block's trades: what a bot that sees a block and then sends can get."""
    Q,T_=Q0,T0; evs=[e for e in la['evs'] if not (e['k'] in ('buy','sell') and e['rec']==US)]; ctax=None
    for t in evs:
        if t['k']=='buy' and t['q']>0: ctax=t['ctax']*10000//t['q']; break
    ctax=ctax or 100
    def ap(t):
        nonlocal Q,T_
        if t['k']=='buy': Q+=t['q']-t['fee']-t['ctax']; T_-=t['tok']
        elif t['k']=='sell': T_+=t['tok']; Q-=(t['q']+t['fee']+t['ctax'])
    i=0; T0s=la['ts']
    while i<len(evs) and evs[i]['ts']<=T0s: ap(evs[i]); i+=1
    n=0
    while n<ahead and i<len(evs) and evs[i]['ts']==T0s+1:
        if evs[i]['k']=='buy': n+=1
        ap(evs[i]); i+=1
    if (Q/ETH)/(T_/ETH)*1e9>CAP: return dict(pnl=0.0,reason='skip: mcap cap',low=0,peak=0)
    g=int(buy_eth*ETH); net=g*(10000-FEE-ctax-618)//10000; tok=T_*net//(Q+net); Q+=net; T_-=tok
    entry_px=Q/T_; entry_ts=T0s+1; entry_blk=la['blk']+1
    liq=lambda:(Q*tok//(T_+tok))*(10000-FEE-ctax)/10000/ETH
    peak=0.0; low=0.0; pk_px=entry_px; reason=None
    # group the remaining events by block
    blocks=collections.OrderedDict()
    for t in evs[i:]: blocks.setdefault(t['blk'],[]).append(t)
    blist=list(blocks.items()); exit_blk=None
    for bi,(b,ts_evs) in enumerate(blist):
        bts=ts_evs[0]['ts']
        if bts-entry_ts>=timeout: reason='timeout'; exit_blk=b; break   # the timer fires before this block
        dumped=False
        for t in ts_evs:
            if t['k']=='dump': dumped=True
            else: ap(t)
        v=liq()
        if sl_mode=='liq':
            chg=(v/buy_eth-1)*100; peak=max(peak,chg); low=min(low,chg)
            if dump_exit and dumped: reason='dump'
            elif peak>=trail[0] and (1+chg/100)/(1+peak/100)-1<=-trail[1]/100: reason='trail'
            elif sl and chg<=-sl: reason='sl'
        else:
            px=Q/T_; chg=(px/entry_px-1)*100; pk_px=max(pk_px,px); peak=max(peak,chg); low=min(low,chg)
            if dump_exit and dumped: reason='dump'
            elif (pk_px/entry_px-1)*100>=trail[0] and (px/pk_px-1)*100<=-trail[1]: reason='trail'
            elif sl and chg<=-sl: reason='sl'
        if reason:
            # the sell lands lag_blocks later: apply the trades of the next lag_blocks blocks first
            for b2,evs2 in blist[bi+1:bi+1+lag_blocks]:
                if b2-b<=lag_blocks+2:
                    for t in evs2:
                        if t['k']!='dump': ap(t)
            break
    v=liq()
    if reason is None: reason='timeout' if (blist and blist[-1][1][0]['ts']-entry_ts>=timeout) else 'end'
    return dict(pnl=v-buy_eth,reason=reason,low=low,peak=peak)
out=[]
for row in T:
    when,sym,buy,live,lexit,txp,off,ahead,st=row
    ts=utc(when)
    if txp in (None,'cooloff','dailyloss'):
        # find the launch by second (decided_at can be the second after the launch)
        b=block_at(ts); L=rpc('eth_getLogs',[{'fromBlock':hex(b-25),'toBlock':hex(b+15),'address':F,'topics':[T_LAUNCH]}])
        ts_of([u(l['blockNumber']) for l in L]); L=[l for l in L if BTS[u(l['blockNumber'])] in (ts,ts-1)]
        if txp is None and len(L)>1:
            # several launches that second: pick the one our contract bought
            L2=[]
            for l in L:
                la=build(l)
                if any(t['k']=='buy' and t['rec']==US for t in la['evs']): L2.append(l)
            L=L2 or L
    else:
        b=block_at(ts); L=rpc('eth_getLogs',[{'fromBlock':hex(b-15),'toBlock':hex(b+15),'address':F,'topics':[T_LAUNCH]}])
        L=[l for l in L if l['transactionHash'].startswith(txp)]
    if not L: out.append(dict(when=when,sym=sym,err='launch not found')); print('NOT FOUND',when,sym,flush=True); continue
    la=build(L[0])
    ours=[t for t in la['evs'] if t['k'] in('buy','sell') and t['rec']==US]
    ob=[t for t in ours if t['k']=='buy']; osl=[t for t in ours if t['k']=='sell']
    # was there an exempt transfer-out before our live sell? (if not, a live exempt_dump exit was on SELLS)
    first_dump=next((t['ts']-la['ts'] for t in la['evs'] if t['k']=='dump'),None)
    sell_at=(osl[0]['ts']-la['ts']) if osl else None
    bt=sim(la,buy,0,sl=40,sl_mode='price')            # the 30-day backtest rule, first in block
    bt_pos=sim(la,buy,ahead,sl=40,sl_mode='price') if off<=1 else dict(pnl=0.0,reason='no fill (deadline T+1)')   # backtest rule at our real race position
    fx=sim(la,buy,ahead,sl=20,sl_mode='liq') if off<=1 else dict(pnl=0.0,reason='no fill (deadline T+1)')  # live rules now (SL 20 on value), real race position
    out.append(dict(when=when,sym=sym,buy=buy,live=live,lexit=lexit,off=off,ahead=ahead,st=st,team=la['team'],wallets=la['wallets'],exempt=sorted(la['exempt']),
                    first_dump=first_dump,sell_at=sell_at,bt=bt,bt_pos=bt_pos,fx=fx,
                    our_buy_ts=(ob[0]['ts']-la['ts']) if ob else None))
    print(f"{when} {sym:11s} live {live} {lexit:11s} | bt first {bt['pnl']:+.5f} {bt['reason']:8s} | bt@pos {bt_pos['pnl']:+.5f} {bt_pos['reason']:8s} | fixed {fx['pnl']:+.5f} {fx['reason']:8s} | dump@{first_dump} sell@{sell_at} team {la['team']:.3f}/{la['wallets']}",flush=True)
json.dump(out,open(os.environ.get('OUT','audit.json'),'w'),indent=1)
print('DONE')
