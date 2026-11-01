"""Entry-pause rules on the month, per block, live exits in the bot's units (1 Nov 2026).

Compares the live team-wallet cool-off alone with: a same-symbol block after a loss, a symbol block
only after a quick team dump, and a global pause after N losses in a row. Day-by-day differences
against the baseline, per half and per week, so a rule that only helps one stretch shows it.

  RPC_URL=https://rpc-robinhood.globalstake.io python3 pause_rules.py DATA_DIR

DATA_DIR: the month files (block_ts.json, transfers.json, launches.jsonl, events.jsonl). Symbols are
fetched with eth_call symbol() and cached in DATA_DIR/symbols.json. ~6 min, ~4 GB RAM.
"""
import os,sys,json,math,time,collections,statistics as st,urllib.request
D=sys.argv[1]; R=os.environ.get('RPC_URL','https://rpc-robinhood.globalstake.io')
src=open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'sim_block.py')).read()
src=src[src.index('import json'):src.index('TAX2=')]
src=src.replace("launches.append(dict(ts=ts,blk=blk,","launches.append(dict(token=token,dep=dep,teamw=sorted({t['rec'] for t in tb}),ts=ts,blk=blk,")
sys.argv=['x',D,'none']; g={'sys':sys,'__name__':'x'}; exec(src,g)
lv=[la for la in g['launches'] if la['team']>=0.02 and la['wallets']>=2]
cache=os.path.join(D,'symbols.json'); syms=json.load(open(cache)) if os.path.exists(cache) else {}
def batch(calls):
    body=[{'jsonrpc':'2.0','id':i,'method':m,'params':p} for i,(m,p) in enumerate(calls)]
    q=urllib.request.Request(R,json.dumps(body).encode(),{'content-type':'application/json','user-agent':'curl/8'})
    return {x['id']:x.get('result') for x in json.load(urllib.request.urlopen(q,timeout=120))}
def dec(r):
    try: b=bytes.fromhex(r[2:]); n=int.from_bytes(b[32:64],'big'); return b[64:64+n].decode(errors='replace')
    except Exception: return ''
need=[la['token'] for la in lv if la['token'] not in syms]
for i in range(0,len(need),200):
    ch=need[i:i+200]; res=batch([('eth_call',[{'to':t,'data':'0x95d89b41'},'latest']) for t in ch])
    for j,t in enumerate(ch): syms[t]=dec(res.get(j) or '0x')
