"""Learn a163-parameter residual on fixed R3/R9 whole-input classifier logits."""
import argparse
import copy
from datetime import datetime,timezone
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import time

ROOT=Path(__file__).resolve().parents[1];WORK=ROOT/'.research/semantic-round10';CPU=ROOT/'.research/semantic-screen-venv/Scripts/python.exe'
spec=importlib.util.spec_from_file_location('r9',ROOT/'tools/semantic-round9.py')
r9=importlib.util.module_from_spec(spec);spec.loader.exec_module(r9)
spec=importlib.util.spec_from_file_location('cal9',ROOT/'tools/semantic-round9-calibration.py')
cal9=importlib.util.module_from_spec(spec);spec.loader.exec_module(cal9)
r4=r9.r4;read,save,sha=r9.read,r9.save,r9.sha


def prepare():
    assert not (WORK/'manifest.json').exists();WORK.mkdir(exist_ok=True)
    data,parent=r9.frozen();data['known_r9_ime']=read(r9.WORK/'prospective-ime-prepared.json')['rows']
    r3=read(ROOT/'.research/semantic-round3/selection.json');r9sel=read(r9.WORK/'selection.json')['selected']
    models={'r3':{'path':str(ROOT/'.research/semantic-round3'/r3['selected']['artifact']),'sha256':r3['checkpoint_sha256']},
        'r9':{'path':str(r9.WORK/r9sel['artifact']),'sha256':r9sel['artifact_sha256']}}
    assert all(sha(Path(m['path']))==m['sha256'] for m in models.values())
    bases=read(r9.WORK/'bases.json');size=sum(Path(m['path']).stat().st_size for m in models.values())+sum((Path(bases[f'{lang}_folder'])/'vocab.txt').stat().st_size for lang in ['zh','en'])
    source=[r9.WORK/'manifest.json',r9.WORK/'train-features.safetensors',ROOT/'.research/semantic-round5/train-features.safetensors',
        ROOT/'.research/semantic-directml/model.safetensors',r9.WORK/f"epoch-{r9sel['epoch']}-head.safetensors",r9.WORK/'results.json',r9.WORK/'prospective-ime-results.json']
    manifest={'created_at_utc':datetime.now(timezone.utc).isoformat(),'models':models,'base_and_shared_vocab_bytes':size,'r9_source_selection':r9sel,
        'source_hashes':{str(p.relative_to(ROOT)):sha(p) for p in source},'split_hashes':{s:r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True)) for s,rows in data.items()},
        'protocol':{'epochs':30,'checkpoints':[3,10,30],'learning_rate':.001,'batch_size':128,'seed':20261114,
            'class_weights':[2.,1.,2.],'teacher_temperature':2.,'teacher_weight':.5,
            'architecture':'Six base logits -> train-only standardized/clipped ->16ReLU->3 residual, final zeros; add original R9 logits',
            'teacher_mask':'TRAIN normal/context only, no teacher constraint on noise','selection':'CAL pooled source>=101; min language recall, macro, fewer normal warnings, earlier epoch',
            'prior_tests':'All known regressions, including R9 new short260 and actual00460',
            'practical_screen':{'known004_noise_min':30,'known004_normal_max':0,'known004_context_max':1,
                'short_normal_max':2,'short_context_max':3,'old_public_normal_max':5,'old425_normal_max':3,'old425_noise_min':28,
                'r5_en_noise_min':14,'r5_mixed_noise_min':12,'r5_normal_max':1,'budget_bytes':50_000_000,'p95_ms_max':20},
            'fresh_guard':'Only if every practical gate passes, collect fresh60 actualIME from physical bits starting124928 after seal; otherwise no new entropy/capture.'}}
    save(WORK/'bases.json',bases);save(WORK/'prepared.json',data);save(WORK/'manifest.json',manifest)


def frozen():
    data,manifest=read(WORK/'prepared.json'),read(WORK/'manifest.json')
    for s,rows in data.items():assert r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True))==manifest['split_hashes'][s]
    for p,h in manifest['source_hashes'].items():assert sha(ROOT/p)==h
    for m in manifest['models'].values():assert sha(Path(m['path']))==m['sha256']
    return data,manifest


def gate_model():
    import torch
    class Gate(torch.nn.Module):
        def __init__(self):
            super().__init__();self.register_buffer('center',torch.zeros(6));self.register_buffer('scale',torch.ones(6))
            self.net=torch.nn.Sequential(torch.nn.Linear(6,16),torch.nn.ReLU(),torch.nn.Linear(16,3))
            torch.nn.init.zeros_(self.net[2].weight);torch.nn.init.zeros_(self.net[2].bias)
        def forward(self,logits_pair):
            return logits_pair[:,3:]+self.net(((logits_pair-self.center)/self.scale).clamp(-10,10))
    return Gate()


