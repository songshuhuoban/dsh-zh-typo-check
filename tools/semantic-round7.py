"""R3 frozen Chinese classifier + English RTD features, residual-only training."""
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

ROOT=Path(__file__).resolve().parents[1];WORK=ROOT/'.research/semantic-round7'
CPU=ROOT/'.research/semantic-screen-venv/Scripts/python.exe'
spec=importlib.util.spec_from_file_location('r6',ROOT/'tools/semantic-round6.py')
r6=importlib.util.module_from_spec(spec);spec.loader.exec_module(r6)
r4=r6.r4;read,save,sha=r6.read,r6.save,r6.sha


def prepare():
    assert not (WORK/'manifest.json').exists();WORK.mkdir(exist_ok=True)
    source=ROOT/'.research/semantic-round5';data=read(source/'prepared.json');old=read(source/'manifest.json')
    assert all(r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True))==old['split_hashes'][s] for s,rows in data.items())
    r6data,r6manifest=r6.frozen();assert data==r6data
    data['known_round6_ime']=read(r6.WORK/'prospective-ime-prepared.json')['rows']
    hashes={s:r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True)) for s,rows in data.items()}
    manifest={'created_at_utc':datetime.now(timezone.utc).isoformat(),'split_hashes':hashes,
        'source_hashes':{'r3_weights':sha(ROOT/'.research/semantic-directml/model.safetensors'),
            'r5_cache':sha(source/'train-features.safetensors'),'r6_cache':sha(r6.WORK/'train-features.safetensors'),
            'r5_manifest':sha(source/'manifest.json'),'r6_manifest':sha(r6.WORK/'manifest.json')},
        'protocol':{'epochs':10,'checkpoints':[1,3,10],'distillation_weights':[.5,2.],
            'distillation_temperature':2.,'residual_l2_weight':.001,'batch_size':128,'learning_rate':.001,
            'seed':20261112,'class_weights':[1.5,1.,1.5],'feature_dimension':1036,
            'distillation_mask':'R3 original TRAIN normal/context only; no teacher constraint on noise',
            'frozen':'R3 encoder/head and original English ELECTRA encoder/RTD head; residual starts at zero',
            'threshold':'Same R6 per-language normal99%/each-normal-category99%/max-context/min0; strict >',
            'selection':'CAL max macro-language noise recall, min normal FP, lower distillation weight, earlier epoch',
            'model_and_vocab_budget_bytes':50_000_000,'prior_tests_role':'known_regression',
            'prospective_test':'40 actual IME outputs after seal; physical entropy starts86016; label before score'},
        'label_caveat':old['label_caveat']}
    save(WORK/'bases.json',read(r6.WORK/'bases.json'));save(WORK/'prepared.json',data);save(WORK/'manifest.json',manifest)
    print(json.dumps({'phase':'prepared','train':len(data['train']),'cal':len(data['cal'])}),flush=True)


def frozen():
    data,manifest=read(WORK/'prepared.json'),read(WORK/'manifest.json')
    for s,rows in data.items():assert r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True))==manifest['split_hashes'][s]
    assert sha(ROOT/'.research/semantic-directml/model.safetensors')==manifest['source_hashes']['r3_weights']
    assert sha(ROOT/'.research/semantic-round5/train-features.safetensors')==manifest['source_hashes']['r5_cache']
    assert sha(r6.WORK/'train-features.safetensors')==manifest['source_hashes']['r6_cache']
    bases=read(WORK/'bases.json');assert sha(r6.WORK/'en-pretrained.safetensors')==bases['en_sha256']
    return data,manifest


