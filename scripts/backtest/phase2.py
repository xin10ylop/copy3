"""Merge worker output, then fetch block timestamps and exempt-wallet transfers with N parallel subprocesses."""
import json,subprocess,time,os,sys,collections
RPC='https://rpc.mainnet.chain.robinhood.com'
T_EX='0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7'; T_TR='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
mode=sys.argv[1]
def post(body,tries=12):
    for i in range(tries):
        r=subprocess.run(['curl','-sS','-m','240','-w','\n%{http_code}',RPC,'-H','content-type: application/json','-d',json.dumps(body)],capture_output=True,text=True)
        out,_,code=r.stdout.rpartition('\n')
        if code!='200': time.sleep(min(60,3*(i+1))); continue
        try:
            d=json.loads(out)
            if isinstance(d,dict) and 'error' in d: time.sleep(min(60,3*(i+1))); continue
            return d
        except Exception: time.sleep(3*(i+1))
    return None
if mode=='prepare':
    lb={}; tok={}; dep={}
    with open('launches.jsonl','w') as out:
        for i in range(4):
            for line in open(f'launches_w{i}.jsonl'):
                l=json.loads(line); c='0x'+l['topics'][2][-40:]
                if c in lb: continue
                lb[c]=int(l['blockNumber'],16); tok[c]='0x'+l['topics'][1][-40:]; dep[c]='0x'+l['topics'][3][-40:]; out.write(line)
    need=set(lb.values()); exby=collections.defaultdict(set); n=0
    with open('events.jsonl','w') as out:
        for i in range(4):
            for line in open(f'events_w{i}.jsonl'):
                e=json.loads(line); c=e['address']
                if c not in lb: continue
                b=int(e['blockNumber'],16)
                if b>lb[c]+1500: continue
                out.write(line); n+=1; need.add(b)
                if e['topics'][0]==T_EX: exby[c].add('0x'+e['topics'][1][-40:])
    targets=[[c,tok[c],lb[c]] for c in lb if len(exby.get(c,set())-{dep[c]})>0]
    json.dump(sorted(need),open('need.json','w')); json.dump(targets,open('targets.json','w'))
    print('launches',len(lb),'events kept',n,'blocks needed',len(need),'transfer targets',len(targets),flush=True)
elif mode=='ts':
    wid,nw=int(sys.argv[2]),int(sys.argv[3]); need=json.load(open('need.json'))[wid::nw]
    fn=f'block_ts_{wid}.json'; ts=json.load(open(fn)) if os.path.exists(fn) else {}
    todo=[b for b in need if str(b) not in ts]; bs=100; i=0; last=time.time(); t0=time.time()
    while i<len(todo):
        chunk=todo[i:i+bs]
        d=post([{'jsonrpc':'2.0','id':j,'method':'eth_getBlockByNumber','params':[hex(b),False]} for j,b in enumerate(chunk)])
        if isinstance(d,list):
            for x in d:
                if x.get('result'): ts[str(chunk[x['id']])]=int(x['result']['timestamp'],16)
            i+=bs
        else: bs=max(25,bs//2); time.sleep(5)
        if time.time()-last>60: json.dump(ts,open(fn,'w')); last=time.time(); print(f'ts{wid} {i}/{len(todo)} bs={bs} {(time.time()-t0)/max(1,i)*1000:.2f}s/1000blk',flush=True)
        time.sleep(0.1)
    json.dump(ts,open(fn,'w')); print(f'ts{wid} done',len(ts),flush=True)
elif mode=='tr':
    wid,nw=int(sys.argv[2]),int(sys.argv[3]); targets=json.load(open('targets.json'))[wid::nw]
    fn=f'transfers_{wid}.json'; tr=json.load(open(fn)) if os.path.exists(fn) else {}
    todo=[t for t in targets if t[1] not in tr]; i=0; last=time.time()
    while i<len(todo):
        chunk=todo[i:i+20]
        d=post([{'jsonrpc':'2.0','id':j,'method':'eth_getLogs','params':[{'fromBlock':hex(b),'toBlock':hex(b+1500),'address':tok,'topics':[T_TR]}]} for j,(c,tok,b) in enumerate(chunk)])
        if isinstance(d,list):
            for x in d:
                if 'result' in x and isinstance(x['result'],list):
                    tr[chunk[x['id']][1]]=[{'b':int(l['blockNumber'],16),'li':int(l['logIndex'],16),'f':'0x'+l['topics'][1][-40:],'t':'0x'+l['topics'][2][-40:],'v':int(l['data'][2:66],16)} for l in x['result']]
            i+=20
        else: time.sleep(5)
        if time.time()-last>60: json.dump(tr,open(fn,'w')); last=time.time(); print(f'tr{wid} {i}/{len(todo)}',flush=True)
        time.sleep(0.1)
    json.dump(tr,open(fn,'w')); print(f'tr{wid} done',len(tr),flush=True)
elif mode=='merge':
    ts={}; tr={}
    for i in range(4):
        ts.update(json.load(open(f'block_ts_{i}.json'))); tr.update(json.load(open(f'transfers_{i}.json')))
    extra=sorted({t['b'] for tl in tr.values() for t in tl if str(t['b']) not in ts})
    print('merged ts',len(ts),'transfers',len(tr),'extra ts',len(extra),flush=True)
    for i in range(0,len(extra),100):
        chunk=extra[i:i+100]
        d=post([{'jsonrpc':'2.0','id':j,'method':'eth_getBlockByNumber','params':[hex(b),False]} for j,b in enumerate(chunk)])
        if isinstance(d,list):
            for x in d:
                if x.get('result'): ts[str(chunk[x['id']])]=int(x['result']['timestamp'],16)
        time.sleep(0.1)
    json.dump(ts,open('block_ts.json','w')); json.dump(tr,open('transfers.json','w')); print('MERGE DONE',len(ts),flush=True)