def prepare_cal():
    data,manifest=frozen();assert not (WORK/'cal-pairs.json').exists()
    old=read(ROOT/'.research/semantic-round8/prepared.json')['cal'];assert data['cal'][:len(old)]==old
    a=read(ROOT/'.research/semantic-round8/r3-cal-scores.json')['logits']
    r4.r2.WORK=WORK;_,new,truncated=r4.r2.node_scores(Path(manifest['models']['r3']['path']),data['cal'][len(old):],'r3-added-cal');assert truncated==0
    a+=new['logits'];epoch=manifest['r9_source_selection']['epoch'];b=read(r9.WORK/f'epoch-{epoch}-cal-scores.json')['logits']
    assert len(a)==len(b)==len(data['cal'])
    pairs=[x+y for x,y in zip(a,b)];save(WORK/'cal-pairs.json',pairs)
    import numpy as np
    scores=np.array([v[1]-max(v[0],v[2]) for v in b]);thresholds,metrics=cal9.calibrated(data['cal'],scores)
    save(WORK/'baseline-cal.json',{'thresholds':thresholds,'cal':metrics,'artifact_sha256':manifest['models']['r9']['sha256']})


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
    old=load_file(str(ROOT/'.research/semantic-round5/train-features.safetensors'))['base_logits'];a=torch.empty((len(texts),3));a[:len(old)]=old
    oldtexts=list(dict.fromkeys(r4.r2.canonical(r['text']) for r in read(ROOT/'.research/semantic-round5/prepared.json')['train']));assert texts[:len(old)]==oldtexts
    base,tok=r4.model_and_tokenizer();state=load_file(str(ROOT/'.research/semantic-directml/model.safetensors'))
    missing,extra=base.load_state_dict(state,strict=False);assert set(missing)=={'aux.weight','aux.bias'} and not extra
    base.requires_grad_(False);base.to(device).eval();started=time.perf_counter()
    with torch.no_grad():
        for start in range(len(old),len(texts),32):
            inp=tok(texts[start:start+32],padding=True,truncation=True,max_length=128,return_tensors='pt')
            logits=base.head(base.features(**{k:v.to(device) for k,v in inp.items()}));a[start:start+len(logits)]=logits.cpu()
    del base
    features=load_file(str(r9.WORK/'train-features.safetensors'))['features'];assert len(features)==len(texts)
    epoch=manifest['r9_source_selection']['epoch'];head=load_file(str(r9.WORK/f'epoch-{epoch}-head.safetensors'))
    with torch.no_grad():
        norm=((features-head['center'])/head['scale']).clamp(-10,10)
        hidden=torch.nn.functional.gelu(torch.nn.functional.linear(norm,head['head.0.weight'],head['head.0.bias']))
        b=torch.nn.functional.linear(hidden,head['head.3.weight'],head['head.3.bias'])
    pairs=torch.cat([a,b],1);assert torch.isfinite(pairs).all();save_file({'pairs':pairs},str(WORK/'train-pairs.safetensors'))
    model=gate_model();model.center.copy_(pairs.mean(0));model.scale.copy_(pairs.std(0,unbiased=False).clamp_min(.001));model.eval()
    with torch.no_grad():assert torch.equal(model(pairs[:6]),pairs[:6,3:])
    one_hot=torch.nn.functional.one_hot(torch.tensor([r['label'] for r in rows]),3).float();weights=torch.tensor([r['weight'] for r in rows]);mask=torch.tensor([float(r['label']!=1) for r in rows]);cw=torch.tensor(protocol['class_weights'])
    ids=torch.tensor([next(i for i,r in enumerate(rows) if r['label']==label) for label in [0,1,2]]+[next(i for i,r in enumerate(rows) if r['label']==label and r['category']=='r9-real-ime-2') for label in [0,1,2]])
    check=copy.deepcopy(model).eval()
    with torch.no_grad():check.net[2].weight.normal_(std=.01)
    check_gpu=copy.deepcopy(check).to(device);losses=[]
    for m,d in [(check,torch.device('cpu')),(check_gpu,device)]:
        loss=r9.loss_for(m(pairs[index[ids]].to(d)),pairs[index[ids],3:].to(d),one_hot[ids].to(d),weights[ids].to(d),mask[ids].to(d),protocol,cw.to(d));loss.backward();losses.append(float(loss.detach().cpu()))
    g1=torch.cat([p.grad.flatten() for p in check.parameters()]).double();g2=torch.cat([p.grad.cpu().flatten() for p in check_gpu.parameters()]).double()
    relative=float((g1-g2).norm()/g1.norm());error=float((g1-g2).abs().max());assert relative<.001 and error<1e-4 and abs(losses[0]-losses[1])<1e-4
    save(WORK/'training-started.json',{'created_at_utc':datetime.now(timezone.utc).isoformat(),'device':torch_directml.device_name(0).rstrip('\x00'),'trainable_parameters':163,
        'initial_exact_r9':True,'gradient_preflight':{'loss_cpu_gpu':losses,'relative_l2_error':relative,'max_abs_error':error},
        'manifest_sha256':sha(WORK/'manifest.json'),'code_sha256':sha(Path(__file__))})
    subprocess.run([str(CPU),'-X','utf8',str(Path(__file__)),'prepare-cal'],cwd=ROOT,check=True)
    model.to(device);optimizer=PortableAdamW(model.parameters(),lr=protocol['learning_rate']);history=[]
    for epoch in range(1,protocol['epochs']+1):
        model.train();losses=[]
        for ids in torch.randperm(len(rows)).split(protocol['batch_size']):
            batch=pairs[index[ids]].to(device);optimizer.zero_grad(set_to_none=True)
            loss=r9.loss_for(model(batch),batch[:,3:],one_hot[ids].to(device),weights[ids].to(device),mask[ids].to(device),protocol,cw.to(device))
            loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1.,foreach=False,error_if_nonfinite=True);optimizer.step()
            val=float(loss.detach().cpu());assert math.isfinite(val);losses.append(val)
        if epoch in protocol['checkpoints']:
            path=WORK/f'epoch-{epoch}.safetensors';save_file({k:v.detach().cpu().contiguous() for k,v in model.state_dict().items()},str(path))
            history.append({'epoch':epoch,'mean_loss':sum(losses)/len(losses),'weights_sha256':sha(path)})
        if epoch%10==0:print({'phase':'train-gate','epoch':epoch,'loss':sum(losses)/len(losses)},flush=True)
    subprocess.run([str(CPU),'-X','utf8',str(Path(__file__)),'export-all'],cwd=ROOT,check=True)
    history=[read(WORK/f"epoch-{h['epoch']}-cal.json")|h for h in history]
    chosen=max(history,key=lambda h:(h['cal']['minimum_language_noise_recall'],h['cal']['noise_macro_language_recall'],-h['cal']['normal_false_positives'][0],-h['epoch']))
    save(WORK/'selection.json',{'selected':chosen,'history':history,'total_seconds':time.perf_counter()-started,'split_hashes':manifest['split_hashes'],
        'sealed_at_utc':datetime.now(timezone.utc).isoformat(),'test_opened':False,'baseline':read(WORK/'baseline-cal.json')})
    print({'phase':'selected','selected':chosen},flush=True)


