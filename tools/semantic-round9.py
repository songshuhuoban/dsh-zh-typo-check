"""R6 MLP warm-start with reviewed target data; fixed backbones, expanded CAL."""
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

ROOT=Path(__file__).resolve().parents[1];WORK=ROOT/'.research/semantic-round9'
CPU=ROOT/'.research/semantic-screen-venv/Scripts/python.exe'
spec=importlib.util.spec_from_file_location('r6',ROOT/'tools/semantic-round6.py')
r6=importlib.util.module_from_spec(spec);spec.loader.exec_module(r6)
r4=r6.r4;read,save,sha=r6.read,r6.save,r6.sha


def frozen():
    data,manifest=read(WORK/'prepared.json'),read(WORK/'manifest.json')
    for s,rows in data.items():assert r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True))==manifest['split_hashes'][s]
    assert sha(r6.WORK/'train-features.safetensors')==manifest['source_hashes']['r6_features']
    assert sha(ROOT/'data/semantic-round9-public-labels.json')==manifest['source_hashes']['public_labels']
    assert sha(ROOT/'data/mixed-semantic-round9-seeds.json')==manifest['source_hashes']['authored_seeds']
    for lang in ['zh','en']:assert sha(r6.WORK/f'{lang}-pretrained.safetensors')==read(WORK/'bases.json')[f'{lang}_sha256']
    return data,manifest


def build(head_path=None):
    from safetensors.torch import load_file
    model,toks=r6.build('dual')
    if head_path is None:
        manifest=read(WORK/'manifest.json');head_path=r6.WORK/f"dual-epoch-{manifest['initial']['epoch']}-head.safetensors"
        assert sha(head_path)==manifest['source_hashes']['r6_head']
    missing,extra=model.load_state_dict(load_file(str(head_path)),strict=False)
    assert not extra and all(k.startswith('bases.') for k in missing)
    return model,toks


def encode(toks,texts,**kwargs):
    return {('z_' if lang=='zh' else 'e_')+n:v for lang,tok in toks.items() for n,v in tok(texts,**kwargs).items()}


def score(path,rows,name):
    original=r6.WORK
    try:r6.WORK=WORK;return r6.node_scores(path,rows,name,'dual')
    finally:r6.WORK=original


def calibrate(rows,scores):
    import numpy as np
    thresholds={}
    for lang in ['en','zh','mixed']:
        ids=[i for i,r in enumerate(rows) if r4.language(r['text'])==lang]
        thresholds[lang]=r6.operating_point([rows[i] for i in ids],scores[ids])
    adjusted=scores-np.array([thresholds[r4.language(r['text'])] for r in rows])
    measured=r4.measured(rows,adjusted,0.)
    recall=[v[0]/v[1] for v in measured['noise_languages'].values() if v[1]]
    measured['minimum_language_noise_recall']=min(recall)
    return thresholds,measured


def loss_for(logits,teacher,one_hot,weights,mask,protocol,class_weights):
    import torch
    from semantic_device_loss import classification_nll
    temp=protocol['teacher_temperature']
    ce=classification_nll(logits,one_hot,class_weights)
    soft=-(torch.nn.functional.softmax(teacher/temp,dim=-1)*torch.nn.functional.log_softmax(logits/temp,dim=-1)).sum(-1)*temp*temp
    return ((ce+protocol['teacher_weight']*soft*mask)*weights).mean()


