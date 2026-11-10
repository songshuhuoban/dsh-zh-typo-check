"""Frozen original ELECTRA RTD heads: whole-input Chinese vs dual-language probe.

Training and CAL choose checkpoints; all earlier tests are known regressions.
"""
from __future__ import annotations
import argparse
import copy
from datetime import datetime, timezone
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import time
import warnings

ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/'.research/semantic-round6'
CPU=ROOT/'.research/semantic-screen-venv/Scripts/python.exe'
spec=importlib.util.spec_from_file_location('r4',ROOT/'tools/semantic-round4.py')
r4=importlib.util.module_from_spec(spec);spec.loader.exec_module(r4)
read,save,sha=r4.read,r4.save,r4.sha
NAMES=['input_ids','attention_mask','token_type_ids']


def prepare():
    assert not (WORK/'manifest.json').exists()
    source=ROOT/'.research/semantic-round5'
    data=read(source/'prepared.json');old=read(source/'manifest.json');bases=read(WORK/'bases.json')
    for split,rows in data.items():
        assert r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True))==old['split_hashes'][split]
    manifest={'created_at_utc':datetime.now(timezone.utc).isoformat(),'split_hashes':old['split_hashes'],
        'counts':old['counts'],'source_manifest_sha256':sha(source/'manifest.json'),'bases':bases,
        'protocol':{'epochs':10,'checkpoints':[1,3,10],'batch_size':128,'learning_rate':.001,
            'class_weights':[1.5,1.,1.5],'seed':20261111,'feature_dimension_per_model':524,
            'frozen':'Original pretrained encoder AND original replaced-token discriminator head',
            'head':'Train-only standardized and clipped features; Linear->128 GELU Dropout(.1) Linear->3',
            'threshold':'Within en/zh/mixed: max(0, normal99%-higher, each normal category99%-higher, max context); strict >',
            'selection':'CAL max language-macro noise recall, min normal FP, earliest checkpoint; budget tie prefers smaller',
            'assumed_model_and_vocab_budget_bytes':50_000_000,'prior_tests_role':'known_regression',
            'new_ime_test':'40 prospective actual Notepad one-Space outputs; physical bits start73728; label before scoring'},
        'label_caveat':old['label_caveat'],'data_note':'Same R5 rows, no new training data or CSED auxiliary loss.'}
    for lang in ['zh','en']:assert sha(WORK/f'{lang}-pretrained.safetensors')==bases[f'{lang}_sha256']
    save(WORK/'prepared.json',data);save(WORK/'manifest.json',manifest)
    print(json.dumps({'phase':'prepared','counts':manifest['counts']}),flush=True)


def frozen():
    data,manifest=read(WORK/'prepared.json'),read(WORK/'manifest.json')
    for split,rows in data.items():assert r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True))==manifest['split_hashes'][split]
    for lang in ['zh','en']:assert sha(WORK/f'{lang}-pretrained.safetensors')==manifest['bases'][f'{lang}_sha256']
    return data,manifest


def tokenizers(mode):
    from transformers import AutoTokenizer
    bases=read(WORK/'bases.json')
    return {lang:AutoTokenizer.from_pretrained(bases[f'{lang}_folder'],local_files_only=True,trust_remote_code=False)
            for lang in (['zh'] if mode=='zh' else ['zh','en'])}


