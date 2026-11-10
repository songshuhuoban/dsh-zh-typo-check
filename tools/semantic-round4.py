"""R4: real DirectML fine-tuning, separate CSED auxiliary head, native INT8 CAL.

Commands: train (DirectML environment), export/evaluate (original CPU environment).
Fresh tests open only after the immutable CAL-selected checkpoint is written.
"""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import time
import warnings

ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/'.research/semantic-round4'
FOLDER=ROOT/'.research/semantic-screen/hf-cache/models--hfl--chinese-electra-180g-small-discriminator/snapshots/826a243f3f387450ef8d70de9c3d0706d8d8e924'
SEED=20261110
LOSS_MODE='manual'
CPU_PYTHON=ROOT/'.research/semantic-screen-venv/Scripts/python.exe'
spec=importlib.util.spec_from_file_location('r2_helpers',ROOT/'tools/semantic-round2.py')
r2=importlib.util.module_from_spec(spec);spec.loader.exec_module(r2);r2.WORK=WORK


def read(path):return json.loads(path.read_text(encoding='utf-8'))
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def save(path,value):r2.save(path,value)


def frozen():
    data,manifest=read(WORK/'prepared.json'),read(WORK/'manifest.json')
    for split,rows in data.items():
        assert r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True))==manifest['split_hashes'][split],split
    assert sha(ROOT/'data/mixed-semantic-round4-seeds.json')==manifest['challenge_file_sha256']
    return data,manifest


