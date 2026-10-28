import json,subprocess,time,collections,sys
RPC='https://rpc.mainnet.chain.robinhood.com'
T_EX='0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7'; T_TR='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
def post(body,tries=8):
    for i in range(tries):
        r=subprocess.run(['curl','-sS','-m','60','-w','\n%{http_code}',RPC,'-H','content-type: application/json','-d',json.dumps(body)],capture_output=True,text=True)
        out,_,code=r.stdout.rpartition('\n')
        if code!='200':
            print('http',code,'attempt',i,flush=True); time.sleep(1.5*(i+1)); continue
        try:
            d=json.loads(out)
            if isinstance(d,dict) and 'error' in d: print('rpc err',str(d['error'])[:80],flush=True); time.sleep(1.5*(i+1)); continue
            return d
        except Exception as e: print('parse err',str(e)[:60],flush=True); time.sleep(1.5*(i+1))
    return None
L=json.load(open('launches.json')); print('launches',len(L),flush=True)
lb={}; 
for l in L: lb['0x'+l['topics'][2][-40:]]=int(l['blockNumber'],16)
need=set(lb.values())
exby=collections.defaultdict(set)
with open('events.jsonl') as f:
    for line in f:
        e=json.loads(line); c=e['address']
        if c not in lb: continue
        b=int(e['blockNumber'],16)
        if b<=lb[c]+1500: need.add(b)
        if e['topics'][0]==T_EX: exby[c].add('0x'+e['topics'][1][-40:])
print('blocks needed',len(need),flush=True)
try: ts={int(k):v for k,v in json.load(open('block_ts.json')).items()}
except Exception: ts={}
todo=sorted(b for b in need if b not in ts); print('ts to fetch',len(todo),flush=True)
for i in range(0,len(todo),50):
    chunk=todo[i:i+50]
    d=post([{'jsonrpc':'2.0','id':j,'method':'eth_getBlockByNumber','params':[hex(b),False]} for j,b in enumerate(chunk)])
    if isinstance(d,list):
        for x in d:
            if x.get('result'): ts[chunk[x['id']]]=int(x['result']['timestamp'],16)
    time.sleep(0.3)
    if (i//50)%20==0: print('ts progress',i,len(ts),flush=True); json.dump(ts,open('block_ts.json','w'))
json.dump(ts,open('block_ts.json','w')); print('ts done',len(ts),flush=True)
# transfers for tokens whose curve has non-deployer exempt wallets (team candidates): batch getLogs 20 per request
tok_of={('0x'+l['topics'][2][-40:]):('0x'+l['topics'][1][-40:]) for l in L}
dep_of={('0x'+l['topics'][2][-40:]):('0x'+l['topics'][3][-40:]) for l in L}
targets=[(c,tok_of[c],lb[c]) for c in lb if len(exby.get(c,set())-{dep_of[c]})>0]
print('tokens with team exemptions',len(targets),flush=True)
try: transfers=json.load(open('transfers.json'))
except Exception: transfers={}
todo=[t for t in targets if t[1] not in transfers]
for i in range(0,len(todo),20):
    chunk=todo[i:i+20]
    d=post([{'jsonrpc':'2.0','id':j,'method':'eth_getLogs','params':[{'fromBlock':hex(b),'toBlock':hex(b+1500),'address':tok,'topics':[T_TR]}]} for j,(c,tok,b) in enumerate(chunk)])
    if isinstance(d,list):
        for x in d:
            if 'result' in x and isinstance(x['result'],list): transfers[chunk[x['id']][1]]=[{'b':int(l['blockNumber'],16),'li':int(l['logIndex'],16),'f':'0x'+l['topics'][1][-40:],'t':'0x'+l['topics'][2][-40:],'v':int(l['data'][2:66],16)} for l in x['result']]
    time.sleep(0.2)
    if (i//20)%20==0: print('transfers progress',i,len(transfers),flush=True); json.dump(transfers,open('transfers.json','w'))
json.dump(transfers,open('transfers.json','w')); print('transfers done',len(transfers),flush=True)
# blocks of transfers need timestamps too (exempt outflows)
need2=set()
for tok,tl in transfers.items():
    for t in tl: need2.add(t['b'])
todo=sorted(b for b in need2 if b not in ts); print('extra ts for transfer blocks',len(todo),flush=True)
for i in range(0,len(todo),100):
    chunk=todo[i:i+100]
    d=post([{'jsonrpc':'2.0','id':j,'method':'eth_getBlockByNumber','params':[hex(b),False]} for j,b in enumerate(chunk)])
    if isinstance(d,list):
        for x in d:
            if x.get('result'): ts[chunk[x['id']]]=int(x['result']['timestamp'],16)
    time.sleep(0.15)
json.dump(ts,open('block_ts.json','w')); print('ALL FETCH DONE',len(ts),flush=True)
