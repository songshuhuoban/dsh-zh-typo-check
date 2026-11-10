"""Fixed ELECTRA trial adding real-IME output annotations (SIM-1037).

120 is insufficient alone: reuse round-2 TRAIN/CAL with disjoint IME data.
67 eligible unique IME TRAIN examples are repeated 4x (not new samples).
Only CAL chooses the native INT8 epoch/cutoff; new IME TEST is opened once.
Earlier opened test sets are explicitly known regression, never fresh gold.
"""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import random
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT/'.research/semantic-round3'
PREVIOUS = ROOT/'.research/semantic-round2'
SEED = 20261110
REPEAT = 4
spec = importlib.util.spec_from_file_location('round2_helpers', ROOT/'tools/semantic-round2.py')
r2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r2)
r2.WORK = WORK


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rows_hash(rows):
    return r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True))


def verify_frozen(data, manifest):
    for name, rows in data.items():
        assert rows_hash(rows) == manifest['split_hashes'][name], f'Changed {name}'


def prepare():
    if (WORK/'prepared.json').exists():
        raise FileExistsError('Keep this fixed trial; use a new round for changed inputs')
    old = read(PREVIOUS/'prepared.json')
    old_manifest = read(PREVIOUS/'manifest.json')
    for split, expected in old_manifest['split_hashes'].items():
        assert rows_hash(old[split]) == expected
    ime_file = ROOT/'data/ime-keyboard/annotated-001.json'
    ime = read(ime_file)
    assert len(ime['rows']) == 120 and ime['pending_count'] == 0
    raw_file = ROOT/'data/ime-keyboard/notepad-batch-001.jsonl'
    assert sha(raw_file) == ime['source_hashes']['raw_capture']
    assert sha(ROOT/'data/ime-keyboard/assistant-labels-001.json') == ime['source_hashes']['decisions']
    converted = {'train':[],'cal':[],'test':[]}
    excluded = []
    for row in ime['rows']:
        item = {'text':row['text'],'label':row['label'],
                'category':['ime-normal','ime-noise','ime-context'][row['label']],
                'source':'physical-keyboard-doubao-001','group':row['id'],
                'confidence':row['confidence'], 'weight':.5 if row['label']==2 else 1.}
        assert not row['pending_composition_detected']
        if row['split']=='train' and row['label']!=2 and row['confidence']!='high':
            excluded.append(item)
        else:
            converted[row['split']].append(item)
    assert len(converted['train'])==67 and len(excluded)==13
    data = {'train':old['train']+converted['train']*REPEAT,
            'cal':old['cal']+converted['cal'], 'ime_test':converted['test'],
            'known_round2':old['test'], 'known_legacy':old['regression'],
            'ime_train_excluded':excluded}
    # No repetition outside deliberate within-TRAIN sampling. Excluded examples
    # are not used for CAL/model selection, or relabelled based on predictions.
    unique_train = old['train']+converted['train']
    checks = {'train':unique_train,'cal':data['cal'],'ime_test':data['ime_test'],
              'known_round2':data['known_round2'],'known_legacy':data['known_legacy']}
    normalized = {s:{r2.canonical(r['text']) for r in rows} for s,rows in checks.items()}
    for i,a in enumerate(checks):
        for b in list(checks)[i+1:]:
            assert normalized[a].isdisjoint(normalized[b]), f'Exact leakage {a}/{b}'
    from transformers import AutoTokenizer
    folder = r2.OLD/'hf-cache/models--hfl--chinese-electra-180g-small-discriminator/snapshots'/r2.REV
    tok = AutoTokenizer.from_pretrained(str(folder),local_files_only=True,trust_remote_code=False)
    assert all(len(tok(r['text'])['input_ids'])<=128 for rows in data.values() for r in rows)
    manifest = {'seed':SEED,'repeat_ime_train':REPEAT,'unique_train_count':len(unique_train),
                'counts':{s:dict(Counter(r['label'] for r in rows)) for s,rows in data.items()},
                'categories':{s:dict(Counter(r['category'] for r in rows)) for s,rows in data.items()},
                'split_hashes':{s:rows_hash(rows) for s,rows in data.items()},
                'source_hashes':{'ime_annotations':sha(ime_file),'ime_raw':sha(raw_file),
                                 'round2_prepared':sha(PREVIOUS/'prepared.json'),
                                 'round2_selected_model':read(PREVIOUS/'selection.json')['checkpoint_sha256']},
                'ime_fit_unique_counts':dict(Counter(r['label'] for r in converted['train'])),
                'protocol':{'epochs':3,'learning_rate':8e-5,'batch_size':32,'max_tokens':128,
                    'class_weights':[1.5,1.,1.5], 'ime_context_sample_weight':.5,
                    'selection':'Max total CAL noise count, min CAL normal FP, earliest epoch. No test scores.',
                    'cutoff':'Node INT8 CAL only: >=0; normal 99th percentile, per-category 97.5th percentile, max context; strict >.',
                    'training_start':'Same pinned original pretrained ELECTRA, combined dataset; not a warm start from round-2 ONNX.',
                    'comparison':['round2-original','round2-recalibrated','round3-ime'],
                    'label_caveat':'Assistant-labelled IME outputs and authored examples; silver public normal text. No independent human gold.',
                    'test_caveat':'IME TEST has 1 normal / 13 noise / 6 context; older sets are known regression only.'}}
    r2.save(WORK/'prepared.json',data)
    r2.save(WORK/'manifest.json',manifest)
    print(json.dumps(manifest,ensure_ascii=False),flush=True)


