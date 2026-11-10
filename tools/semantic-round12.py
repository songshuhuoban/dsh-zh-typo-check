"""Binary warn/do-not-warn adaptation, reviewed batch004 transferred to TRAIN.

All model/threshold choices use frozen CAL. Prospective samples follow the seal.
"""
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

ROOT=Path(__file__).resolve().parents[1];WORK=ROOT/'.research/semantic-round12'
CPU=ROOT/'.research/semantic-screen-venv/Scripts/python.exe'
spec=importlib.util.spec_from_file_location('r11',ROOT/'tools/semantic-round11.py')
r11=importlib.util.module_from_spec(spec);spec.loader.exec_module(r11)
r9=r11.r9;r6=r9.r6;r4=r9.r4;cal9=r11.cal9;read,save,sha=r9.read,r9.save,r9.sha


def prepare():
    assert not (WORK/'manifest.json').exists();WORK.mkdir(exist_ok=True)
    data,old=r11.frozen();transferred=data.pop('known_r9_ime');assert len(transferred)==60
    for row in transferred:
        item=dict(row,category='r12-real-ime-4',weight=1. if row['confidence']=='high' else .75,teacher=0.)
        data['train'].extend(item.copy() for _ in range(4))
    train={r4.r2.canonical(r['text']) for r in data['train']};cal={r4.r2.canonical(r['text']) for r in data['cal']}
    assert not train&cal
    assert all(not ({r4.r2.canonical(r['text']) for r in rows}&(train|cal)) for name,rows in data.items() if name not in ['train','cal'])
    initial=read(r9.WORK/'calibration-selection.json')['selected'];assert initial['epoch']==1
    source=r9.WORK/'epoch-1-head.safetensors'
    warm=next(h for h in read(r9.WORK/'selection.json')['history'] if h['epoch']==1)
    assert sha(source)==warm['head_sha256'] and initial['artifact_sha256']==warm['artifact_sha256']
    paths=[r11.WORK/'manifest.json',r9.WORK/'train-features.safetensors',r9.WORK/'calibration-selection.json',source,
        ROOT/'data/ime-keyboard/notepad-batch-004.jsonl',ROOT/'data/ime-keyboard/assistant-labels-004.json',
        r6.WORK/'zh-pretrained.safetensors',r6.WORK/'en-pretrained.safetensors']
    manifest={'created_at_utc':datetime.now(timezone.utc).isoformat(),'issue':'SIM-1047',
        'split_hashes':{s:r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True)) for s,rows in data.items()},
        'source_hashes':{str(p.relative_to(ROOT)):sha(p) for p in paths},'warm_head':str(source.relative_to(ROOT)),
        'initial_reference':initial,'train_entries':len(data['train']),'unique_train':len(train),
        'transferred_roles':{'batch004':'TRAIN 4x, never TEST in R12','batch002':'TRAIN','batch003':'CAL'},
        'protocol':{'arms':['baseline','head','last2'],'epochs':3,'checkpoints':[1,3],'seed':20261116,
            'batch_size':32,'bucket_size':512,'head_lr':.0002,'encoder_lr':.00002,'class_weights':[2.,1.],
            'teacher_temperature':2.,'teacher_weight':.5,'teacher_mask':'Non-noise original TRAIN only; newly transferred004 excluded',
            'objective':'2-class manual NLL: noise label1, normal0/context2 merged; non-noise logsumexp(raw0,raw2)',
            'output':'Single logit margin raw1-logsumexp(raw0,raw2); not a calibrated probability',
            'features':'Original RTD CLS/bodymean/12stats, centered variance clamp1e-12 before sqrt for finite singleton gradients; both encoders always whole text',
            'dropout':'All encoders/RTD eval; head Dropout.1 only when training',
            'frozen':'English encoder/RTD and center/scale always fixed; last2 unfreezes Chinese blocks10/11 only',
            'threshold':'Same pooled per-language normal99%-higher/source n>=101/contextMAX/min0 strict >',
            'selection':'CAL min language recall, macro recall, fewer normal warnings, smaller arm, earlier epoch; include no-training baseline',
            'budget_bytes':50_000_000,'prospective':{'actual_rows':60,'key_bit_start':124928,
                'public_rows':200,'public_quotas':{'zh':100,'en':40,'mixed':60},'public_bit_start':147456,
                'rule':'Always collect after CAL seal; no TEST-based choice or threshold update; labels before scores'},
            'gates':{'actual_noise_recall_min':.8,'actual_normal_fp_max':0,'actual_context_rate_max':.05,
                'public_normal_rate_max':.01,'public_context_rate_max':.03,'native_p95_max_ms':15,
                'old425_noise_min':28,'old425_normal_max':3,'old_public_normal_max':5,
                'old_short_normal_max':2,'old_short_context_max':3,'challenge_en_min':14,'challenge_mixed_min':12,'challenge_normal_max':1}}}
    save(WORK/'prepared.json',data);save(WORK/'manifest.json',manifest);save(WORK/'bases.json',read(r9.WORK/'bases.json'))
    print({'train_entries':len(data['train']),'unique_train':len(train),'transferred':len(transferred)},flush=True)


