"""Controlled head-only vs last-two-Chinese-block adaptation on reviewed data."""
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

ROOT=Path(__file__).resolve().parents[1];WORK=ROOT/'.research/semantic-round11';CPU=ROOT/'.research/semantic-screen-venv/Scripts/python.exe'
spec=importlib.util.spec_from_file_location('r10',ROOT/'tools/semantic-round10.py')
r10=importlib.util.module_from_spec(spec);spec.loader.exec_module(r10)
spec=importlib.util.spec_from_file_location('r7',ROOT/'tools/semantic-round7.py')
r7=importlib.util.module_from_spec(spec);spec.loader.exec_module(r7)
r9=r10.r9;cal9=r10.cal9;r4=r9.r4;read,save,sha=r9.read,r9.save,r9.sha


def prepare():
    assert not (WORK/'manifest.json').exists();WORK.mkdir(exist_ok=True)
    data,_=r10.frozen();warm=read(r7.WORK/'selection.json')['selected'];teacher=read(r9.WORK/'selection.json')['selected']
    warm_path=r7.WORK/f"{warm['tag']}-epoch-{warm['epoch']}-head.safetensors"
    assert sha(warm_path)==warm['head_sha256']
    sources=[r10.WORK/'manifest.json',r9.WORK/'manifest.json',r9.WORK/'train-features.safetensors',
        ROOT/'.research/semantic-round5/train-features.safetensors',ROOT/'.research/semantic-directml/model.safetensors',warm_path,
        r9.WORK/f"epoch-{teacher['epoch']}-head.safetensors",r9.r6.WORK/'en-pretrained.safetensors']
    manifest={'created_at_utc':datetime.now(timezone.utc).isoformat(),'split_hashes':{s:r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True)) for s,rows in data.items()},
        'source_hashes':{str(p.relative_to(ROOT)):sha(p) for p in sources},'warm_head':str(warm_path.relative_to(ROOT)),
        'teacher_head':str((r9.WORK/f"epoch-{teacher['epoch']}-head.safetensors").relative_to(ROOT)),
        'protocol':{'arms':['head','last2'],'epochs':3,'checkpoints':[1,3],'batch_size':32,'bucket_size':512,
            'head_lr':.0002,'encoder_lr':.00002,'seed':20261115,'class_weights':[2.,1.,2.],
            'teacher_temperature':2.,'teacher_weight':.5,'teacher_mask':'All TRAIN normal/context only; noise unconstrained',
            'dropout':'All encoder/feature dropout OFF in both arms; residual dropout.1 ON during fitting',
            'frozen':'English encoder/RTD, original R3 classifier, normalization; head arm freezes all Chinese blocks; last2 arm trains only Chinese10/11',
            'threshold':'Pooled per-language normal99%/source99% only n>=101/max-context/min0; strict >',
            'selection':'CAL min language recall, macro recall, fewer normal warnings, earlier epoch; tie prefers head arm',
            'prior_tests':'All known regression including R9 new short260 and actual00460; no newly independent claims',
            'screen':{'known004_noise_min':30,'known004_normal_max':0,'known004_context_max':1,'short_normal_max':2,'short_context_max':3,
                'old_public_normal_max':5,'old425_normal_max':3,'old425_noise_min':28,'r5_en_noise_min':14,'r5_mixed_noise_min':12,'r5_normal_max':1,
                'budget_bytes':50_000_000,'native_p95_max_ms':15},
            'fresh_guard':'Only if all practical screen gates pass, collect new60 actualIME from physical bits starting124928 after CAL seal; else no new entropy.'}}
    save(WORK/'bases.json',read(r9.WORK/'bases.json'));save(WORK/'prepared.json',data);save(WORK/'manifest.json',manifest)


def frozen():
    data,manifest=read(WORK/'prepared.json'),read(WORK/'manifest.json')
    for s,rows in data.items():assert r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True))==manifest['split_hashes'][s]
    for p,h in manifest['source_hashes'].items():assert sha(ROOT/p)==h
    return data,manifest


def build(arm='head',checkpoint=None):
    from safetensors.torch import load_file
    manifest=read(WORK/'manifest.json');model,toks=r7.build()
    missing,extra=model.load_state_dict(load_file(str(ROOT/manifest['warm_head'])),strict=False)
    assert not extra and all(k.startswith(('chinese.','english.')) for k in missing)
    model.requires_grad_(False);model.residual.requires_grad_(True)
    if arm=='last2':
        for layer in model.chinese.encoder.encoder.layer[-2:]:layer.requires_grad_(True)
    names={n for n,p in model.named_parameters() if p.requires_grad}
    if checkpoint is not None:
        state=load_file(str(checkpoint));assert set(state)==names
        missing,extra=model.load_state_dict(state,strict=False);assert not extra and set(missing)==set(model.state_dict())-names
    model.eval();return model,toks,names