def build():
    import torch
    from safetensors.torch import load_file
    base,_=r4.model_and_tokenizer();state=load_file(str(ROOT/'.research/semantic-directml/model.safetensors'))
    missing,extra=base.load_state_dict(state,strict=False);assert set(missing)=={'aux.weight','aux.bias'} and not extra
    del base.aux;base.requires_grad_(False)
    english,toks=r6.build('dual');del english.bases['zh'];english.head=torch.nn.Identity();english.requires_grad_(False)
    class Residual(torch.nn.Module):
        def __init__(self):
            super().__init__();self.chinese=base;self.english=english
            self.register_buffer('center',torch.zeros(1036));self.register_buffer('scale',torch.ones(1036))
            self.residual=torch.nn.Sequential(torch.nn.Linear(1036,128),torch.nn.GELU(),torch.nn.Dropout(.1),torch.nn.Linear(128,3))
            torch.nn.init.zeros_(self.residual[3].weight);torch.nn.init.zeros_(self.residual[3].bias)
        def features(self,z_input_ids,z_attention_mask,z_token_type_ids,e_input_ids,e_attention_mask,e_token_type_ids):
            cn=self.chinese.features(input_ids=z_input_ids,attention_mask=z_attention_mask,token_type_ids=z_token_type_ids)
            en=self.english.features_one('en',input_ids=e_input_ids,attention_mask=e_attention_mask,token_type_ids=e_token_type_ids)
            return torch.cat([cn,en],1),self.chinese.head(cn)
        def forward(self,z_input_ids,z_attention_mask,z_token_type_ids,e_input_ids,e_attention_mask,e_token_type_ids):
            features,base=self.features(z_input_ids,z_attention_mask,z_token_type_ids,e_input_ids,e_attention_mask,e_token_type_ids)
            return base+self.residual(((features-self.center)/self.scale).clamp(-10,10))
    return Residual(),toks


def encode(toks,texts,**kwargs):
    return {('z_' if lang=='zh' else 'e_')+n:v for lang,tok in toks.items() for n,v in tok(texts,**kwargs).items()}


def score(path,rows,name):
    original=r6.WORK
    try:
        r6.WORK=WORK
        return r6.node_scores(path,rows,name,'dual')
    finally:r6.WORK=original


def loss_for(delta,base,one_hot,weights,distill,protocol,strength,class_weights):
    import torch
    from semantic_device_loss import classification_nll
    temp=protocol['distillation_temperature'];logits=base+delta
    ce=classification_nll(logits,one_hot,class_weights)
    teacher=-(torch.nn.functional.softmax(base/temp,dim=-1)*torch.nn.functional.log_softmax(logits/temp,dim=-1)).sum(-1)*temp*temp
    return ((ce+strength*teacher*distill)*weights).mean()+protocol['residual_l2_weight']*delta.square().mean()