def train():
    import numpy as np
    import torch
    import onnxruntime as ort
    from onnxruntime.quantization import quantize_dynamic, QuantType
    from transformers import AutoModel, AutoTokenizer, get_linear_schedule_with_warmup
    if (WORK/'selection.json').exists():
        raise FileExistsError('Already selected; do not retune an opened test')
    data,manifest = read(WORK/'prepared.json'),read(WORK/'manifest.json')
    verify_frozen(data,manifest)
    torch.set_num_threads(4);torch.set_num_interop_threads(1)
    torch.manual_seed(SEED);random.seed(SEED)
    folder = r2.OLD/'hf-cache/models--hfl--chinese-electra-180g-small-discriminator/snapshots'/r2.REV
    tokenizer = AutoTokenizer.from_pretrained(str(folder),local_files_only=True,trust_remote_code=False)
    class ThreeWay(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.encoder=AutoModel.from_pretrained(str(folder),local_files_only=True,trust_remote_code=False,attn_implementation='eager')
            self.drop=torch.nn.Dropout(.1)
            self.head=torch.nn.Linear(self.encoder.config.hidden_size*2,3)
        def forward(self,input_ids,attention_mask,token_type_ids):
            h=self.encoder(input_ids=input_ids,attention_mask=attention_mask,token_type_ids=token_type_ids).last_hidden_state
            mask=attention_mask.unsqueeze(-1).to(h.dtype)
            v=torch.cat([h[:,0],(h*mask).sum(1)/mask.sum(1)],1)
            return self.head(self.drop(v))
    model=ThreeWay()
    rows=data['train']
    inputs=tokenizer([r['text'] for r in rows],padding=True,truncation=True,max_length=128,return_tensors='pt')
    labels=torch.tensor([r['label'] for r in rows]);weights=torch.tensor([r['weight'] for r in rows])
    class_weights=torch.tensor([1.5,1.,1.5])
    optimizer=torch.optim.AdamW(model.parameters(),lr=8e-5,weight_decay=.01)
    steps=math.ceil(len(rows)/32)*3
    scheduler=get_linear_schedule_with_warmup(optimizer,steps//10,steps)
    history=[];started=time.perf_counter()
    sample=tokenizer('请检查这个 WebSocket 的 close code。',return_tensors='pt')
    probe=data['cal'][:6]+[r for r in data['cal'] if r['source']=='physical-keyboard-doubao-001'][:6]
    for epoch in range(3):
        model.train();losses=[]
        buckets=list(torch.argsort(inputs['attention_mask'].sum(1)).split(32))
        for step,b in enumerate(torch.randperm(len(buckets))):
            ids=buckets[int(b)];width=int(inputs['attention_mask'][ids].sum(1).max())
            inp={k:v[ids,:width] for k,v in inputs.items()}
            optimizer.zero_grad(set_to_none=True)
            output=model(**inp)
            loss=(torch.nn.functional.cross_entropy(output,labels[ids],reduction='none',weight=class_weights)*weights[ids]).mean()
            assert torch.isfinite(loss)
            loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1.)
            optimizer.step();scheduler.step();losses.append(float(loss.detach()))
            if step%60==0:print(f'epoch {epoch+1} batch {step}/{len(buckets)}',flush=True)
        model.eval()
        full=WORK/f'epoch-{epoch+1}.onnx';small=WORK/f'epoch-{epoch+1}-int8.onnx'
        checkpoint=WORK/f'epoch-{epoch+1}.pt'
        torch.save({'state_dict':model.state_dict(),'base_model':'hfl/chinese-electra-180g-small-discriminator',
                    'base_revision':r2.REV,'pooling':'CLS + masked mean','classes':['normal','noise','context'],
                    'seed':SEED,'epoch':epoch+1,'train_sha256':manifest['split_hashes']['train']},checkpoint)
        names=['input_ids','attention_mask','token_type_ids']
        torch.onnx.export(model,tuple(sample[n] for n in names),str(full),input_names=names,output_names=['logits'],
            dynamic_axes={n:{0:'batch',1:'sequence'} for n in names}|{'logits':{0:'batch'}},opset_version=17,dynamo=False)
        opt=ort.SessionOptions();opt.intra_op_num_threads=4;opt.inter_op_num_threads=1
        session=ort.InferenceSession(str(full),opt,providers=['CPUExecutionProvider'])
        drift=0.
        with torch.inference_mode():
            for row in probe:
                inp=tokenizer(row['text'],return_tensors='pt')
                actual=session.run(None,{n:inp[n].numpy() for n in names})[0]
                drift=max(drift,float(np.abs(model(**inp).numpy()-actual).max()))
        assert drift<.001
        quantize_dynamic(str(full),str(small),weight_type=QuantType.QInt8)
        scores,native,truncated=r2.node_scores(small,data['cal'],f'epoch-{epoch+1}-cal')
        cutoff=r2.operating_point(data['cal'],scores)
        metrics=r2.metrics(data['cal'],scores,cutoff)
        record={'epoch':epoch+1,'loss':float(np.mean(losses)),'cal':metrics,'cal_truncated':truncated,
                'fp32_export_probe_count':len(probe),'fp32_export_max_drift':drift,
                'artifact':small.name,'artifact_bytes':small.stat().st_size,
                'torch_checkpoint':checkpoint.name,'native_version':native['native_version']}
        history.append(record);print(json.dumps(record),flush=True)
    chosen=max(history,key=lambda h:(h['cal']['noise_detected'][0],-h['cal']['normal_false_positives'][0],-h['epoch']))
    result={'selected':chosen,'history':history,'train_seconds':time.perf_counter()-started,
            'manifest_sha256':sha(WORK/'manifest.json'),'split_hashes_before_selection':manifest['split_hashes'],
            'checkpoint_sha256':sha(WORK/chosen['artifact']),
            'torch_checkpoint_sha256':sha(WORK/chosen['torch_checkpoint'])}
    r2.save(WORK/'selection.json',result)


def evaluate():
    import numpy as np
    if (WORK/'results.json').exists():
        raise FileExistsError('Already opened IME test; keep the fixed result')
    data,manifest,selection=read(WORK/'prepared.json'),read(WORK/'manifest.json'),read(WORK/'selection.json')
    verify_frozen(data,manifest)
    assert manifest['split_hashes']==selection['split_hashes_before_selection']
    assert sha(WORK/selection['selected']['artifact'])==selection['checkpoint_sha256']
    previous=read(PREVIOUS/'selection.json')
    baseline=PREVIOUS/previous['selected']['artifact']
    assert sha(baseline)==manifest['source_hashes']['round2_selected_model']
    configurations={'round2-original':(baseline,previous['selected']['cal']['threshold']),
                    'round2-recalibrated':(baseline,None),
                    'round3-ime':(WORK/selection['selected']['artifact'],selection['selected']['cal']['threshold'])}
    result={'selection':selection,'manifest':manifest,'configurations':{}}
    for name,(model,cutoff) in configurations.items():
        if cutoff is None:
            scores,_,_=r2.node_scores(model,data['cal'],name+'-cal')
            cutoff=r2.operating_point(data['cal'],scores)
        output={'threshold':cutoff,'splits':{}}
        for split in ['ime_test','known_round2','known_legacy']:
            scores,native,truncated=r2.node_scores(model,data[split],name+'-'+split)
            measured=r2.metrics(data[split],scores,cutoff)
            item={'metrics':measured,'truncated':truncated,'native_version':native['native_version'],
                  'latency_p50_ms':native['latency_p50_ms'],'latency_p95_ms':native['latency_p95_ms'],
                  'predictions':[{'index':i,'group':r.get('group',f'{split}-{i}'),'label':r['label'],'score':float(s),'warning':bool(s>cutoff)}
                                 for i,(r,s) in enumerate(zip(data[split],scores))]}
            if split=='ime_test':
                mask=np.array([r['confidence']=='high' for r in data[split]])
                item['high_confidence_metrics']=r2.metrics([r for r,keep in zip(data[split],mask) if keep],scores[mask],cutoff)
            output['splits'][split]=item
        result['configurations'][name]=output
        print(json.dumps({name:{s:v['metrics'] for s,v in output['splits'].items()}}),flush=True)
    r2.save(WORK/'results.json',result)


if __name__=='__main__':
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('command',choices=['prepare','train','evaluate'])
    args=p.parse_args()
    {'prepare':prepare,'train':train,'evaluate':evaluate}[args.command]()