def frozen():
    data,manifest=read(WORK/'prepared.json'),read(WORK/'manifest.json')
    for s,rows in data.items():assert r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True))==manifest['split_hashes'][s]
    for p,h in manifest['source_hashes'].items():assert sha(ROOT/p)==h
    return data,manifest


def binary_logits(raw):
    import torch
    m=torch.maximum(raw[:,0],raw[:,2])
    non=m+((raw[:,0]-m).exp()+(raw[:,2]-m).exp()).log()
    return torch.stack([non,raw[:,1]],1)


def build(arm='baseline',checkpoint=None):
    import torch
    from safetensors.torch import load_file
    source,toks=r9.build(ROOT/read(WORK/'manifest.json')['warm_head'])
    class Whole(torch.nn.Module):
        def __init__(self):
            super().__init__();self.bases=source.bases;self.head=source.head
            self.register_buffer('center',source.center);self.register_buffer('scale',source.scale)
        def features_one(self,lang,input_ids,attention_mask,token_type_ids):
            base=self.bases[lang]
            h=base.electra(input_ids=input_ids,attention_mask=attention_mask,token_type_ids=token_type_ids).last_hidden_state
            logits=base.discriminator_predictions(h);p=logits.sigmoid()
            mask=(attention_mask.bool() & (input_ids!=101) & (input_ids!=102)).to(h.dtype);n=mask.sum(1).clamp_min(1)
            mean=(logits*mask).sum(1)/n;mp=(p*mask).sum(1)/n
            # Center first, floor before sqrt: finite derivatives even for one-token inputs.
            sd=(((logits-mean[:,None]).square()*mask).sum(1)/n).clamp_min(1e-12).sqrt()
            psd=(((p-mp[:,None]).square()*mask).sum(1)/n).clamp_min(1e-12).sqrt()
            stats=torch.stack([mean,sd,(logits*mask-100*(1-mask)).max(1).values,
                (logits*mask+100*(1-mask)).min(1).values,mp,psd,(p*mask).max(1).values,
                ((p>.5)*mask).sum(1)/n,((p>.8)*mask).sum(1)/n,((p>.95)*mask).sum(1)/n,
                n.log1p(),((input_ids==100)*mask).sum(1)/n],1)
            return torch.cat([h[:,0],(h*mask.unsqueeze(-1)).sum(1)/n.unsqueeze(-1),stats],1)
        def raw(self,features):return self.head(((features-self.center)/self.scale).clamp(-10,10))
        def forward(self,z_input_ids,z_attention_mask,z_token_type_ids,e_input_ids,e_attention_mask,e_token_type_ids):
            z=self.features_one('zh',z_input_ids,z_attention_mask,z_token_type_ids)
            e=self.features_one('en',e_input_ids,e_attention_mask,e_token_type_ids)
            pair=binary_logits(self.raw(torch.cat([z,e],1)))
            return (pair[:,1]-pair[:,0]).unsqueeze(1)
    model=Whole();model.requires_grad_(False)
    if arm!='baseline':model.head.requires_grad_(True)
    if arm=='last2':
        for layer in model.bases['zh'].electra.encoder.layer[-2:]:layer.requires_grad_(True)
    names={n for n,p in model.named_parameters() if p.requires_grad}
    if checkpoint is not None:
        state=load_file(str(checkpoint));assert set(state)==names
        missing,extra=model.load_state_dict(state,strict=False);assert not extra and set(missing)==set(model.state_dict())-names
    model.eval();return model,toks,names


def cached_logits(model,cn,en):
    import torch
    return binary_logits(model.raw(torch.cat([cn,en],1)))