def train():
    import torch
    import torch_directml
    from safetensors.torch import load_file,save_file
    from semantic_device_optim import PortableAdamW
    data,manifest=frozen();protocol=manifest['protocol'];assert not (WORK/'training-started.json').exists()
    proof=read(ROOT/'data/semantic-directml-gradient-check.json')
    assert sha(ROOT/'tools/semantic_device_loss.py')==proof['loss_helper_sha256'] and proof['corrected_manual_path']['ok']
    torch.set_num_threads(4);torch.set_num_interop_threads(1);torch.manual_seed(protocol['seed'])
    device=torch_directml.device(0);assert '780M' in torch_directml.device_name(0)
    model,toks=build();model.eval()
    check_texts=['呃','yes','法兰球阀 DN50','请检查这个 request。','到付我发现个困扰']
    probe={lang:dict(tok(check_texts,padding=True,return_tensors='pt')) for lang,tok in toks.items()}
    with torch.no_grad():reference=model.features(probe)
    model.to(device)
    with torch.no_grad():actual=model.features({lang:{k:v.to(device) for k,v in inp.items()} for lang,inp in probe.items()}).cpu()
    feature_error=float((actual-reference).abs().max());assert feature_error<.001,feature_error
    rows=data['train'];unique={};texts=[];index=[]
    for r in rows:
        key=r4.r2.canonical(r['text'])
        if key not in unique:unique[key]=len(texts);texts.append(key)
        index.append(unique[key])
    old=read(r6.WORK/'prepared.json')['train'];old_texts=list(dict.fromkeys(r4.r2.canonical(r['text']) for r in old))
    assert texts[:len(old_texts)]==old_texts
    old_cache=load_file(str(r6.WORK/'train-features.safetensors'))['features']
    assert old_cache.shape==(len(old_texts),1048)
    features=torch.empty((len(texts),1048));features[:len(old_texts)]=old_cache
    started=time.perf_counter()
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        with torch.no_grad():
            for start in range(len(old_texts),len(texts),32):
                inputs={lang:{k:v.to(device) for k,v in tok(texts[start:start+32],padding=True,truncation=True,max_length=128,return_tensors='pt').items()} for lang,tok in toks.items()}
                value=model.features(inputs);features[start:start+len(value)]=value.cpu()
            assert torch.isfinite(features).all()
            teacher_head=copy.deepcopy(model.head).cpu().eval();center=model.center.cpu();scale=model.scale.cpu()
            normalized=((features-center)/scale).clamp(-10,10)
            teacher_logits=torch.cat([teacher_head(x) for x in normalized.split(256)]).detach()
        save_file({'features':features,'teacher_logits':teacher_logits},str(WORK/'train-features.safetensors'),metadata={'train_sha256':manifest['split_hashes']['train']})
        head=copy.deepcopy(teacher_head);a=copy.deepcopy(head).eval();b=copy.deepcopy(a).to(device)
        one_hot=torch.nn.functional.one_hot(torch.tensor([r['label'] for r in rows]),3).float()
        weights=torch.tensor([r['weight'] for r in rows]);teacher_mask=torch.tensor([r['teacher'] for r in rows]);indices=torch.tensor(index)
        cw=torch.tensor(protocol['class_weights']);ids=torch.tensor([next(i for i,r in enumerate(rows) if r['label']==label and bool(r['teacher'])==is_old) for is_old in [True,False] for label in [0,1,2]])
        losses=[]
        for h,d in [(a,torch.device('cpu')),(b,device)]:
            loss=loss_for(h(normalized[indices[ids]].to(d)),teacher_logits[indices[ids]].to(d),one_hot[ids].to(d),weights[ids].to(d),teacher_mask[ids].to(d),protocol,cw.to(d))
            loss.backward();losses.append(float(loss.detach().cpu()))
        abs_error=max(float((x.grad-y.grad.cpu()).abs().max()) for x,y in zip(a.parameters(),b.parameters()))
        g1=torch.cat([p.grad.flatten() for p in a.parameters()]);g2=torch.cat([p.grad.cpu().flatten() for p in b.parameters()])
        relative=float((g1-g2).norm()/g1.norm());cosine=float(torch.nn.functional.cosine_similarity(g1,g2,dim=0))
        assert abs_error<1e-4 and relative<.001 and cosine>.99999 and abs(losses[0]-losses[1])<1e-4
        record={'created_at_utc':datetime.now(timezone.utc).isoformat(),'manifest_sha256':sha(WORK/'manifest.json'),'device':torch_directml.device_name(0).rstrip('\x00'),
            'torch':torch.__version__,'warm_start_head_sha256':manifest['source_hashes']['r6_head'],'frozen_base':True,'trainable_parameters':sum(p.numel() for p in head.parameters()),
            'cpu_gpu_features_max_error':feature_error,'gradient_preflight':{'losses_cpu_gpu':losses,'max_abs_error':abs_error,'relative_l2_error':relative,'cosine':cosine},
            'cached_old_features_reused':len(old_texts),'new_features_computed':len(texts)-len(old_texts),
            'code_sha256':{p.name:sha(p) for p in [Path(__file__),ROOT/'tools/semantic_device_loss.py',ROOT/'tools/semantic_device_optim.py']}}
        save(WORK/'training-started.json',record)
        del model,actual,reference
        # Baseline is recalibrated on the exact same expanded CAL before any TEST.
        subprocess.run([str(CPU),'-X','utf8',str(Path(__file__)),'baseline'],cwd=ROOT,check=True)
        head.to(device);optimizer=PortableAdamW(head.parameters(),lr=protocol['learning_rate']);history=[]
        for epoch in range(1,protocol['epochs']+1):
            head.train();losses=[];tick=time.perf_counter()
            for ids in torch.randperm(len(rows)).split(protocol['batch_size']):
                optimizer.zero_grad(set_to_none=True)
                logits=head(normalized[indices[ids]].to(device))
                loss=loss_for(logits,teacher_logits[indices[ids]].to(device),one_hot[ids].to(device),weights[ids].to(device),teacher_mask[ids].to(device),protocol,cw.to(device))
                loss.backward();torch.nn.utils.clip_grad_norm_(head.parameters(),1.,foreach=False,error_if_nonfinite=True);optimizer.step()
                val=float(loss.detach().cpu());assert math.isfinite(val);losses.append(val)
            training={'epoch':epoch,'head_seconds':time.perf_counter()-tick,'mean_loss':sum(losses)/len(losses)}
            print(json.dumps({'phase':'head-train',**training}),flush=True)
            if epoch in protocol['checkpoints']:
                state={'head.'+k:v.detach().cpu().contiguous() for k,v in head.state_dict().items()};state.update(center=center,scale=scale)
                path=WORK/f'epoch-{epoch}-head.safetensors';save_file(state,str(path))
                subprocess.run([str(CPU),'-X','utf8',str(Path(__file__)),'export','--epoch',str(epoch)],cwd=ROOT,check=True)
                history.append(read(WORK/f'epoch-{epoch}-cal.json')|training|{'head_sha256':sha(path)})
        warning_text=sorted({str(w.message) for w in caught})
    chosen=max(history,key=lambda h:(h['cal']['minimum_language_noise_recall'],h['cal']['noise_macro_language_recall'],-h['cal']['normal_false_positives'][0],-h['epoch']))
    assert chosen['artifact_and_vocab_bytes']<=protocol['budget_bytes']
    save(WORK/'selection.json',{'selected':chosen,'history':history,'warnings':warning_text,'total_seconds':time.perf_counter()-started,
        'split_hashes':manifest['split_hashes'],'sealed_at_utc':datetime.now(timezone.utc).isoformat(),'test_opened':False,
        'baseline_recalibrated':read(WORK/'baseline-cal.json')})
    print(json.dumps({'phase':'selected','selected':chosen,'warnings':warning_text}),flush=True)


