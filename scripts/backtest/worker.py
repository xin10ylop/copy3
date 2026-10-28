import json,subprocess,time,os,sys
RPC='https://rpc.mainnet.chain.robinhood.com'
F='0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'
T_LAUNCH='0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607'
TOPICS=['0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455','0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df','0x3bc39a5562b28f5fe8f36cecabfbaa12bb969acf05717994709225fc412a9934','0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7']
wid,start,end=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
def post(body,tries=12):
    for i in range(tries):
        r=subprocess.run(['curl','-sS','-m','240','-w','\n%{http_code}',RPC,'-H','content-type: application/json','-d',json.dumps(body)],capture_output=True,text=True)
        out,_,code=r.stdout.rpartition('\n')
        if code!='200': time.sleep(min(60,3*(i+1))); continue
        try:
            d=json.loads(out)
            if isinstance(d,dict) and 'error' in d:
                if 'Too Many' in str(d['error']) or '429' in str(d['error']): time.sleep(min(60,3*(i+1))); continue
                return ('ERR',d['error'])
            return d['result']
        except Exception: time.sleep(3*(i+1))
    return None
sp=f'state_{wid}.json'; st=json.load(open(sp)) if os.path.exists(sp) else {'lpos':start,'epos':start,'chunk':10000,'n':0}
def save(): json.dump(st,open(sp,'w'))
lo=open(f'launches_{wid}.jsonl','a')
while st['lpos']<=end:
    a=st['lpos']; b=min(a+19999,end); r=post({'jsonrpc':'2.0','id':1,'method':'eth_getLogs','params':[{'fromBlock':hex(a),'toBlock':hex(b),'address':F,'topics':[T_LAUNCH]}]})
    if r is None or isinstance(r,tuple): time.sleep(5); continue
    for l in r: lo.write(json.dumps(l)+'\n')
    lo.flush(); st['lpos']=b+1; save()
lo.close(); print(wid,'launches done',flush=True)
eo=open(f'events_{wid}.jsonl','a'); t0=time.time(); calls=0
while st['epos']<=end:
    a=st['epos']; chunk=st['chunk']; b=min(a+chunk-1,end)
    r=post({'jsonrpc':'2.0','id':1,'method':'eth_getLogs','params':[{'fromBlock':hex(a),'toBlock':hex(b),'topics':[TOPICS]}]})
    if r is None or isinstance(r,tuple):
        if chunk>500: st['chunk']=chunk//2; save(); continue
        time.sleep(10); continue
    for l in r: eo.write(json.dumps(l)+'\n')
    eo.flush(); st['n']+=len(r); st['epos']=b+1; calls+=1
    if len(r)<1500 and chunk<20000: st['chunk']=int(chunk*1.5)
    save()
    if calls%25==0: print(f'{wid} events {st["epos"]-start}/{end-start} n={st["n"]} chunk={st["chunk"]} {(time.time()-t0)/calls:.1f}s/call',flush=True)
eo.close(); st['done']=True; save(); print(wid,'events done',st['n'],flush=True)