def export_all():
    import numpy as np
    import torch
    import onnxruntime as ort
    from safetensors.torch import load_file
    data,manifest=frozen();torch.set_num_threads(4);torch.set_num_interop_threads(1);pairs=np.array(read(WORK/'cal-pairs.json'),dtype=np.float32)
    for epoch in manifest['protocol']['checkpoints']:
        model=gate_model();model.load_state_dict(load_file(str(WORK/f'epoch-{epoch}.safetensors')));model.eval();path=WORK/f'epoch-{epoch}.onnx';assert not path.exists()
        torch.onnx.export(model,(torch.from_numpy(pairs[:2]),),str(path),input_names=['logits_pair'],output_names=['logits'],dynamic_axes={'logits_pair':{0:'batch'},'logits':{0:'batch'}},opset_version=17,dynamo=False)
        options=ort.SessionOptions();options.intra_op_num_threads=4;options.inter_op_num_threads=1;session=ort.InferenceSession(str(path),options,providers=['CPUExecutionProvider'])
        with torch.no_grad():drift=float(np.abs(session.run(None,{'logits_pair':pairs})[0]-model(torch.from_numpy(pairs)).numpy()).max())
        assert drift<1e-5,drift
        output=WORK/f'epoch-{epoch}-cal-scores.json'
        subprocess.run(['node',str(ROOT/'tools/semantic-gate-native.mjs'),'pairs',str(path),str(WORK/'cal-pairs.json'),str(output)],cwd=ROOT,check=True)
        native=read(output);thresholds,metrics=cal9.calibrated(data['cal'],np.array(native['margins']))
        save(WORK/f'epoch-{epoch}-cal.json',{'epoch':epoch,'artifact':path.name,'artifact_sha256':sha(path),'gate_bytes':path.stat().st_size,
            'artifact_and_vocab_bytes':manifest['base_and_shared_vocab_bytes']+path.stat().st_size,'thresholds':thresholds,'cal':metrics,'fp32_export_max_drift':drift})