def cached_logits(model,cn,en):
    import torch
    features=torch.cat([cn,en],1)
    return model.chinese.head(cn)+model.residual(((features-model.center)/model.scale).clamp(-10,10))


def train_logits(model,inputs,en):
    return cached_logits(model,model.chinese.features(**inputs),en)


def score(path,rows,name):
    original=r9.WORK
    try:r9.WORK=WORK;return r9.score(path,rows,name)
    finally:r9.WORK=original


def gradient_check(model,inputs,cn,en,teacher,one_hot,weights,mask,protocol,device,full):
    import torch
    cpu=copy.deepcopy(model).cpu().eval();gpu=copy.deepcopy(model).to(device).eval();losses=[];outputs=[]
    cw=torch.tensor(protocol['class_weights'])
    for m,d in [(cpu,torch.device('cpu')),(gpu,device)]:
        logits=train_logits(m,{k:v.to(d) for k,v in inputs.items()},en.to(d)) if full else cached_logits(m,cn.to(d),en.to(d))
        loss=r9.loss_for(logits,teacher.to(d),one_hot.to(d),weights.to(d),mask.to(d),protocol,cw.to(d))
        loss.backward();losses.append(float(loss.detach().cpu()));outputs.append(logits.detach().cpu())
    groups={}
    for group,prefix in [('encoder','chinese.encoder.encoder.layer.'),('residual','residual.')]:
        left=[];right=[]
        for (n,a),(other,b) in zip(cpu.named_parameters(),gpu.named_parameters()):
            assert n==other and (a.grad is None)==(b.grad is None)
            if n.startswith(prefix) and a.grad is not None:left.append(a.grad.detach().flatten().double());right.append(b.grad.detach().cpu().flatten().double())
        if not left:continue
        a=torch.cat(left);b=torch.cat(right);relative=float((a-b).norm()/a.norm());cos=float(torch.dot(a,b)/(a.norm()*b.norm()))
        groups[group]={'parameters':a.numel(),'relative_l2_error':relative,'cosine':cos,'max_abs_error':float((a-b).abs().max())}
    logits_error=float((outputs[0]-outputs[1]).abs().max());valid=logits_error<.001 and abs(losses[0]-losses[1])<1e-4 and all(g['relative_l2_error']<.001 and g['cosine']>.99999 for g in groups.values())
    if full:valid=valid and 'encoder' in groups
    result={'ok':valid,'full_encoder_path':full,'losses_cpu_gpu':losses,'logits_max_abs_error':logits_error,'groups':groups}
    assert valid,result
    return result


