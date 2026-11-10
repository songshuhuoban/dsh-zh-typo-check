"""Frozen R3 backbone + 66,051-parameter residual head, DirectML-safe losses."""
from __future__ import annotations
import argparse
import copy
from datetime import datetime,timezone
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import time
import warnings

ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/'.research/semantic-round5'
CPU=ROOT/'.research/semantic-screen-venv/Scripts/python.exe'
spec=importlib.util.spec_from_file_location('r4',ROOT/'tools/semantic-round4.py')
r4=importlib.util.module_from_spec(spec);spec.loader.exec_module(r4);r4.r2.WORK=WORK
read,save,sha=r4.read,r4.save,r4.sha


def frozen():
    data,manifest=read(WORK/'prepared.json'),read(WORK/'manifest.json')
    for split,rows in data.items():assert r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True))==manifest['split_hashes'][split]
    assert sha(ROOT/'.research/semantic-directml/model.safetensors')==manifest['source_hashes']['r3_weights']
    return data,manifest


def build():
    import torch
    from safetensors.torch import load_file
    base,tok=r4.model_and_tokenizer()
    state=load_file(str(ROOT/'.research/semantic-directml/model.safetensors'))
    missing,unexpected=base.load_state_dict(state,strict=False)
    assert set(missing)=={'aux.weight','aux.bias'} and not unexpected
    class Residual(torch.nn.Module):
        def __init__(self):
            super().__init__();self.encoder=base.encoder;self.head=base.head
            self.residual=torch.nn.Sequential(torch.nn.Linear(512,128),torch.nn.GELU(),torch.nn.Dropout(.1),torch.nn.Linear(128,3))
            torch.nn.init.zeros_(self.residual[3].weight);torch.nn.init.zeros_(self.residual[3].bias)
            self.encoder.requires_grad_(False);self.head.requires_grad_(False)
        def features(self,input_ids,attention_mask,token_type_ids):
            h=self.encoder(input_ids=input_ids,attention_mask=attention_mask,token_type_ids=token_type_ids).last_hidden_state
            mask=attention_mask.unsqueeze(-1).to(h.dtype)
            return torch.cat([h[:,0],(h*mask).sum(1)/mask.sum(1)],1)
        def forward(self,input_ids,attention_mask,token_type_ids):
            value=self.features(input_ids,attention_mask,token_type_ids)
            return self.head(value)+self.residual(value)
    model=Residual()
    assert sum(p.numel() for p in model.parameters() if p.requires_grad)==66051
    return model,tok,state


def loss_for(delta,base,one_hot,weights,distill,protocol,class_weights):
    import torch
    from semantic_device_loss import classification_nll
    logits=base+delta;temp=protocol['distillation_temperature']
    ce=classification_nll(logits,one_hot,class_weights)
    teacher=-(torch.nn.functional.softmax(base/temp,dim=-1)*torch.nn.functional.log_softmax(logits/temp,dim=-1)).sum(-1)*temp*temp
    return ((ce+protocol['distillation_weight']*teacher*distill)*weights).mean()+protocol['residual_l2_weight']*delta.square().mean()