def train():
    import torch
    import torch_directml
    from safetensors.torch import load_file,save_file
    from semantic_device_optim import PortableAdamW
    data,manifest=frozen();assert not (WORK/'training-started.json').exists()
    proof=read(ROOT/'data/semantic-directml-gradient-check.json')
    assert sha(ROOT/'tools/semantic_device_loss.py')==proof['loss_helper_sha256'] and proof['corrected_manual_path']['ok']
    torch.set_num_threads(4);torch.set_num_interop_threads(1);protocol=manifest['protocol'];torch.manual_seed(protocol['seed'])
    device=torch_directml.device(0);assert '780M' in torch_directml.device_name(0)
    r5=load_file(str(ROOT/'.research/semantic-round5/train-features.safetensors'))
    rtd=load_file(str(r6.WORK/'train-features.safetensors'))
    features=torch.cat([r5['features'],rtd['features'][:,524:]],1);base_logits=r5['base_logits']
    unique={};index=[];texts=[];rows=data['train']
    for row in rows:
        key=r4.r2.canonical(row['text'])
        if key not in unique:unique[key]=len(texts);texts.append(key)
        index.append(unique[key])
    assert features.shape==(len(texts),1036) and base_logits.shape==(len(texts),3)
    assert torch.isfinite(features).all() and torch.isfinite(base_logits).all()
    model,toks=build();model.eval();inp=encode(toks,texts[:6],padding=True,return_tensors='pt')
    with torch.no_grad():cpu_features,cpu_base=model.features(**inp);initial=model(**inp)
    cached_feature_error=float((features[:6]-cpu_features).abs().max());cached_base_error=float((base_logits[:6]-cpu_base).abs().max())
    assert max(cached_feature_error,cached_base_error)<.001 and torch.equal(initial,cpu_base)
    model.to(device)
    with torch.no_grad():gpu_features,gpu_base=model.features(**{k:v.to(device) for k,v in inp.items()})
    feature_error=float((gpu_features.cpu()-cpu_features).abs().max());assert feature_error<.001
    center=features.mean(0);scale=features.std(0).clamp_min(.001);values=((features-center)/scale).clamp(-10,10)
    index=torch.tensor(index);one_hot=torch.nn.functional.one_hot(torch.tensor([r['label'] for r in rows]),3).float()
    weights=torch.tensor([r['weight'] for r in rows]);distill=torch.tensor([r['distill']*float(r['label']!=1) for r in rows]);cw=torch.tensor(protocol['class_weights'])
    started=time.perf_counter();history=[];checks=[]
    save(WORK/'training-started.json',{'created_at_utc':datetime.now(timezone.utc).isoformat(),'manifest_sha256':sha(WORK/'manifest.json'),
        'torch':torch.__version__,'device':torch_directml.device_name(0).rstrip('\x00'),'initial_residual_exact_zero':True,
        'cached_feature_error':cached_feature_error,'cached_base_error':cached_base_error,'cpu_gpu_features_max_error':feature_error,
        'code_sha256':{p.name:sha(p) for p in [Path(__file__),ROOT/'tools/semantic_device_loss.py',ROOT/'tools/semantic_device_optim.py']}})
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        for strength in protocol['distillation_weights']:
            torch.manual_seed(protocol['seed']);head=torch.nn.Sequential(torch.nn.Linear(1036,128),torch.nn.GELU(),torch.nn.Dropout(.1),torch.nn.Linear(128,3))
            torch.nn.init.zeros_(head[3].weight);torch.nn.init.zeros_(head[3].bias)
            a=copy.deepcopy(head).eval()
            with torch.no_grad():a[3].weight.normal_(std=.01)
            b=copy.deepcopy(a).to(device);ids=torch.tensor([next(i for i,r in enumerate(rows) if r['label']==label) for label in [0,1,2]])
            losses=[]
            for h,d in [(a,torch.device('cpu')),(b,device)]:
                loss=loss_for(h(values[index[ids]].to(d)),base_logits[index[ids]].to(d),one_hot[ids].to(d),weights[ids].to(d),distill[ids].to(d),protocol,strength,cw.to(d))
                loss.backward();losses.append(float(loss.detach().cpu()))
            error=max(float((x.grad-y.grad.cpu()).abs().max()) for x,y in zip(a.parameters(),b.parameters()))
            assert error<1e-4 and abs(losses[0]-losses[1])<1e-4
            checks.append({'strength':strength,'max_gradient_error':error,'loss_cpu_gpu':losses})
            head.to(device);optimizer=PortableAdamW(head.parameters(),lr=protocol['learning_rate']);tag='d05' if strength==.5 else 'd20'
            for epoch in range(1,protocol['epochs']+1):
                head.train();losses=[];tick=time.perf_counter()
                for ids in torch.randperm(len(rows)).split(protocol['batch_size']):
                    optimizer.zero_grad(set_to_none=True);delta=head(values[index[ids]].to(device))
                    loss=loss_for(delta,base_logits[index[ids]].to(device),one_hot[ids].to(device),weights[ids].to(device),distill[ids].to(device),protocol,strength,cw.to(device))
                    loss.backward();torch.nn.utils.clip_grad_norm_(head.parameters(),1.,foreach=False,error_if_nonfinite=True);optimizer.step()
                    val=float(loss.detach().cpu());assert math.isfinite(val);losses.append(val)
                training={'epoch':epoch,'strength':strength,'tag':tag,'seconds':time.perf_counter()-tick,'loss':sum(losses)/len(losses)}
                print(json.dumps({'phase':'head-train',**training}),flush=True)
                if epoch in protocol['checkpoints']:
                    state={'residual.'+k:v.detach().cpu().contiguous() for k,v in head.state_dict().items()};state.update(center=center,scale=scale)
                    path=WORK/f'{tag}-epoch-{epoch}-head.safetensors';save_file(state,str(path))
                    subprocess.run([str(CPU),'-X','utf8',str(Path(__file__)),'export','--epoch',str(epoch),'--tag',tag],cwd=ROOT,check=True)
                    history.append(read(WORK/f'{tag}-epoch-{epoch}-cal.json')|training|{'head_sha256':sha(path)})
        warning_text=sorted({str(w.message) for w in caught})
    chosen=max(history,key=lambda h:(h['cal']['noise_macro_language_recall'],-h['cal']['normal_false_positives'][0],-h['strength'],-h['epoch']))
    assert chosen['artifact_and_vocab_bytes']<=protocol['model_and_vocab_budget_bytes']
    save(WORK/'selection.json',{'selected':chosen,'history':history,'warnings':warning_text,'gradient_checks':checks,
        'split_hashes':manifest['split_hashes'],'total_seconds':time.perf_counter()-started,
        'sealed_at_utc':datetime.now(timezone.utc).isoformat(),'test_opened':False})
    print(json.dumps({'phase':'selected','selected':chosen,'warnings':warning_text}),flush=True)