def train():
    import torch
    import torch_directml
    from safetensors.torch import load_file,save_file
    from semantic_device_optim import PortableAdamW
    data,manifest=frozen();protocol=manifest['protocol'];assert not (WORK/'training-started.json').exists()
    proof=read(ROOT/'data/semantic-directml-gradient-check.json');assert sha(ROOT/'tools/semantic_device_loss.py')==proof['loss_helper_sha256'] and proof['corrected_manual_path']['ok']
    torch.set_num_threads(4);torch.set_num_interop_threads(1);torch.manual_seed(protocol['seed']);device=torch_directml.device(0)
    assert '780M' in torch_directml.device_name(0)
    rows=data['train'];texts=list(dict.fromkeys(r4.r2.canonical(r['text']) for r in rows));lookup={t:i for i,t in enumerate(texts)};index=torch.tensor([lookup[r4.r2.canonical(r['text'])] for r in rows])
    old=load_file(str(ROOT/'.research/semantic-round5/train-features.safetensors'))['features'];cn=torch.empty((len(texts),512));cn[:len(old)]=old
    oldtexts=list(dict.fromkeys(r4.r2.canonical(r['text']) for r in read(ROOT/'.research/semantic-round5/prepared.json')['train']));assert texts[:len(old)]==oldtexts
    raw=load_file(str(r9.WORK/'train-features.safetensors'))['features'];assert raw.shape==(len(texts),1048);en=raw[:,524:].contiguous()
    t=load_file(str(ROOT/manifest['teacher_head']))
    with torch.no_grad():
        norm=((raw-t['center'])/t['scale']).clamp(-10,10)
        hidden=torch.nn.functional.gelu(torch.nn.functional.linear(norm,t['head.0.weight'],t['head.0.bias']))
        teacher=torch.nn.functional.linear(hidden,t['head.3.weight'],t['head.3.bias'])
    cache_model,toks,_=build();cache_model.to(device).eval();started=time.perf_counter()
    with torch.no_grad():
        for start in range(len(old),len(texts),32):
            inp=toks['zh'](texts[start:start+32],padding=True,truncation=True,max_length=128,return_tensors='pt')
            features=cache_model.chinese.features(**{k:v.to(device) for k,v in inp.items()});cn[start:start+len(features)]=features.cpu()
    assert torch.isfinite(cn).all() and torch.isfinite(en).all() and torch.isfinite(teacher).all()
    save_file({'cn':cn,'en':en,'teacher':teacher},str(WORK/'train-cache.safetensors'),metadata={'train_sha256':manifest['split_hashes']['train']})
    del cache_model
    encoded=toks['zh'](texts,truncation=True,max_length=128);lengths=[len(ids) for ids in encoded['input_ids']]
    one_hot=torch.nn.functional.one_hot(torch.tensor([r['label'] for r in rows]),3).float();weights=torch.tensor([r['weight'] for r in rows]);mask=torch.tensor([float(r['label']!=1) for r in rows]);cw=torch.tensor(protocol['class_weights'],device=device)
    ids=torch.tensor([next(i for i,r in enumerate(rows) if r['label']==label) for label in [0,1,2]]+[next(i for i,r in enumerate(rows) if r['label']==label and r['category']=='r9-real-ime-2') for label in [0,1,2]])
    def batch_inputs(ids):
        unique_ids=index[ids].tolist()
        return toks['zh'].pad({k:[v[i] for i in unique_ids] for k,v in encoded.items()},padding=True,return_tensors='pt')
    inp=batch_inputs(ids);checks={}
    for arm in protocol['arms']:
        model,_,_=build(arm)
        checks[arm]=gradient_check(model,inp,cn[index[ids]],en[index[ids]],teacher[index[ids]],one_hot[ids],weights[ids],mask[ids],protocol,device,arm=='last2')
        del model
    save(WORK/'gradient-preflight.json',checks)
    save(WORK/'training-started.json',{'created_at_utc':datetime.now(timezone.utc).isoformat(),'device':torch_directml.device_name(0).rstrip('\x00'),'torch':torch.__version__,
        'manifest_sha256':sha(WORK/'manifest.json'),'code_sha256':{p.name:sha(p) for p in [Path(__file__),ROOT/'tools/semantic_device_loss.py',ROOT/'tools/semantic_device_optim.py']},
        'gradient_preflight':checks,'teacher_source':'R9 strict selected head, computed from original R9 raw cached features; not old cached teacher_logits'})
    history=[];warning_text=[]
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        for arm in protocol['arms']:
            model,_,trainable=build(arm);model.to(device).eval();torch.manual_seed(protocol['seed'])
            frozen_state={k:v.detach().cpu().clone() for k,v in model.state_dict().items() if k not in trainable}
            head_params=list(model.residual.parameters());encoder_params=[p for n,p in model.named_parameters() if p.requires_grad and not n.startswith('residual.')]
            groups=[{'params':head_params,'lr':protocol['head_lr']}]
            if encoder_params:groups.append({'params':encoder_params,'lr':protocol['encoder_lr']})
            optimizer=PortableAdamW(groups,lr=protocol['head_lr']);all_params=head_params+encoder_params
            save(WORK/f'{arm}-parameters.json',{'trainable_parameters':sum(p.numel() for p in all_params),'encoder_parameters':sum(p.numel() for p in encoder_params),'residual_parameters':sum(p.numel() for p in head_params)})
            for epoch in range(1,protocol['epochs']+1):
                model.eval();model.residual.train();losses=[];tick=time.perf_counter()
                permutation=torch.randperm(len(rows)).tolist();batches=[]
                for start in range(0,len(permutation),protocol['bucket_size']):
                    bucket=sorted(permutation[start:start+protocol['bucket_size']],key=lambda i:lengths[int(index[i])])
                    batches.extend(bucket[i:i+protocol['batch_size']] for i in range(0,len(bucket),protocol['batch_size']))
                for step,batch_no in enumerate(torch.randperm(len(batches)).tolist()):
                    ids=torch.tensor(batches[batch_no]);optimizer.zero_grad(set_to_none=True)
                    if arm=='head':logits=cached_logits(model,cn[index[ids]].to(device),en[index[ids]].to(device))
                    else:logits=train_logits(model,{k:v.to(device) for k,v in batch_inputs(ids).items()},en[index[ids]].to(device))
                    loss=r9.loss_for(logits,teacher[index[ids]].to(device),one_hot[ids].to(device),weights[ids].to(device),mask[ids].to(device),protocol,cw)
                    loss.backward();torch.nn.utils.clip_grad_norm_(all_params,1.,foreach=False,error_if_nonfinite=True);optimizer.step()
                    value=float(loss.detach().cpu());assert math.isfinite(value);losses.append(value)
                    if step and step%100==0:print({'phase':'train','arm':arm,'epoch':epoch,'batch':step,'total':len(batches)},flush=True)
                for k,value in frozen_state.items():assert torch.equal(model.state_dict()[k].detach().cpu(),value),'Frozen tensor changed: '+k
                record={'arm':arm,'epoch':epoch,'seconds':time.perf_counter()-tick,'mean_loss':sum(losses)/len(losses),'frozen_tensors_bitwise_unchanged':True}
                print(record,flush=True)
                if epoch in protocol['checkpoints']:
                    path=WORK/f'{arm}-epoch-{epoch}.safetensors'
                    state={n:p.detach().cpu().contiguous() for n,p in model.named_parameters() if p.requires_grad};assert set(state)==trainable
                    assert all(bool(torch.isfinite(v).all()) for v in state.values());save_file(state,str(path));history.append(record|{'weights_sha256':sha(path)})
            del model,optimizer,head_params,encoder_params,all_params,frozen_state
        warning_text=sorted({str(w.message) for w in caught})
    save(WORK/'training-history.json',{'history':history,'warnings':warning_text,'training_seconds':time.perf_counter()-started})
    subprocess.run([str(CPU),'-X','utf8',str(Path(__file__)),'export-all'],cwd=ROOT,check=True)
    records=[read(WORK/f"{h['arm']}-epoch-{h['epoch']}-cal.json")|h for h in history]
    key=lambda h:(h['cal']['minimum_language_noise_recall'],h['cal']['noise_macro_language_recall'],-h['cal']['normal_false_positives'][0],h['arm']=='head',-h['epoch'])
    by_arm={arm:max([h for h in records if h['arm']==arm],key=key) for arm in protocol['arms']};chosen=max(by_arm.values(),key=key)
    save(WORK/'selection.json',{'selected':chosen,'by_arm':by_arm,'history':records,'warnings':warning_text,'total_seconds':time.perf_counter()-started,
        'sealed_at_utc':datetime.now(timezone.utc).isoformat(),'split_hashes':manifest['split_hashes'],'test_opened':False})
    print({'phase':'selected','selected':chosen},flush=True)