def build(mode):
    import torch
    from transformers import AutoConfig,AutoModelForPreTraining
    from safetensors.torch import load_file
    bases=read(WORK/'bases.json');langs=['zh'] if mode=='zh' else ['zh','en']
    class Probe(torch.nn.Module):
        def __init__(self):
            super().__init__();self.bases=torch.nn.ModuleDict()
            for lang in langs:
                cfg=AutoConfig.from_pretrained(bases[f'{lang}_folder'],local_files_only=True,trust_remote_code=False)
                cfg._attn_implementation='eager'
                base=AutoModelForPreTraining.from_config(cfg,trust_remote_code=False)
                base.load_state_dict(load_file(str(WORK/f'{lang}-pretrained.safetensors')),strict=True)
                base.requires_grad_(False);base.eval();self.bases[lang]=base
            dim=524*len(langs)
            self.register_buffer('center',torch.zeros(dim));self.register_buffer('scale',torch.ones(dim))
            self.head=torch.nn.Sequential(torch.nn.Linear(dim,128),torch.nn.GELU(),torch.nn.Dropout(.1),torch.nn.Linear(128,3))
        def features_one(self,lang,input_ids,attention_mask,token_type_ids):
            base=self.bases[lang]
            h=base.electra(input_ids=input_ids,attention_mask=attention_mask,token_type_ids=token_type_ids).last_hidden_state
            logits=base.discriminator_predictions(h)
            mask=(attention_mask.bool() & (input_ids!=101) & (input_ids!=102)).to(h.dtype)
            n=mask.sum(1).clamp_min(1);p=logits.sigmoid()
            mean=(logits*mask).sum(1)/n;mp=(p*mask).sum(1)/n
            stats=torch.stack([mean,((logits.square()*mask).sum(1)/n-mean.square()).clamp_min(0).sqrt(),
                (logits*mask-100*(1-mask)).max(1).values,(logits*mask+100*(1-mask)).min(1).values,
                mp,((p.square()*mask).sum(1)/n-mp.square()).clamp_min(0).sqrt(),(p*mask).max(1).values,
                ((p>.5)*mask).sum(1)/n,((p>.8)*mask).sum(1)/n,((p>.95)*mask).sum(1)/n,
                n.log1p(),((input_ids==100)*mask).sum(1)/n],1)
            return torch.cat([h[:,0],(h*mask.unsqueeze(-1)).sum(1)/n.unsqueeze(-1),stats],1)
        def features(self,inputs):
            return torch.cat([self.features_one(lang,**inputs[lang]) for lang in langs],1)
        def classify(self,features):
            return self.head(((features-self.center)/self.scale).clamp(-10,10))
        def forward(self,z_input_ids,z_attention_mask,z_token_type_ids,e_input_ids=None,e_attention_mask=None,e_token_type_ids=None):
            inputs={'zh':dict(input_ids=z_input_ids,attention_mask=z_attention_mask,token_type_ids=z_token_type_ids)}
            if mode=='dual':inputs['en']=dict(input_ids=e_input_ids,attention_mask=e_attention_mask,token_type_ids=e_token_type_ids)
            return self.classify(self.features(inputs))
    return Probe(),tokenizers(mode)


def node_scores(model,rows,name,mode):
    import numpy as np
    toks=tokenizers(mode);payload=[];truncated=0
    for row in rows:
        values={}
        for lang,tok in toks.items():
            full=tok(row['text']);truncated+=len(full['input_ids'])>128
            inputs=tok(row['text'],truncation=True,max_length=128)
            values.update({('z_' if lang=='zh' else 'e_')+n:inputs[n] for n in NAMES})
        payload.append({'inputs':values})
    inp=WORK/(name+'-inputs.json');out=WORK/(name+'-scores.json');save(inp,payload)
    subprocess.run(['node',str(ROOT/'tools/semantic-round2-native.mjs'),str(model),str(inp),str(out)],cwd=ROOT,check=True)
    result=read(out);return np.array(result['margins']),result,truncated


def operating_point(rows,scores):
    import numpy as np
    clean=[(r,float(s)) for r,s in zip(rows,scores) if r['label']==0]
    assert len(clean)>=30
    limits=[0.,float(np.quantile([s for _,s in clean],.99,method='higher'))]
    for cat in {r['category'] for r,_ in clean}:
        limits.append(float(np.quantile([s for r,s in clean if r['category']==cat],.99,method='higher')))
    limits.extend(float(s) for r,s in zip(rows,scores) if r['label']==2)
    return max(limits)