def export(tag,epoch):
    import numpy as np
    import torch
    import onnxruntime as ort
    from onnxruntime.quantization import quantize_dynamic,QuantType
    from safetensors.torch import load_file
    data,manifest=frozen();torch.set_num_threads(4);torch.set_num_interop_threads(1)
    model,toks=build();missing,extra=model.load_state_dict(load_file(str(WORK/f'{tag}-epoch-{epoch}-head.safetensors')),strict=False)
    assert not extra and all(k.startswith(('chinese.','english.')) for k in missing);model.eval()
    names=['z_'+n for n in r6.NAMES]+['e_'+n for n in r6.NAMES];inputs=encode(toks,'请检查这个 request。',return_tensors='pt')
    stem=f'{tag}-epoch-{epoch}';full=WORK/(stem+'.onnx');small=WORK/(stem+'-int8.onnx');assert not full.exists()
    torch.onnx.export(model,tuple(inputs[n] for n in names),str(full),input_names=names,output_names=['logits'],
        dynamic_axes={n:{0:'batch',1:n[:2]+'sequence'} for n in names}|{'logits':{0:'batch'}},opset_version=17,dynamo=False)
    opt=ort.SessionOptions();opt.intra_op_num_threads=4;opt.inter_op_num_threads=1
    session=ort.InferenceSession(str(full),opt,providers=['CPUExecutionProvider']);drift=0.
    with torch.no_grad():
        for row in data['cal'][:12]:
            inp=encode(toks,row['text'],return_tensors='pt');a=session.run(None,{n:inp[n].numpy() for n in names})[0]
            drift=max(drift,float(np.abs(a-model(**inp).numpy()).max()))
    assert drift<.001,drift
    quantize_dynamic(str(full),str(small),weight_type=QuantType.QInt8)
    scores,native,truncated=score(small,data['cal'],stem+'-cal');assert truncated==0
    thresholds={}
    for lang in ['en','zh','mixed']:
        ids=[i for i,r in enumerate(data['cal']) if r4.language(r['text'])==lang]
        thresholds[lang]=r6.operating_point([data['cal'][i] for i in ids],scores[ids])
    adjusted=scores-np.array([thresholds[r4.language(r['text'])] for r in data['cal']])
    bases=read(WORK/'bases.json');vocab=sum((Path(bases[f'{lang}_folder'])/'vocab.txt').stat().st_size for lang in ['zh','en'])
    record={'epoch':epoch,'tag':tag,'artifact':small.name,'artifact_sha256':sha(small),'artifact_bytes':small.stat().st_size,
        'artifact_and_vocab_bytes':small.stat().st_size+vocab,'thresholds':thresholds,'cal':r4.measured(data['cal'],adjusted,0.),
        'fp32_export_max_drift':drift,'native_version':native['native_version'],'truncated_encoder_inputs':truncated}
    save(WORK/(stem+'-cal.json'),record);print(json.dumps(record),flush=True)


def evaluate():
    import numpy as np
    assert not (WORK/'results.json').exists();data,manifest=frozen();sel=read(WORK/'selection.json');chosen=sel['selected']
    path=WORK/chosen['artifact'];assert sha(path)==chosen['artifact_sha256'] and manifest['split_hashes']==sel['split_hashes']
    out={'manifest':manifest,'selection':sel,'training':read(WORK/'training-started.json'),'splits':{}}
    for split in ['fresh_challenge','new_challenge','new_public_test','known_ime','known_round2','known_legacy','known_round6_ime']:
        scores,native,truncated=score(path,data[split],split)
        adjusted=scores-np.array([chosen['thresholds'][r4.language(r['text'])] for r in data[split]])
        out['splits'][split]={'metrics':r4.measured(data[split],adjusted,0.),'p95_ms':native['latency_p95_ms'],
            'truncated_encoder_inputs':truncated,'predictions':[{'index':i,'label':r['label'],'category':r['category'],
                'raw_score':float(s),'score':float(a),'warning':bool(a>0)} for i,(r,s,a) in enumerate(zip(data[split],scores,adjusted))]}
    save(WORK/'results.json',out);print(json.dumps({s:v['metrics'] for s,v in out['splits'].items()}),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['prepare','train','export','evaluate'])
    p.add_argument('--tag',choices=['d05','d20']);p.add_argument('--epoch',type=int,choices=[1,3,10]);args=p.parse_args()
    if args.command=='export':assert args.tag and args.epoch;export(args.tag,args.epoch)
    else:globals()[args.command]()