def baseline():
    data,manifest=frozen();assert not (WORK/'baseline-cal.json').exists()
    path=r6.WORK/manifest['initial']['artifact'];assert sha(path)==manifest['initial']['artifact_sha256']
    scores,native,truncated=score(path,data['cal'],'baseline-cal');assert truncated==0
    thresholds,metrics=calibrate(data['cal'],scores)
    save(WORK/'baseline-cal.json',{'artifact_sha256':sha(path),'thresholds':thresholds,'cal':metrics,'native_version':native['native_version']})


def export(epoch):
    import numpy as np
    import torch
    import onnxruntime as ort
    from onnxruntime.quantization import quantize_dynamic,QuantType
    data,manifest=frozen();torch.set_num_threads(4);torch.set_num_interop_threads(1)
    model,toks=build(WORK/f'epoch-{epoch}-head.safetensors');model.eval()
    names=['z_'+n for n in r6.NAMES]+['e_'+n for n in r6.NAMES];inputs=encode(toks,'请检查这个 request。',return_tensors='pt')
    full=WORK/f'epoch-{epoch}.onnx';small=WORK/f'epoch-{epoch}-int8.onnx';assert not full.exists()
    torch.onnx.export(model,tuple(inputs[n] for n in names),str(full),input_names=names,output_names=['logits'],
        dynamic_axes={n:{0:'batch',1:n[:2]+'sequence'} for n in names}|{'logits':{0:'batch'}},opset_version=17,dynamo=False)
    opt=ort.SessionOptions();opt.intra_op_num_threads=4;opt.inter_op_num_threads=1
    session=ort.InferenceSession(str(full),opt,providers=['CPUExecutionProvider']);drift=0.
    probes=[r['text'] for r in data['cal'][:12]]+['嗯','yes','no',"console.log('ok')",'法兰球阀 DN50','到付我发现个困扰']
    with torch.no_grad():
        for text in probes:
            inp=encode(toks,text,return_tensors='pt');a=session.run(None,{n:inp[n].numpy() for n in names})[0]
            drift=max(drift,float(np.abs(a-model(**inp).numpy()).max()))
    assert drift<.001,drift
    quantize_dynamic(str(full),str(small),weight_type=QuantType.QInt8)
    scores,native,truncated=score(small,data['cal'],f'epoch-{epoch}-cal');assert truncated==0
    thresholds,metrics=calibrate(data['cal'],scores)
    bases=read(WORK/'bases.json');vocab=sum((Path(bases[f'{lang}_folder'])/'vocab.txt').stat().st_size for lang in ['zh','en'])
    record={'epoch':epoch,'artifact':small.name,'artifact_sha256':sha(small),'artifact_bytes':small.stat().st_size,
        'artifact_and_vocab_bytes':small.stat().st_size+vocab,'thresholds':thresholds,'cal':metrics,
        'fp32_export_max_drift':drift,'native_version':native['native_version'],'truncated_encoder_inputs':truncated}
    save(WORK/f'epoch-{epoch}-cal.json',record);print(json.dumps(record),flush=True)