def train():
    import torch
    import torch_directml
    from safetensors.torch import save_file,load_file
    from semantic_device_loss import classification_nll
    from semantic_device_optim import PortableAdamW
    data,manifest=frozen();assert not (WORK/'training-started.json').exists()
    proof=read(ROOT/'data/semantic-directml-gradient-check.json')
    assert sha(ROOT/'tools/semantic_device_loss.py')==proof['loss_helper_sha256'] and proof['corrected_manual_path']['ok']
    torch.set_num_threads(4);torch.set_num_interop_threads(1);torch.manual_seed(manifest['protocol']['seed'])
    device=torch_directml.device(0);assert '780M' in torch_directml.device_name(0)
    model,toks=build('dual');model.eval();rows=data['train'];protocol=manifest['protocol']
    probe_text=['Please check the request timeout.','请检查这个 request。','the because across it were also']
    probe_inputs={lang:dict(tok(probe_text,padding=True,return_tensors='pt')) for lang,tok in toks.items()}
    with torch.no_grad():cpu_features=model.features(probe_inputs)
    model.to(device)
    with torch.no_grad():gpu_features=model.features({lang:{k:v.to(device) for k,v in inp.items()} for lang,inp in probe_inputs.items()}).cpu()
    feature_error=float((cpu_features-gpu_features).abs().max());assert feature_error<.001,feature_error
    unique={};indices=[];texts=[]
    for row in rows:
        key=r4.r2.canonical(row['text'])
        if key not in unique:unique[key]=len(texts);texts.append(key)
        indices.append(unique[key])
    features=torch.empty((len(texts),1048));started=time.perf_counter()
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter('always')
        cache=WORK/'train-features.safetensors'
        if cache.exists():
            prior=read(WORK/'first-attempt-training.json')
            assert prior['manifest_sha256']==sha(WORK/'manifest.json')
            features=load_file(str(cache))['features'];assert features.shape==(len(texts),1048)
            print(json.dumps({'phase':'verified-cache-reuse','sha256':sha(cache)}),flush=True)
        else:
            with torch.no_grad():
                for start in range(0,len(texts),32):
                    inputs={lang:{k:v.to(device) for k,v in tok(texts[start:start+32],padding=True,truncation=True,max_length=128,return_tensors='pt').items()} for lang,tok in toks.items()}
                    value=model.features(inputs);features[start:start+len(value)]=value.cpu()
                    if start%1024==0:print(json.dumps({'phase':'original-rtd-cache','done':start,'total':len(texts)}),flush=True)
            save_file({'features':features},str(cache),metadata={'train_sha256':manifest['split_hashes']['train']})
        assert torch.isfinite(features).all()
        cache_seconds=time.perf_counter()-started
        del model
        index=torch.tensor(indices);labels=torch.tensor([r['label'] for r in rows]);one_hot=torch.nn.functional.one_hot(labels,3).float()
        weights=torch.tensor([r['weight'] for r in rows]);class_weights=torch.tensor(protocol['class_weights'])
        record={'created_at_utc':datetime.now(timezone.utc).isoformat(),'manifest_sha256':sha(WORK/'manifest.json'),
            'device':torch_directml.device_name(0).rstrip('\x00'),'torch':torch.__version__,'feature_cache_seconds':cache_seconds,
            'original_rtd_feature_cpu_gpu_max_error':feature_error,
            'code_sha256':{p.name:sha(p) for p in [Path(__file__),ROOT/'tools/semantic_device_loss.py',ROOT/'tools/semantic_device_optim.py']}}
        save(WORK/'training-started.json',record);history={}
        for mode,dim in [('zh',524),('dual',1048)]:
            torch.manual_seed(protocol['seed']);head=torch.nn.Sequential(torch.nn.Linear(dim,128),torch.nn.GELU(),torch.nn.Dropout(.1),torch.nn.Linear(128,3))
            raw=features[:,:dim];center=raw.mean(0);scale=raw.std(0).clamp_min(.001);values=((raw-center)/scale).clamp(-10,10)
            a=copy.deepcopy(head).eval();b=copy.deepcopy(a).to(device)
            ids=torch.tensor([next(i for i,r in enumerate(rows) if r['label']==label) for label in [0,1,2]])
            losses=[]
            for h,d in [(a,torch.device('cpu')),(b,device)]:
                loss=(classification_nll(h(values[index[ids]].to(d)),one_hot[ids].to(d),class_weights.to(d))*weights[ids].to(d)).mean()
                loss.backward();losses.append(float(loss.detach().cpu()))
            error=max(float((x.grad-y.grad.cpu()).abs().max()) for x,y in zip(a.parameters(),b.parameters()))
            assert error<1e-4 and abs(losses[0]-losses[1])<1e-4
            save(WORK/f'{mode}-gradient-preflight.json',{'losses_cpu_gpu':losses,'max_gradient_error':error})
            head.to(device);optimizer=PortableAdamW(head.parameters(),lr=protocol['learning_rate']);records=[]
            for epoch in range(1,protocol['epochs']+1):
                head.train();losses=[];tick=time.perf_counter()
                for ids in torch.randperm(len(rows)).split(protocol['batch_size']):
                    optimizer.zero_grad(set_to_none=True)
                    logits=head(values[index[ids]].to(device))
                    loss=(classification_nll(logits,one_hot[ids].to(device),class_weights.to(device))*weights[ids].to(device)).mean()
                    loss.backward();torch.nn.utils.clip_grad_norm_(head.parameters(),1.,foreach=False,error_if_nonfinite=True);optimizer.step()
                    val=float(loss.detach().cpu());assert math.isfinite(val);losses.append(val)
                training={'epoch':epoch,'mode':mode,'head_seconds':time.perf_counter()-tick,'mean_loss':sum(losses)/len(losses)}
                print(json.dumps({'phase':'head-train',**training}),flush=True)
                if epoch in protocol['checkpoints']:
                    state={'head.'+k:v.detach().cpu().contiguous() for k,v in head.state_dict().items()}
                    state.update(center=center.contiguous(),scale=scale.contiguous())
                    weights_path=WORK/f'{mode}-epoch-{epoch}-head.safetensors';save_file(state,str(weights_path))
                    subprocess.run([str(CPU),'-X','utf8',str(Path(__file__)),'export','--epoch',str(epoch),'--mode',mode],cwd=ROOT,check=True)
                    records.append(read(WORK/f'{mode}-epoch-{epoch}-cal.json')|training|{'head_sha256':sha(weights_path)})
            history[mode]=records
        warning_text=sorted({str(w.message) for w in captured})
    selections={mode:max(items,key=lambda h:(h['cal']['noise_macro_language_recall'],-h['cal']['normal_false_positives'][0],-h['epoch'])) for mode,items in history.items()}
    candidates=[c for c in selections.values() if c['artifact_and_vocab_bytes']<=protocol['assumed_model_and_vocab_budget_bytes']]
    best=max(candidates,key=lambda h:(h['cal']['noise_macro_language_recall'],-h['cal']['normal_false_positives'][0],-h['artifact_and_vocab_bytes']))
    save(WORK/'selection.json',{'selected':best,'by_mode':selections,'history':history,'warnings':warning_text,
        'total_seconds':time.perf_counter()-started,'split_hashes':manifest['split_hashes'],
        'sealed_at_utc':datetime.now(timezone.utc).isoformat(),'test_opened':False})
    print(json.dumps({'phase':'selected','selected':best,'warnings':warning_text}),flush=True)


