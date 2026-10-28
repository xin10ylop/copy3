import json,subprocess,time,sys,os
RPC='https://rpc.mainnet.chain.robinhood.com'
def rpc(m,p,tries=8):
    for i in range(tries):
        r=subprocess.run(['curl','-sS','-m','120',RPC,'-H','content-type: application/json','-d',json.dumps({'jsonrpc':'2.0','id':1,'method':m,'params':p})],capture_output=True,text=True)
        try: d=json.loads(r.stdout)
        except Exception: d={'error':{'message':r.stdout[:200]}}
        if 'error' in d:
            msg=str(d['error']); 
            if '429' in msg or 'Too Many' in msg or 'timeout' in msg.lower(): time.sleep(2*(i+1)); continue
            return ('ERR',msg)
        time.sleep(0.15); return d['result']
    return ('ERR','retries')
F='0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'
T_LAUNCH='0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607'
T_BUY='0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455'
T_SELL='0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df'
T_STC='0x3bc39a5562b28f5fe8f36cecabfbaa12bb969acf05717994709225fc412a9934'
T_EX='0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7'
latest=int(rpc('eth_blockNumber',[]),16)
SPAN=int(sys.argv[1]) if len(sys.argv)>1 else 300000
start=latest-SPAN
print('latest',latest,'range',start,latest,flush=True)
# 1. fresh curve params: newest launch
ll=rpc('eth_getLogs',[{'fromBlock':hex(latest-3000),'toBlock':hex(latest),'address':F,'topics':[T_LAUNCH]}])
if isinstance(ll,list) and ll:
    l=ll[-1]; curve='0x'+l['topics'][2][-40:]
    def call(d): r=rpc('eth_call',[{'to':curve,'data':d},'latest']); return int(r,16) if isinstance(r,str) else None
    params={'curve':curve,'phantomQuote':call('0xc57eadfc'),'quoteReserve':call('0x9da771f4'),'tokenReserve':call('0xcbcb3171'),'realQuoteReserve':call('0x4f1f58fd'),'feeBps':call('0x24a9d853'),'creatorTaxBps':call('0xc1bb8901'),'maxImpactBps':call('0x90addc1e'),'launchSupply':call('0x3f7ed6b7'),'sellable':call('0x808bcddc'),'reserved':call('0x15a55347'),'gradThr':call('0x8b0bc501'),'launchedAt':call('0xbf56b371')}
    json.dump(params,open('curve_params.json','w'),indent=1); print('fresh curve params',params,flush=True)
# 2. launches
launches=[]
for a in range(start,latest+1,20000):
    b=min(a+19999,latest); r=rpc('eth_getLogs',[{'fromBlock':hex(a),'toBlock':hex(b),'address':F,'topics':[T_LAUNCH]}])
    if isinstance(r,tuple): print('launch chunk err',a,r,flush=True); continue
    launches+=r
json.dump(launches,open('launches.json','w')); print('launches',len(launches),flush=True)
# 3. curve events by topic, adaptive chunking
chunk=4000; a=start; n=0; out=open('events.jsonl','w')
while a<=latest:
    b=min(a+chunk-1,latest)
    r=rpc('eth_getLogs',[{'fromBlock':hex(a),'toBlock':hex(b),'topics':[[T_BUY,T_SELL,T_STC,T_EX]]}])
    if isinstance(r,tuple):
        if chunk>250: chunk//=2; print('shrink chunk',chunk,r[1][:80],flush=True); continue
        print('chunk err',a,r,flush=True); a=b+1; continue
    for l in r: out.write(json.dumps(l)+'\n')
    n+=len(r); a=b+1
    if len(r)<1500 and chunk<20000: chunk=int(chunk*1.5)
    print(f'{a}/{latest} events {n} chunk {chunk}',flush=True)
out.close(); print('DONE events',n,flush=True)