def train():
    import torch
    import torch_directml
    from safetensors.torch import save_file
    from semantic_device_optim import PortableAdamW
    data,manifest=frozen();assert not (WORK/'training-started.json').exists()
    proof=read(ROOT/'data/semantic-directml-gradient-check.json')
    assert sha(ROOT/'tools/semantic_device_loss.py')==proof['loss_helper_sha256'] and proof['corrected_manual_path']['ok']
    torch.set_num_threads(4);torch.set_num_interop_threads(1);torch.manual_seed(20261110)
    device=torch_directml.device(0);assert '780M' in torch_directml.device_name(0)
    model,tok,original=build();model.to(device).eval();rows=data['train'];protocol=manifest['protocol']
    unique={};index=[];texts=[]
    for r in rows:
        key=r4.r2.canonical(r['text'])
        if key not in unique:unique[key]=len(texts);texts.append(key)
        index.append(unique[key])
    features=torch.empty((len(texts),512));base_logits=torch.empty((len(texts),3))
    started=time.perf_counter()
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter('always')
        with torch.no_grad():
            for start in range(0,len(texts),32):
                inp=tok(texts[start:start+32],padding=True,return_tensors='pt')
                value=model.features(**{k:v.to(device) for k,v in inp.items()})
                features[start:start+len(value)]=value.cpu();base_logits[start:start+len(value)]=model.head(value).cpu()
                if start%2048==0:print(json.dumps({'phase':'frozen-feature-cache','done':start,'total':len(texts)}),flush=True)
        save_file({'features':features,'base_logits':base_logits},str(WORK/'train-features.safetensors'),metadata={'train_sha256':manifest['split_hashes']['train']})
        cache_seconds=time.perf_counter()-started
        index=torch.tensor(index);labels=torch.tensor([r['label'] for r in rows]);one_hot=torch.nn.functional.one_hot(labels,3).float()
        weights=torch.tensor([r['weight'] for r in rows]);distill=torch.tensor([r['distill'] for r in rows])
        class_weights=torch.tensor([1.5,1.,1.5],device=device)
        # Verify the actual new objective/MLP gradient against CPU, with dropout
        # disabled and a nonzero final layer so every layer is exercised.
        check=copy.deepcopy(model.residual).cpu().eval()
        with torch.no_grad():check[3].weight.normal_(std=.01)
        check_gpu=copy.deepcopy(check).to(device)
        ids=torch.tensor([next(i for i,r in enumerate(rows) if r['label']==label) for label in [0,1,2]]+
                         [i for i,r in enumerate(rows) if r['category'].startswith('physical-')][:3])
        probe_inputs=features[index[ids]];probe_base=base_logits[index[ids]]
        checks=[]
        for head,d in [(check,torch.device('cpu')),(check_gpu,device)]:
            delta=head(probe_inputs.to(d))
            loss=loss_for(delta,probe_base.to(d),one_hot[ids].to(d),weights[ids].to(d),distill[ids].to(d),protocol,class_weights.to(d))
            loss.backward();checks.append(float(loss.detach().cpu()))
        max_gradient_error=max(float((a.grad-b.grad.cpu()).abs().max()) for a,b in zip(check.parameters(),check_gpu.parameters()))
        assert max_gradient_error<1e-4 and abs(checks[0]-checks[1])<1e-4
        save(WORK/'training-started.json',{'manifest_sha256':sha(WORK/'manifest.json'),'created_at_utc':datetime.now(timezone.utc).isoformat(),
            'trainable_parameters':66051,'base_parameters_frozen':True,'feature_cache_seconds':cache_seconds,
            'device':torch_directml.device_name(0).rstrip('\x00'),'torch':torch.__version__,
            'head_gradient_preflight':{'max_abs_error':max_gradient_error,'losses_cpu_gpu':checks},
            'code_sha256':{p.name:sha(p) for p in [Path(__file__),ROOT/'tools/semantic_device_loss.py',ROOT/'tools/semantic_device_optim.py']}})
        optimizer=PortableAdamW(model.residual.parameters(),lr=protocol['learning_rate'])
        history=[]
        for epoch in range(1,protocol['epochs']+1):
            model.residual.train();losses=[];tick=time.perf_counter()
            for ids in torch.randperm(len(rows)).split(protocol['batch_size']):
                value=features[index[ids]].to(device);base=base_logits[index[ids]].to(device)
                optimizer.zero_grad(set_to_none=True);delta=model.residual(value)
                loss=loss_for(delta,base,one_hot[ids].to(device),weights[ids].to(device),distill[ids].to(device),protocol,class_weights)
                loss.backward();torch.nn.utils.clip_grad_norm_(model.residual.parameters(),1.,foreach=False,error_if_nonfinite=True)
                optimizer.step();val=float(loss.detach().cpu());sync=float(model.residual[3].bias[0].detach().cpu())
                assert math.isfinite(val) and math.isfinite(sync);losses.append(val)
            state={k:v.detach().cpu().contiguous() for k,v in model.state_dict().items()}
            assert all(torch.equal(state[k],v) for k,v in original.items()), 'Frozen base changed'
            assert all(bool(torch.isfinite(v).all()) for v in state.values())
            path=WORK/f'epoch-{epoch}.safetensors';save_file(state,str(path),metadata={'train_sha256':manifest['split_hashes']['train']})
            training={'epoch':epoch,'head_training_seconds':time.perf_counter()-tick,'mean_loss':sum(losses)/len(losses),
                      'frozen_base_bitwise_unchanged':True,'weights_sha256':sha(path)}
            subprocess.run([str(CPU),'-X','utf8',str(Path(__file__)),'export','--epoch',str(epoch)],cwd=ROOT,check=True)
            history.append(read(WORK/f'epoch-{epoch}-cal.json')|training)
            save(WORK/f'epoch-{epoch}-training.json',training)
        warning_text=sorted({str(w.message) for w in captured})
    chosen=max(history,key=lambda h:(h['cal']['noise_macro_language_recall'],-h['cal']['normal_false_positives'][0],-h['epoch']))
    selection={'selected':chosen,'history':history,'total_seconds':time.perf_counter()-started,'warnings':warning_text,
               'split_hashes':manifest['split_hashes'],'checkpoint_sha256':sha(WORK/chosen['artifact']),
               'torch_checkpoint_sha256':chosen['weights_sha256'],'test_opened':False}
    save(WORK/'selection.json',selection);print(json.dumps({'phase':'selected','selected':chosen,'seconds':selection['total_seconds'],'warnings':warning_text}),flush=True)