def export(mode,epoch):
    import numpy as np
    import torch
    import onnxruntime as ort
    from onnxruntime.quantization import quantize_dynamic,QuantType
    from safetensors.torch import load_file
    data,manifest=frozen();torch.set_num_threads(4);torch.set_num_interop_threads(1)
    model,toks=build(mode);head_path=WORK/f'{mode}-epoch-{epoch}-head.safetensors'
    missing,extra=model.load_state_dict(load_file(str(head_path)),strict=False)
    assert not extra and all(k.startswith('bases.') for k in missing);model.eval()
    inputs={('z_' if lang=='zh' else 'e_')+n:v for lang,tok in toks.items() for n,v in tok('请检查这个 request。',return_tensors='pt').items()}
    names=['z_'+n for n in NAMES]+(['e_'+n for n in NAMES] if mode=='dual' else [])
    stem=f'{mode}-epoch-{epoch}';full=WORK/(stem+'.onnx');small=WORK/(stem+'-int8.onnx');assert not full.exists()
    torch.onnx.export(model,tuple(inputs[n] for n in names),str(full),input_names=names,output_names=['logits'],
        dynamic_axes={n:{0:'batch',1:n[:2]+'sequence'} for n in names}|{'logits':{0:'batch'}},opset_version=17,dynamo=False)
    opt=ort.SessionOptions();opt.intra_op_num_threads=4;opt.inter_op_num_threads=1
    session=ort.InferenceSession(str(full),opt,providers=['CPUExecutionProvider']);drift=0.
    with torch.no_grad():
        for row in data['cal'][:12]:
            inp={('z_' if lang=='zh' else 'e_')+n:v for lang,tok in toks.items() for n,v in tok(row['text'],return_tensors='pt').items()}
            out=session.run(None,{n:inp[n].numpy() for n in names})[0]
            drift=max(drift,float(np.abs(out-model(**inp).numpy()).max()))
    assert drift<.001,drift
    quantize_dynamic(str(full),str(small),weight_type=QuantType.QInt8)
    scores,native,truncated=node_scores(small,data['cal'],stem+'-cal',mode)
    # Both encoders are limited identically at runtime; record long inputs, do
    # not silently drop rows or claim full-sequence coverage beyond 128 tokens.
    thresholds={}
    for lang in ['en','zh','mixed']:
        ids=[i for i,r in enumerate(data['cal']) if r4.language(r['text'])==lang]
        thresholds[lang]=operating_point([data['cal'][i] for i in ids],scores[ids])
    adjusted=scores-np.array([thresholds[r4.language(r['text'])] for r in data['cal']])
    vocab_bytes=sum((Path(manifest['bases'][f'{lang}_folder'])/'vocab.txt').stat().st_size for lang in toks)
    record={'mode':mode,'epoch':epoch,'artifact':small.name,'artifact_sha256':sha(small),'artifact_bytes':small.stat().st_size,
        'artifact_and_vocab_bytes':small.stat().st_size+vocab_bytes,'thresholds':thresholds,'cal':r4.measured(data['cal'],adjusted,0.),
        'fp32_export_max_drift':drift,'native_version':native['native_version'],'cal_truncated_encoder_inputs':truncated}
    save(WORK/(stem+'-cal.json'),record);print(json.dumps(record),flush=True)