def train_logits(model,inputs,en):return cached_logits(model,model.features_one('zh',**inputs),en)


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
    for group,prefix in [('encoder','bases.zh.electra.encoder.layer.'),('head','head.')]:
        aa=[];bb=[]
        for (n,a),(other,b) in zip(cpu.named_parameters(),gpu.named_parameters()):
            assert n==other and (a.grad is None)==(b.grad is None)
            if n.startswith(prefix) and a.grad is not None:aa.append(a.grad.detach().flatten().double());bb.append(b.grad.detach().cpu().flatten().double())
        if not aa:continue
        a=torch.cat(aa);b=torch.cat(bb);assert torch.isfinite(a).all() and torch.isfinite(b).all()
        groups[group]={'parameters':a.numel(),'relative_l2_error':float((a-b).norm()/a.norm()),
            'cosine':float(torch.dot(a,b)/(a.norm()*b.norm())),'max_abs_error':float((a-b).abs().max())}
    drift=float((outputs[0]-outputs[1]).abs().max())
    valid=drift<.001 and abs(losses[0]-losses[1])<.001 and all(g['relative_l2_error']<.002 and g['cosine']>.99999 for g in groups.values())
    if full:valid=valid and 'encoder' in groups
    result={'ok':valid,'full_encoder_path':full,'losses_cpu_gpu':losses,'logits_max_abs_error':drift,'groups':groups}
    assert valid,result
    return result