def full_score(rows,name):
    import numpy as np
    manifest=read(WORK/'manifest.json');chosen=read(WORK/'selection.json')['selected'];toks=r9.r6.tokenizers('dual');payload=[];truncated=0
    for row in rows:
        inputs={}
        for lang,tok in toks.items():
            truncated+=len(tok(row['text'])['input_ids'])>128
            inputs.update({('z_' if lang=='zh' else 'e_')+n:v for n,v in tok(row['text'],truncation=True,max_length=128).items()})
        payload.append({'inputs':inputs})
    inp=WORK/(name+'-inputs.json');out=WORK/(name+'-scores.json');save(inp,payload)
    subprocess.run(['node',str(ROOT/'tools/semantic-gate-native.mjs'),'full',manifest['models']['r3']['path'],manifest['models']['r9']['path'],str(WORK/chosen['artifact']),str(inp),str(out)],cwd=ROOT,check=True)
    native=read(out);return np.array(native['margins']),native,truncated


def evaluate():
    import numpy as np
    data,manifest=frozen();sel=read(WORK/'selection.json');chosen=sel['selected'];assert not (WORK/'results.json').exists()
    assert sha(WORK/chosen['artifact'])==chosen['artifact_sha256'] and sel['split_hashes']==manifest['split_hashes']
    # Check complete native composition against cached CAL components before regression.
    ids=list(range(12))+list(range(1470,1482));scores,native,truncated=full_score([data['cal'][i] for i in ids],'cal-composition');assert truncated==0
    cached=read(WORK/f"epoch-{chosen['epoch']}-cal-scores.json")['margins'];drift=max(abs(float(s)-cached[i]) for i,s in zip(ids,scores));assert drift<1e-5,drift
    out={}
    for split,rows in data.items():
        if split in ['train','cal']:continue
        scores,native,truncated=full_score(rows,split);assert truncated==0
        adjusted=scores-np.array([chosen['thresholds'][r4.language(r['text'])] for r in rows])
        out[split]={'metrics':r4.measured(rows,adjusted,0.),'p95_ms':native['latency_p95_ms'],
            'predictions':[{'index':i,'label':r['label'],'category':r['category'],'raw_score':float(s),'score':float(a),'warning':bool(a>0)} for i,(r,s,a) in enumerate(zip(rows,scores,adjusted))]}
    g=manifest['protocol']['practical_screen'];actual=out['known_r9_ime']['metrics'];short=out['new_short_test']['metrics'];old=out['fresh_challenge']['metrics'];old425=out['known_round2']['metrics']
    gates={'known_actual_noise':actual['noise_detected'][0]>=g['known004_noise_min'],'known_actual_normal':actual['normal_false_positives'][0]<=g['known004_normal_max'],
        'known_actual_context':actual['context_warnings'][0]<=g['known004_context_max'],'short_normal':short['normal_false_positives'][0]<=g['short_normal_max'],
        'short_context':short['context_warnings'][0]<=g['short_context_max'],'public_normal':out['new_public_test']['metrics']['normal_false_positives'][0]<=g['old_public_normal_max'],
        'old425_normal':old425['normal_false_positives'][0]<=g['old425_normal_max'],'old425_noise':old425['noise_detected'][0]>=g['old425_noise_min'],
        'en_noise':old['noise_languages']['en'][0]>=g['r5_en_noise_min'],'mixed_noise':old['noise_languages']['mixed'][0]>=g['r5_mixed_noise_min'],
        'challenge_normal':old['normal_false_positives'][0]<=g['r5_normal_max'],'size':chosen['artifact_and_vocab_bytes']<=g['budget_bytes'],
        'latency':out['known_round2']['p95_ms']<=g['p95_ms_max']}
    result={'manifest':manifest,'selection':sel,'training':read(WORK/'training-started.json'),'splits':out,'gates':gates,'all_gates_passed':all(gates.values()),
        'native_composition_max_drift':drift,'new_prospective_capture_required':all(gates.values()),'new_entropy_consumed':0,'test_role':'known_regression_only'}
    save(WORK/'results.json',result);save(ROOT/'data/semantic-round10-results.json',result)
    print({'gates':gates,'known_actual':actual,'new_short':short,'bytes':chosen['artifact_and_vocab_bytes']},flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['prepare','prepare-cal','train','export-all','evaluate']);args=p.parse_args();globals()[args.command.replace('-','_')]()