def export(epoch):
    import numpy as np
    import torch
    import onnxruntime as ort
    from onnxruntime.quantization import quantize_dynamic,QuantType
    from safetensors.torch import load_file
    data,_=frozen();torch.set_num_threads(4);torch.set_num_interop_threads(1)
    model,tok,_=build();model.load_state_dict(load_file(str(WORK/f'epoch-{epoch}.safetensors')),strict=True);model.eval()
    names=['input_ids','attention_mask','token_type_ids'];sample=tok('请检查这个 request。',return_tensors='pt')
    full=WORK/f'epoch-{epoch}.onnx';small=WORK/f'epoch-{epoch}-int8.onnx';assert not full.exists()
    torch.onnx.export(model,tuple(sample[n] for n in names),str(full),input_names=names,output_names=['logits'],
        dynamic_axes={n:{0:'batch',1:'sequence'} for n in names}|{'logits':{0:'batch'}},opset_version=17,dynamo=False)
    opt=ort.SessionOptions();opt.intra_op_num_threads=4;opt.inter_op_num_threads=1
    session=ort.InferenceSession(str(full),opt,providers=['CPUExecutionProvider']);drift=0.
    with torch.no_grad():
        for row in data['cal'][:12]:
            inp=tok(row['text'],return_tensors='pt');a=session.run(None,{n:inp[n].numpy() for n in names})[0]
            drift=max(drift,float(np.abs(a-model(**inp).numpy()).max()))
    assert drift<.001
    quantize_dynamic(str(full),str(small),weight_type=QuantType.QInt8)
    scores,native,truncated=r4.r2.node_scores(small,data['cal'],f'epoch-{epoch}-cal');assert truncated==0
    thresholds={}
    for lang in ['en','zh','mixed']:
        ids=[i for i,r in enumerate(data['cal']) if r4.language(r['text'])==lang]
        thresholds[lang]=r4.r2.operating_point([data['cal'][i] for i in ids],scores[ids])
    adjusted=scores-np.array([thresholds[r4.language(r['text'])] for r in data['cal']])
    record={'epoch':epoch,'artifact':small.name,'torch_checkpoint':f'epoch-{epoch}.safetensors','artifact_bytes':small.stat().st_size,
            'thresholds':thresholds,'cal':r4.measured(data['cal'],adjusted,0.),'fp32_export_max_drift':drift,'native_version':native['native_version']}
    save(WORK/f'epoch-{epoch}-cal.json',record);print(json.dumps(record),flush=True)


def evaluate():
    import numpy as np
    assert not (WORK/'results.json').exists()
    data,manifest=frozen();selection=read(WORK/'selection.json');assert selection['split_hashes']==manifest['split_hashes']
    chosen=selection['selected'];model=WORK/chosen['artifact'];assert sha(model)==selection['checkpoint_sha256']
    r3=read(ROOT/'.research/semantic-round3/selection.json')
    configurations={'round3':(ROOT/'.research/semantic-round3'/r3['selected']['artifact'],r3['selected']['cal']['threshold']),
                    'round5':(model,None)}
    result={'manifest':manifest,'selection':selection,'training':read(WORK/'training-started.json'),'configurations':{}}
    for name,(path,cutoff) in configurations.items():
        output={'splits':{}}
        for split in ['fresh_challenge','new_challenge','new_public_test','known_ime','known_round2','known_legacy']:
            scores,native,truncated=r4.r2.node_scores(path,data[split],name+'-'+split);assert truncated==0
            adjusted=scores-np.array([chosen['thresholds'][r4.language(r['text'])] for r in data[split]]) if name=='round5' else scores-cutoff
            output['splits'][split]={'metrics':r4.measured(data[split],adjusted,0.),'p95_ms':native['latency_p95_ms'],
                'predictions':[{'index':i,'label':r['label'],'category':r['category'],'language':r4.language(r['text']),
                                'group':r.get('group',f'{split}-{i}'),'raw_score':float(s),'score':float(a),'warning':bool(a>0)}
                               for i,(r,s,a) in enumerate(zip(data[split],scores,adjusted))]}
        result['configurations'][name]=output
    save(WORK/'results.json',result)
    print(json.dumps({name:{s:v['metrics'] for s,v in c['splits'].items()} for name,c in result['configurations'].items()}),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('command',choices=['train','export','evaluate'])
    parser.add_argument('--epoch',type=int,choices=[1,2,3]);args=parser.parse_args()
    if args.command=='train':train()
    elif args.command=='export':assert args.epoch;export(args.epoch)
    else:evaluate()