def export_all():
    import torch
    import numpy as np
    import onnxruntime as ort
    from onnxruntime.quantization import quantize_dynamic,QuantType
    data,manifest=frozen();torch.set_num_threads(4);torch.set_num_interop_threads(1)
    for arm in manifest['protocol']['arms']:
        for epoch in manifest['protocol']['checkpoints']:
            model,toks,_=build(arm,WORK/f'{arm}-epoch-{epoch}.safetensors');model.eval()
            names=['z_'+n for n in r9.r6.NAMES]+['e_'+n for n in r9.r6.NAMES];inputs=r9.encode(toks,'请检查这个 request。',return_tensors='pt')
            stem=f'{arm}-epoch-{epoch}';full=WORK/(stem+'.onnx');small=WORK/(stem+'-int8.onnx');assert not full.exists()
            torch.onnx.export(model,tuple(inputs[n] for n in names),str(full),input_names=names,output_names=['logits'],dynamic_axes={n:{0:'batch',1:n[:2]+'sequence'} for n in names}|{'logits':{0:'batch'}},opset_version=17,dynamo=False)
            options=ort.SessionOptions();options.intra_op_num_threads=4;options.inter_op_num_threads=1;session=ort.InferenceSession(str(full),options,providers=['CPUExecutionProvider']);drift=0.
            probes=[r['text'] for r in data['cal'][:12]]+['嗯','yes',"console.log('ok')",'法兰球阀 DN50','到付我发现个困扰']
            with torch.no_grad():
                for text in probes:
                    inp=r9.encode(toks,text,return_tensors='pt');a=session.run(None,{n:inp[n].numpy() for n in names})[0];drift=max(drift,float(np.abs(a-model(**inp).numpy()).max()))
            assert drift<.001,drift
            quantize_dynamic(str(full),str(small),weight_type=QuantType.QInt8)
            scores,native,truncated=score(small,data['cal'],stem+'-cal');assert truncated==0
            thresholds,metrics=cal9.calibrated(data['cal'],scores)
            bases=read(WORK/'bases.json');vocab=sum((Path(bases[f'{lang}_folder'])/'vocab.txt').stat().st_size for lang in ['zh','en'])
            record={'arm':arm,'epoch':epoch,'artifact':small.name,'artifact_sha256':sha(small),'artifact_bytes':small.stat().st_size,
                'artifact_and_vocab_bytes':small.stat().st_size+vocab,'thresholds':thresholds,'cal':metrics,'fp32_export_max_drift':drift,'native_version':native['native_version']}
            save(WORK/(stem+'-cal.json'),record);print(record,flush=True)