def train():
    import torch
    import torch_directml
    from safetensors.torch import save_file
    from semantic_device_optim import PortableAdamW
    data,manifest=frozen();protocol=manifest['protocol'];assert not (WORK/'training-started.json').exists()
    proof=read(ROOT/'data/semantic-directml-gradient-check.json')
    assert sha(ROOT/'tools/semantic_device_loss.py')==proof['loss_helper_sha256'] and proof['corrected_manual_path']['ok']
    torch.set_num_threads(4);torch.set_num_interop_threads(1);torch.manual_seed(protocol['seed'])
    device=torch_directml.device(0);assert '780M' in torch_directml.device_name(0)
    model,toks,_=build();rows=data['train'];texts=list(dict.fromkeys(r4.r2.canonical(r['text']) for r in rows))
    lookup={t:i for i,t in enumerate(texts)};index=torch.tensor([lookup[r4.r2.canonical(r['text'])] for r in rows])
    cn=torch.empty((len(texts),524));en=torch.empty_like(cn);model.to(device).eval();tick=time.perf_counter()
    with torch.no_grad():
        for lang,dest in [('zh',cn),('en',en)]:
            for start in range(0,len(texts),32):
                inp=toks[lang](texts[start:start+32],padding=True,truncation=True,max_length=128,return_tensors='pt')
                dest[start:start+len(inp['input_ids'])]=model.features_one(lang,**{k:v.to(device) for k,v in inp.items()}).cpu()
            print({'phase':'features','language':lang,'unique':len(texts),'seconds':time.perf_counter()-tick},flush=True)
    model.cpu()
    with torch.no_grad():teacher=torch.cat([cached_logits(model,a,b) for a,b in zip(cn.split(256),en.split(256))])
    assert all(torch.isfinite(v).all() for v in [cn,en,teacher])
    save_file({'cn':cn,'en':en,'teacher':teacher},str(WORK/'train-cache.safetensors'),metadata={'train_sha256':manifest['split_hashes']['train']})
    one_hot=torch.nn.functional.one_hot(torch.tensor([int(r['label']==1) for r in rows]),2).float()
    weights=torch.tensor([r['weight'] for r in rows]);mask=torch.tensor([float(r['label']!=1 and r['category']!='r12-real-ime-4') for r in rows])
    encoded=toks['zh'](texts,truncation=True,max_length=128);lengths=list(map(len,encoded['input_ids']))
    def batch_inputs(ids):return dict(toks['zh'].pad([{k:v[int(index[i])] for k,v in encoded.items()} for i in ids.tolist()],padding=True,return_tensors='pt'))
    # Include genuine singleton-body cases in the actual loss backward audit.
    probe=['嗯','yes','法兰球阀 DN50','请检查这个 request。','到付我发现个困扰','']
    probe_inputs=dict(toks['zh'](probe,padding=True,return_tensors='pt'))
    with torch.no_grad():
        pcn=model.features_one('zh',**probe_inputs)
        pen=model.features_one('en',**dict(toks['en'](probe,padding=True,return_tensors='pt')))
        pt=cached_logits(model,pcn,pen)
    checks={}
    for arm in ['head','last2']:
        check,_,_=build(arm)
        checks[arm]=gradient_check(check,probe_inputs,pcn,pen,pt,
            torch.nn.functional.one_hot(torch.tensor([0,0,0,0,1,0]),2).float(),
            torch.tensor([1.,.75,1.,1.,1.,.75]),torch.tensor([1.,1.,0.,1.,0.,0.]),protocol,device,arm=='last2')
    save(WORK/'gradient-preflight.json',checks)
    save(WORK/'training-started.json',{'created_at_utc':datetime.now(timezone.utc).isoformat(),'manifest_sha256':sha(WORK/'manifest.json'),
        'device':torch_directml.device_name(0).rstrip('\x00'),'torch':torch.__version__,'gradient_preflight':checks,
        'code_sha256':{p.name:sha(p) for p in [Path(__file__),ROOT/'tools/semantic_device_loss.py',ROOT/'tools/semantic_device_optim.py']}})
    del model,check;history=[];started=time.perf_counter();cw=torch.tensor(protocol['class_weights']).to(device)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        for arm in ['head','last2']:
            torch.manual_seed(protocol['seed']);model,_,names=build(arm);model.to(device)
            frozen_state={k:v.detach().cpu().clone() for k,v in model.state_dict().items() if k not in names}
            head=list(model.head.parameters());encoder=[p for n,p in model.named_parameters() if p.requires_grad and not n.startswith('head.')]
            groups=[{'params':head,'lr':protocol['head_lr']}]
            if encoder:groups.append({'params':encoder,'lr':protocol['encoder_lr']})
            optimizer=PortableAdamW(groups,lr=protocol['head_lr']);parameters=head+encoder
            save(WORK/f'{arm}-parameters.json',{'trainable':sum(p.numel() for p in parameters),'encoder':sum(p.numel() for p in encoder)})
            for epoch in range(1,protocol['epochs']+1):
                model.eval();model.head.train();losses=[];tick=time.perf_counter();batches=[];permutation=torch.randperm(len(rows)).tolist()
                for start in range(0,len(rows),protocol['bucket_size']):
                    bucket=sorted(permutation[start:start+protocol['bucket_size']],key=lambda i:lengths[int(index[i])])
                    batches.extend(bucket[i:i+protocol['batch_size']] for i in range(0,len(bucket),protocol['batch_size']))
                for step,batch_no in enumerate(torch.randperm(len(batches)).tolist()):
                    ids=torch.tensor(batches[batch_no]);optimizer.zero_grad(set_to_none=True)
                    logits=cached_logits(model,cn[index[ids]].to(device),en[index[ids]].to(device)) if arm=='head' else train_logits(model,{k:v.to(device) for k,v in batch_inputs(ids).items()},en[index[ids]].to(device))
                    loss=r9.loss_for(logits,teacher[index[ids]].to(device),one_hot[ids].to(device),weights[ids].to(device),mask[ids].to(device),protocol,cw)
                    loss.backward();torch.nn.utils.clip_grad_norm_(parameters,1.,foreach=False,error_if_nonfinite=True);optimizer.step()
                    value=float(loss.detach().cpu());assert math.isfinite(value);losses.append(value)
                    if step and step%100==0:print({'phase':'train','arm':arm,'epoch':epoch,'batch':step,'total':len(batches)},flush=True)
                for k,v in frozen_state.items():assert torch.equal(model.state_dict()[k].detach().cpu(),v),'Frozen tensor changed: '+k
                record={'arm':arm,'epoch':epoch,'seconds':time.perf_counter()-tick,'mean_loss':sum(losses)/len(losses),'frozen_tensors_bitwise_unchanged':True}
                print(record,flush=True)
                if epoch in protocol['checkpoints']:
                    path=WORK/f'{arm}-epoch-{epoch}.safetensors';state={n:p.detach().cpu().contiguous() for n,p in model.named_parameters() if p.requires_grad}
                    assert set(state)==names and all(torch.isfinite(v).all() for v in state.values());save_file(state,str(path));history.append(record|{'weights_sha256':sha(path)})
            del model,optimizer,head,encoder,parameters,frozen_state
    save(WORK/'training-history.json',{'history':history,'warnings':sorted({str(w.message) for w in caught}),'seconds':time.perf_counter()-started})
    subprocess.run([str(CPU),'-X','utf8',str(Path(__file__)),'export-all'],cwd=ROOT,check=True)
    records=[read(WORK/'baseline-epoch-0-cal.json')]+[read(WORK/f"{h['arm']}-epoch-{h['epoch']}-cal.json")|h for h in history]
    key=lambda h:(h['cal']['minimum_language_noise_recall'],h['cal']['noise_macro_language_recall'],-h['cal']['normal_false_positives'][0],-protocol['arms'].index(h['arm']),-h['epoch'])
    by_arm={arm:max([h for h in records if h['arm']==arm],key=key) for arm in protocol['arms']}
    save(WORK/'selection.json',{'selected':max(records,key=key),'by_arm':by_arm,'history':records,
        'sealed_at_utc':datetime.now(timezone.utc).isoformat(),'split_hashes':manifest['split_hashes'],'test_opened':False,
        'prospective_files_absent_at_seal':not (ROOT/'data/ime-keyboard/notepad-batch-005.jsonl').exists() and not (WORK/'public-candidates.json').exists()})
    print({'phase':'selected','selected':read(WORK/'selection.json')['selected']},flush=True)


