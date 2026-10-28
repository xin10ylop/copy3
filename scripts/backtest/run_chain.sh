#!/bin/bash
cd "$(dirname "$0")"
# wait for the 4 range workers
until [ "$(for i in 0 1 2 3; do python3 -c "import json;print(json.load(open('state_w$i.json')).get('done',False))" 2>/dev/null; done | grep -c True)" = "4" ]; do sleep 30; done
echo "workers done $(date)"
python3 phase2.py prepare
for i in 0 1 2 3; do (python3 phase2.py ts $i 4 > ts_$i.log 2>&1 &); done
until [ "$(for i in 0 1 2 3; do grep -c 'done' ts_$i.log 2>/dev/null; done | grep -c 1)" = "4" ]; do sleep 30; done
echo "timestamps done $(date)"
for i in 0 1 2 3; do (python3 phase2.py tr $i 4 > tr_$i.log 2>&1 &); done
until [ "$(for i in 0 1 2 3; do grep -c 'done' tr_$i.log 2>/dev/null; done | grep -c 1)" = "4" ]; do sleep 30; done
echo "transfers done $(date)"
python3 phase2.py merge
echo "CHAIN DONE $(date)"