def model_and_tokenizer():
    import torch
    from transformers import AutoConfig,AutoModel,AutoTokenizer
    config=AutoConfig.from_pretrained(str(FOLDER),local_files_only=True,trust_remote_code=False)
    class MultiTask(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.encoder=AutoModel.from_config(config,attn_implementation='eager')
            self.drop=torch.nn.Dropout(.1)
            self.head=torch.nn.Linear(config.hidden_size*2,3)
            self.aux=torch.nn.Linear(config.hidden_size*2,2)
        def features(self,input_ids,attention_mask,token_type_ids):
            h=self.encoder(input_ids=input_ids,attention_mask=attention_mask,token_type_ids=token_type_ids).last_hidden_state
            mask=attention_mask.unsqueeze(-1).to(h.dtype)
            return self.drop(torch.cat([h[:,0],(h*mask).sum(1)/mask.sum(1)],1))
        def forward(self,input_ids,attention_mask,token_type_ids):
            return self.head(self.features(input_ids,attention_mask,token_type_ids))
        def forward_all(self,**inputs):
            value=self.features(**inputs)
            return self.head(value),self.aux(value)
    return MultiTask(),AutoTokenizer.from_pretrained(str(FOLDER),local_files_only=True,trust_remote_code=False)


def language(text):
    chinese=bool(re.search(r'[\u4e00-\u9fff]',text))
    latin=bool(re.search(r'[A-Za-z]{2,}',text))
    return 'mixed' if chinese and latin else 'zh' if chinese else 'en'


def measured(rows,scores,cutoff):
    import numpy as np
    result=r2.metrics(rows,scores,cutoff)
    rates=[];result['noise_languages']={}
    for lang in ['en','zh','mixed']:
        ids=[i for i,r in enumerate(rows) if r['label']==1 and language(r['text'])==lang]
        detected=sum(float(scores[i])>cutoff for i in ids)
        result['noise_languages'][lang]=[detected,len(ids)]
        if ids:rates.append(detected/len(ids))
    result['noise_macro_language_recall']=float(np.mean(rates)) if rates else None
    return result


def train():
    import torch
    import torch_directml
    from safetensors.torch import load_file,save_file
    from transformers import get_linear_schedule_with_warmup
    from semantic_device_optim import PortableAdamW,verify_adamw
    from semantic_device_loss import classification_nll
    data,manifest=frozen()
    if (WORK/'training-started.json').exists():raise FileExistsError('Do not overwrite a training run')
    assert sha(ROOT/'.research/semantic-directml/model.safetensors')==manifest['r3_weights_sha256']
    preflight=None
    if LOSS_MODE=='manual':
        preflight=read(ROOT/'.research/semantic-round4/device-gradient-corrected-r3.json')
        assert preflight['ok'] and preflight['loss_implementation']=='manual' and preflight['weight_source']=='round3'
        assert all(g['relative_l2_error']<.001 and g['cosine']>.99999 for g in preflight['gradient_groups'].values())
        evidence=read(ROOT/'data/semantic-directml-gradient-check.json')
        assert sha(ROOT/'tools/semantic_device_loss.py')==evidence['loss_helper_sha256'], 'Loss code changed; repeat gradient preflight'
        assert manifest['r3_weights_sha256']==evidence['source_r3_weights_sha256']
    torch.set_num_threads(4);torch.set_num_interop_threads(1);torch.manual_seed(SEED)
    device_names=[torch_directml.device_name(i).rstrip('\x00') for i in range(torch_directml.device_count())]
    matches=[i for i,n in enumerate(device_names) if '780M' in n];assert len(matches)==1
    device=torch_directml.device(matches[0])
    model,tokenizer=model_and_tokenizer()
    missing,unexpected=model.load_state_dict(load_file(str(ROOT/'.research/semantic-directml/model.safetensors')),strict=False)
    assert set(missing)=={'aux.weight','aux.bias'} and not unexpected
    model.to(device)
    optimizer_check=verify_adamw(device)
    rows=data['train'];protocol=manifest['protocol']
    inputs=tokenizer([r['text'] for r in rows],padding=True,truncation=False,return_tensors='pt')
    lengths=inputs['attention_mask'].sum(1);assert int(lengths.max())<=128
    labels=torch.tensor([r['label'] for r in rows]);sample_weights=torch.tensor([r['weight'] for r in rows])
    one_hot=torch.nn.functional.one_hot(labels,3).float()
    aux_one_hot=torch.nn.functional.one_hot(labels.clamp_max(1),2).float()
    auxiliary=torch.tensor([float(r.get('task')=='csed') for r in rows])
    class_weights=torch.tensor([1.5,1.,1.5],device=device)
    optimizer=PortableAdamW(model.parameters(),lr=protocol['learning_rate'])
    buckets=list(torch.argsort(lengths,stable=True).split(32))
    total_steps=len(buckets)*protocol['epochs']
    scheduler=get_linear_schedule_with_warmup(optimizer,total_steps//10,total_steps)
    save(WORK/'training-started.json',{'manifest_sha256':sha(WORK/'manifest.json'),'torch_version':torch.__version__,
        'loss_implementation':LOSS_MODE,'gradient_preflight':preflight,
        'test_role':'previously_opened_R4_regression' if WORK.name!='semantic-round4' else 'R4_initial_holdout',
        'device':str(device),'device_names':device_names,'optimizer_check':optimizer_check,
        'code_sha256':{p.name:sha(p) for p in [Path(__file__),ROOT/'tools/semantic-round4-data.py',ROOT/'tools/semantic_device_optim.py',ROOT/'tools/semantic_device_loss.py']}})
    history=[];started=time.perf_counter();first_gradient=None
    probe=model.encoder.encoder.layer[0].attention.self.query.weight
    initial_probe=probe.detach().cpu().clone()
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        for epoch in range(1,protocol['epochs']+1):
            model.train();losses=[];step_times=[];epoch_started=time.perf_counter()
            for step,index in enumerate(torch.randperm(len(buckets))):
                ids=buckets[int(index)];width=int(lengths[ids].max())
                inp={k:v[ids,:width].to(device) for k,v in inputs.items()}
                target=labels[ids].to(device);weight=sample_weights[ids].to(device);aux=auxiliary[ids].to(device)
                tick=time.perf_counter();optimizer.zero_grad(set_to_none=True)
                logits,aux_logits=model.forward_all(**inp)
                main_loss=classification_nll(logits,one_hot[ids].to(device),class_weights)
                aux_loss=classification_nll(aux_logits,aux_one_hot[ids].to(device))
                loss=((main_loss*(1-aux)+protocol['aux_csed_loss_weight']*aux_loss*aux)*weight).mean()
                loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1.,foreach=False,error_if_nonfinite=True)
                if first_gradient is None:
                    first_gradient=float(probe.grad.detach().cpu().abs().max());assert first_gradient>0 and math.isfinite(first_gradient)
                optimizer.step();scheduler.step()
                value=float(loss.detach().cpu());sync=float(model.aux.bias.detach()[0].cpu())
                assert math.isfinite(value) and math.isfinite(sync)
                step_times.append(time.perf_counter()-tick);losses.append(value)
                if step%80==0:print(json.dumps({'phase':'gpu-train','epoch':epoch,'batch':step,'total':len(buckets),'loss':value,'width':width}),flush=True)
            state={k:v.detach().cpu().contiguous() for k,v in model.state_dict().items()}
            assert all(bool(torch.isfinite(v).all()) for v in state.values())
            delta=float((state['encoder.encoder.layer.0.attention.self.query.weight']-initial_probe).abs().max())
            assert delta>0
            path=WORK/f'epoch-{epoch}.safetensors';assert not path.exists()
            save_file(state,str(path),metadata={'train_sha256':manifest['split_hashes']['train'],'epoch':str(epoch),'seed':str(SEED)})
            epoch_data={'epoch':epoch,'mean_loss':sum(losses)/len(losses),'training_seconds':time.perf_counter()-epoch_started,
                        'mean_step_seconds':sum(step_times)/len(step_times),'backbone_gradient_max_first_step':first_gradient,
                        'backbone_weight_max_delta':delta,'all_final_parameters_finite':True,'weights_sha256':sha(path)}
            save(WORK/f'epoch-{epoch}-training.json',epoch_data)
            subprocess.run([str(CPU_PYTHON),'-X','utf8',str(Path(__file__)),'export','--epoch',str(epoch),
                            '--workdir',str(WORK)],cwd=ROOT,check=True)
            history.append(read(WORK/f'epoch-{epoch}-cal.json')|epoch_data)
        warning_text=sorted({str(w.message) for w in caught})
    chosen=max(history,key=lambda h:(h['cal']['noise_macro_language_recall'],-h['cal']['normal_false_positives'][0],-h['epoch']))
    result={'selected':chosen,'history':history,'total_seconds':time.perf_counter()-started,
            'loss_implementation':LOSS_MODE,'gradient_preflight':preflight,
            'split_hashes':manifest['split_hashes'],'manifest_sha256':sha(WORK/'manifest.json'),
            'checkpoint_sha256':sha(WORK/chosen['artifact']),'torch_checkpoint_sha256':chosen['weights_sha256'],
            'device':str(device),'device_names':device_names,'warnings':warning_text,'optimizer_check':optimizer_check}
    save(WORK/'selection.json',result)
    print(json.dumps({'phase':'selected','epoch':chosen['epoch'],'cal':chosen['cal'],'seconds':result['total_seconds'],'warnings':warning_text}),flush=True)


def export(epoch):
    import numpy as np
    import torch
    import onnxruntime as ort
    from onnxruntime.quantization import quantize_dynamic,QuantType
    from safetensors.torch import load_file
    data,manifest=frozen();torch.set_num_threads(4);torch.set_num_interop_threads(1)
    model,tokenizer=model_and_tokenizer();model.load_state_dict(load_file(str(WORK/f'epoch-{epoch}.safetensors')),strict=True);model.eval()
    names=['input_ids','attention_mask','token_type_ids'];sample=tokenizer('请检查这个 API 的错误处理。',return_tensors='pt')
    full=WORK/f'epoch-{epoch}.onnx';small=WORK/f'epoch-{epoch}-int8.onnx'
    assert not full.exists() and not small.exists()
    torch.onnx.export(model,tuple(sample[n] for n in names),str(full),input_names=names,output_names=['logits'],
        dynamic_axes={n:{0:'batch',1:'sequence'} for n in names}|{'logits':{0:'batch'}},opset_version=17,dynamo=False)
    options=ort.SessionOptions();options.intra_op_num_threads=4;options.inter_op_num_threads=1
    session=ort.InferenceSession(str(full),options,providers=['CPUExecutionProvider']);drift=0.
    probes=data['cal'][:4]+[r for r in data['cal'] if r['category'].startswith('ascend')][:4]+[r for r in data['cal'] if r['category']=='public-en-word_soup'][:4]
    with torch.no_grad():
        for row in probes:
            inp=tokenizer(row['text'],return_tensors='pt')
            value=session.run(None,{n:inp[n].numpy() for n in names})[0]
            drift=max(drift,float(np.abs(value-model(**inp).numpy()).max()))
    assert drift<.001
    quantize_dynamic(str(full),str(small),weight_type=QuantType.QInt8)
    scores,native,truncated=r2.node_scores(small,data['cal'],f'epoch-{epoch}-cal')
    assert truncated==0
    cutoff=r2.operating_point(data['cal'],scores)
    record={'epoch':epoch,'cal':measured(data['cal'],scores,cutoff),'artifact':small.name,'artifact_bytes':small.stat().st_size,
            'torch_checkpoint':f'epoch-{epoch}.safetensors','fp32_export_max_drift':drift,
            'fp32_export_probe_count':len(probes),'native_version':native['native_version'],'cal_truncated':truncated}
    save(WORK/f'epoch-{epoch}-cal.json',record);print(json.dumps(record),flush=True)


def evaluate():
    import numpy as np
    if (WORK/'results.json').exists():raise FileExistsError('Fresh test already opened')
    data,manifest=frozen();selection=read(WORK/'selection.json')
    assert selection['split_hashes']==manifest['split_hashes']
    selected=WORK/selection['selected']['artifact'];assert sha(selected)==selection['checkpoint_sha256']
    r3_dir=ROOT/'.research/semantic-round3';r3_selection=read(r3_dir/'selection.json')
    r2_dir=ROOT/'.research/semantic-round2';r2_selection=read(r2_dir/'selection.json')
    configurations={'round2-original':(r2_dir/r2_selection['selected']['artifact'],r2_selection['selected']['cal']['threshold']),
                    'round3-original':(r3_dir/r3_selection['selected']['artifact'],r3_selection['selected']['cal']['threshold']),
                    'round3-recalibrated':(r3_dir/r3_selection['selected']['artifact'],None),
                    'round4-public-aux':(selected,selection['selected']['cal']['threshold'])}
    result={'manifest':manifest,'selection':selection,'configurations':{},
            'test_role':'previously_opened_R4_regression' if WORK.name!='semantic-round4' else 'R4_initial_holdout'}
    for name,(path,cutoff) in configurations.items():
        if cutoff is None:
            scores,_,_=r2.node_scores(path,data['cal'],name+'-cal');cutoff=r2.operating_point(data['cal'],scores)
        output={'threshold':cutoff,'splits':{}}
        for split in ['new_challenge','new_public_test','known_ime','known_round2','known_legacy']:
            scores,native,truncated=r2.node_scores(path,data[split],name+'-'+split);assert truncated==0
            output['splits'][split]={'metrics':measured(data[split],scores,cutoff),
                'latency_p50_ms':native['latency_p50_ms'],'latency_p95_ms':native['latency_p95_ms'],
                'truncated':truncated,'native_version':native['native_version'],
                'predictions':[{'index':i,'group':r.get('group',f'{split}-{i}'),'label':r['label'],'category':r.get('category','legacy'),
                                'language':language(r['text']),'score':float(s),'warning':bool(s>cutoff)} for i,(r,s) in enumerate(zip(data[split],scores))]}
        result['configurations'][name]=output
    # Separate auxiliary task: semantic errors are not scored as noise warnings.
    import torch
    from safetensors.torch import load_file
    from sklearn.metrics import accuracy_score,balanced_accuracy_score,matthews_corrcoef
    torch.set_num_threads(4);torch.set_num_interop_threads(1)
    model,tokenizer=model_and_tokenizer();model.load_state_dict(load_file(str(WORK/selection['selected']['torch_checkpoint'])));model.eval()
    auxiliary={}
    with torch.no_grad():
        for split in ['aux_cal','aux_test']:
            predicted=[];rows=data[split]
            for start in range(0,len(rows),32):
                inp=tokenizer([r['text'] for r in rows[start:start+32]],padding=True,return_tensors='pt')
                predicted.extend(model.forward_all(**inp)[1].argmax(1).tolist())
            target=[r['label'] for r in rows]
            auxiliary[split]={'n':len(rows),'accuracy':accuracy_score(target,predicted),
                              'balanced_accuracy':balanced_accuracy_score(target,predicted),'mcc':matthews_corrcoef(target,predicted)}
    result['auxiliary_csed']=auxiliary
    save(WORK/'results.json',result)
    print(json.dumps({'phase':'final-results','auxiliary_csed':auxiliary,
        'metrics':{name:{s:v['metrics'] for s,v in c['splits'].items()} for name,c in result['configurations'].items()}}),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['train','export','evaluate'])
    parser.add_argument('--epoch',type=int,choices=[1,2,3])
    parser.add_argument('--workdir',type=Path,default=WORK)
    parser.add_argument('--loss',choices=['manual'],default='manual')
    args=parser.parse_args()
    WORK=args.workdir.resolve();r2.WORK=WORK;LOSS_MODE=args.loss
    if args.command=='train':train()
    elif args.command=='export':
        assert args.epoch is not None;export(args.epoch)
    else:evaluate()