json.dump(syms,open(cache,'w'))
for la in lv: la['sym']=syms.get(la['token'],'')
ETH=10**18; Q0=1_680_000_000_000_000_000; T0=10**27; FEE=100; CAP=4.2; BUY=0.002
lv.sort(key=lambda x:x['ts'])
def sim(la,arm=20,drop=15,sl=20,timeout=60):
    """entry first in the T+1 block at 6.18 % tax; after each sealed block: dump (exempt transfer-out) / trailing on
    sell value (arm, drop) / stop on sell value / timeout; the sell lands in the next block (its trades hit us)."""
    Q,T=Q0,T0; evs=la['evs']; ctax=None
    for t in evs:
        if t['k']=='buy' and t['q']>0: ctax=t['ctax']*10000//t['q']; break
    ctax=ctax or 100
    def ap(t):
        nonlocal Q,T
        if t['k']=='buy': Q+=t['q']-t['fee']-t['ctax']; T-=t['tok']
        elif t['k']=='sell': T+=t['tok']; Q-=(t['q']+t['fee']+t['ctax'])
    i=0; T0s=la['ts']
    while i<len(evs) and evs[i]['ts']<=T0s: ap(evs[i]); i+=1
    if (Q/T)*1e9>CAP: return None
    g=int(BUY*ETH); net=g*(10000-FEE-ctax-618)//10000; tok=T*net//(Q+net); Q+=net; T-=tok
    val=lambda:(Q*tok//(T+tok))*(10000-FEE-ctax)/10000/ETH
    blocks=collections.OrderedDict()
    for t in evs[i:]: blocks.setdefault(t['blk'],[]).append(t)
    bl=list(blocks.items()); peak=0.0; entry=T0s+1; la['_exit']='timeout'; la['_held']=60
    for bi,(b,be) in enumerate(bl):
        if be[0]['ts']-entry>=timeout: break
        dumped=False
        for t in be:
            if t['k']=='dump': dumped=True
            else: ap(t)
        chg=(val()/BUY-1)*100; peak=max(peak,chg)
        hit=dumped or (peak>=arm and (1+chg/100)/(1+peak/100)-1<=-drop/100) or chg<=-sl
        if hit:
            la['_exit']=('dump' if dumped else 'other'); la['_held']=be[0]['ts']-entry
            for b2,be2 in bl[bi+1:bi+2]:
                if b2-b<=2:
                    for t in be2:
                        if t['k']!='dump': ap(t)
            break
    return val()-BUY
for la in lv: la['pnl']=sim(la)
lv=[la for la in lv if la['pnl'] is not None]
days=sorted({la['day'] for la in lv}); cnt=collections.Counter(la['day'] for la in lv)
med=st.median(cnt.values()); low={d for d in days if cnt[d]<=med}; high=set(days)-low
def norm(s): return ''.join(ch for ch in (s or '').upper() if ch.isalnum())

def perday(p):
    taken=[]; lossAtW={}; symUntil={}; streak=0; pauseUntil=0; dumpStreak=collections.Counter()
    for la in lv:
        ts=la['ts']; s=norm(la['sym'])
        if any(lossAtW.get(w,0)>ts for w in la['teamw']): continue
        if ts<pauseUntil: continue
        if p.get('qd') and s and symUntil.get(s,0)>ts: continue
        taken.append(la); x=la['pnl']; end=ts+61
        quick=x<0 and (p.get('anyloss') or (la['_exit']=='dump' and la['_held']<=p.get('within',10)))
        if s:
            if quick: dumpStreak[s]+=1
            else: dumpStreak[s]=0
            if quick and dumpStreak[s]>=p.get('k',1) and p.get('qd'): symUntil[s]=ts+1+la['_held']+p['qd']*60
        if x<0:
            for w in la['teamw']: lossAtW[w]=end+300
            streak+=1
            if p.get('N') and streak>=p['N']: pauseUntil=end+p['M']*60; streak=0
        else: streak=0
    d=collections.defaultdict(float); n=0
    for l in taken: d[l['day']]+=l['pnl']*0.1/BUY; n+=1
    return d,n
base,nb=perday({}); half=len(days)//2
ex=collections.Counter((l['_exit'],l['_held']<=10) for l in lv if l['pnl']<0)
print('losses by exit kind (kind, within 10 s):',dict(ex))
C=[('pause 10 after 4 (live from 1 Nov)',{'N':4,'M':10}),('pause 30 after 4',{'N':4,'M':30}),('pause 30 after 5',{'N':5,'M':30}),('pause 60 after 3',{'N':3,'M':60}),
   ('pause 10 after 2',{'N':2,'M':10}),('pause 30 after 2',{'N':2,'M':30}),
   ('symbol block 10 min after any loss',{'qd':10,'anyloss':1}),('symbol block 30 min after any loss',{'qd':30,'anyloss':1}),
   ('quick-dump symbol block 30 min',{'qd':30}),('quick-dump symbol block 60 min',{'qd':60}),('quick-dump symbol block 120 min',{'qd':120}),
   ('quick-dump x2 symbol block 60 min',{'qd':60,'k':2}),('quick-dump(<=5s) symbol block 60 min',{'qd':60,'within':5}),
   ('quick-dump 60 + pause 10 after 4',{'qd':60,'N':4,'M':10}),('quick-dump 30 + pause 10 after 4',{'qd':30,'N':4,'M':10})]
print(f"{'variant':38s} {'trades':>6s} {'month':>8s} {'vs base/day':>11s} {'t':>5s} {'days +/-':>8s} {'1st half':>9s} {'2nd half':>9s}  weeks (diff)")
print(f"{'baseline (live now)':38s} {nb:6d} {sum(base.values()):+8.3f}")
for name,p in C:
    d,n=perday(p); diff=[d[x]-base[x] for x in days]; m=sum(diff)/len(diff); sd=math.sqrt(sum((v-m)**2 for v in diff)/(len(diff)-1)); t=m/(sd/math.sqrt(len(diff))) if sd else 0
    wk=[sum(diff[i:i+7]) for i in range(0,len(diff),7)]
    lo=sum(d[x] for x in low)/len(low); hi=sum(d[x] for x in high)/len(high)
    print(f"{name:38s} {n:6d} {sum(d.values()):+8.3f} {m:+11.4f} {t:+5.2f} {sum(1 for v in diff if v>1e-9):3d}/{sum(1 for v in diff if v<-1e-9):2d} {sum(diff[:half]):+9.3f} {sum(diff[half:]):+9.3f}  {' '.join(f'{w:+.2f}' for w in wk)}  low {lo:+.3f}/d high {hi:+.3f}/d")