def evaluate():
    import numpy as np
    assert not (WORK/'results.json').exists()
    data,manifest=frozen();selection=read(WORK/'selection.json');assert selection['split_hashes']==manifest['split_hashes']
    result={'manifest':manifest,'selection':selection,'training':read(WORK/'training-started.json'),'configurations':{}}
    for mode,chosen in selection['by_mode'].items():
        path=WORK/chosen['artifact'];assert sha(path)==chosen['artifact_sha256'];output={'splits':{}}
        for split in ['fresh_challenge','new_challenge','new_public_test','known_ime','known_round2','known_legacy']:
            scores,native,truncated=node_scores(path,data[split],mode+'-'+split,mode)
            adjusted=scores-np.array([chosen['thresholds'][r4.language(r['text'])] for r in data[split]])
            output['splits'][split]={'metrics':r4.measured(data[split],adjusted,0.),'p95_ms':native['latency_p95_ms'],
                'truncated_encoder_inputs':truncated,'predictions':[{'index':i,'label':r['label'],'category':r['category'],
                'language':r4.language(r['text']),'raw_score':float(s),'score':float(a),'warning':bool(a>0)}
                for i,(r,s,a) in enumerate(zip(data[split],scores,adjusted))]}
        result['configurations'][mode]=output
    save(WORK/'results.json',result)
    print(json.dumps({m:{s:v['metrics'] for s,v in c['splits'].items()} for m,c in result['configurations'].items()}),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['prepare','train','export','evaluate'])
    p.add_argument('--mode',choices=['zh','dual']);p.add_argument('--epoch',type=int,choices=[1,3,10]);args=p.parse_args()
    if args.command=='export':assert args.mode and args.epoch;export(args.mode,args.epoch)
    else:globals()[args.command]()