def evaluate():
    import numpy as np
    data,manifest=frozen();sel=read(WORK/'selection.json');chosen=sel['selected'];assert not (WORK/'results.json').exists()
    path=WORK/chosen['artifact'];assert sha(path)==chosen['artifact_sha256'] and sel['split_hashes']==manifest['split_hashes']
    old=manifest['initial'];baseline_path=r6.WORK/old['artifact'];result={'manifest':manifest,'selection':sel,'training':read(WORK/'training-started.json'),'configurations':{n:{'splits':{}} for n in ['r6_original','r6_recalibrated','round9']}}
    for split in ['new_short_test','fresh_challenge','new_challenge','new_public_test','known_ime','known_round2','known_legacy']:
        first,native_first,truncated=score(baseline_path,data[split],'baseline-'+split);assert truncated==0
        second,native_second,truncated=score(path,data[split],'round9-'+split);assert truncated==0
        for name,scores,native,cutoffs in [('r6_original',first,native_first,old['thresholds']),('r6_recalibrated',first,native_first,sel['baseline_recalibrated']['thresholds']),('round9',second,native_second,chosen['thresholds'])]:
            adjusted=scores-np.array([cutoffs[r4.language(r['text'])] for r in data[split]])
            result['configurations'][name]['splits'][split]={'metrics':r4.measured(data[split],adjusted,0.),'p95_ms':native['latency_p95_ms'],
                'predictions':[{'index':i,'label':r['label'],'category':r['category'],'group':r.get('group',f'{split}-{i}'),
                    'raw_score':float(s),'score':float(a),'warning':bool(a>0)} for i,(r,s,a) in enumerate(zip(data[split],scores,adjusted))]}
    save(WORK/'results.json',result)
    print(json.dumps({n:{s:c['metrics'] for s,c in o['splits'].items()} for n,o in result['configurations'].items()}),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['train','baseline','export','evaluate']);p.add_argument('--epoch',type=int,choices=[1,3,6]);args=p.parse_args()
    if args.command=='export':assert args.epoch;export(args.epoch)
    else:globals()[args.command]()