def export_all():
    import torch
    import numpy as np
    import onnxruntime as ort
    from onnxruntime.quantization import quantize_dynamic,QuantType
    data,manifest=frozen();torch.set_num_threads(4);torch.set_num_interop_threads(1)
    configurations=[('baseline',0)]+[(a,e) for a in ['head','last2'] for e in manifest['protocol']['checkpoints']]
    for arm,epoch in configurations:
        model,toks,_=build(arm,None if epoch==0 else WORK/f'{arm}-epoch-{epoch}.safetensors');model.eval()
        names=['z_'+n for n in r6.NAMES]+['e_'+n for n in r6.NAMES];inp=r9.encode(toks,'请检查这个 request。',return_tensors='pt')
        stem=f'{arm}-epoch-{epoch}';full=WORK/(stem+'.onnx');small=WORK/(stem+'-int8.onnx');assert not full.exists()
        torch.onnx.export(model,tuple(inp[n] for n in names),str(full),input_names=names,output_names=['margin'],
            dynamic_axes={n:{0:'batch',1:n[:2]+'sequence'} for n in names}|{'margin':{0:'batch'}},opset_version=17,dynamo=False)
        options=ort.SessionOptions();options.intra_op_num_threads=4;options.inter_op_num_threads=1
        session=ort.InferenceSession(str(full),options,providers=['CPUExecutionProvider']);drift=0.
        with torch.no_grad():
            for text in [r['text'] for r in data['cal'][:12]]+['嗯','yes','',"console.log('ok')",'法兰球阀 DN50','到付我发现个困扰']:
                inp=r9.encode(toks,text,return_tensors='pt');a=session.run(None,{n:inp[n].numpy() for n in names})[0]
                drift=max(drift,float(np.abs(a-model(**inp).numpy()).max()))
        assert drift<.001,drift
        quantize_dynamic(str(full),str(small),weight_type=QuantType.QInt8)
        scores,native,truncated=score(small,data['cal'],stem+'-cal');assert truncated==0
        thresholds,metrics=cal9.calibrated(data['cal'],scores)
        bases=read(WORK/'bases.json');vocab=sum((Path(bases[f'{lang}_folder'])/'vocab.txt').stat().st_size for lang in ['zh','en'])
        record={'arm':arm,'epoch':epoch,'artifact':small.name,'artifact_sha256':sha(small),'artifact_bytes':small.stat().st_size,
            'artifact_and_vocab_bytes':small.stat().st_size+vocab,'thresholds':thresholds,'cal':metrics,
            'fp32_export_max_drift':drift,'native_version':native['native_version']}
        assert record['artifact_and_vocab_bytes']<=manifest['protocol']['budget_bytes']
        save(WORK/(stem+'-cal.json'),record)
        print({'arm':arm,'epoch':epoch,'noise':metrics['noise_languages'],'normal':metrics['normal_false_positives'],'context':metrics['context_warnings']},flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['prepare','train','export-all']);args=p.parse_args();globals()[args.command.replace('-','_')]()