def evaluate():
    import numpy as np
    data,manifest=frozen();sel=read(WORK/'selection.json');assert not (WORK/'results.json').exists() and sel['split_hashes']==manifest['split_hashes']
    configs={}
    for arm,chosen in sel['by_arm'].items():
        path=WORK/chosen['artifact'];assert sha(path)==chosen['artifact_sha256'];splits={}
        for split,rows in data.items():
            if split in ['train','cal']:continue
            scores,native,truncated=score(path,rows,arm+'-'+split);assert truncated==0
            adjusted=scores-np.array([chosen['thresholds'][r4.language(r['text'])] for r in rows])
            splits[split]={'metrics':r4.measured(rows,adjusted,0.),'p95_ms':native['latency_p95_ms'],
                'predictions':[{'index':i,'label':r['label'],'category':r['category'],'raw_score':float(s),'score':float(a),'warning':bool(a>0)} for i,(r,s,a) in enumerate(zip(rows,scores,adjusted))]}
        configs[arm]={'splits':splits}
    chosen=sel['selected'];current=configs[chosen['arm']]['splits'];g=manifest['protocol']['screen'];actual=current['known_r9_ime']['metrics'];short=current['new_short_test']['metrics'];old=current['fresh_challenge']['metrics'];old425=current['known_round2']['metrics']
    source='女哦就是的感受a到啊删掉asd苏打粉二十个s收到';original=next(p for r,p in zip(data['known_legacy'],current['known_legacy']['predictions']) if r['text']==source)
    gates={'original':original['warning'],'known_actual_noise':actual['noise_detected'][0]>=g['known004_noise_min'],'known_actual_normal':actual['normal_false_positives'][0]<=g['known004_normal_max'],
        'known_actual_context':actual['context_warnings'][0]<=g['known004_context_max'],'short_normal':short['normal_false_positives'][0]<=g['short_normal_max'],'short_context':short['context_warnings'][0]<=g['short_context_max'],
        'public_normal':current['new_public_test']['metrics']['normal_false_positives'][0]<=g['old_public_normal_max'],'old425_normal':old425['normal_false_positives'][0]<=g['old425_normal_max'],
        'old425_noise':old425['noise_detected'][0]>=g['old425_noise_min'],'en_noise':old['noise_languages']['en'][0]>=g['r5_en_noise_min'],'mixed_noise':old['noise_languages']['mixed'][0]>=g['r5_mixed_noise_min'],
        'challenge_normal':old['normal_false_positives'][0]<=g['r5_normal_max'],'size':chosen['artifact_and_vocab_bytes']<=g['budget_bytes'],'latency':current['known_round2']['p95_ms']<=g['native_p95_max_ms']}
    result={'manifest':manifest,'selection':sel,'training':read(WORK/'training-started.json'),'configurations':configs,'original':original,'gates':gates,
        'all_gates_passed':all(gates.values()),'new_prospective_capture_required':all(gates.values()),'new_entropy_consumed':0,'test_role':'known_regression_only'}
    save(WORK/'results.json',result);save(ROOT/'data/semantic-round11-results.json',result)
    print({'selected':chosen['arm'],'gates':gates,'actual':actual,'short':short},flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['prepare','train','export-all','evaluate']);args=p.parse_args();globals()[args.command.replace('-','_')]()
