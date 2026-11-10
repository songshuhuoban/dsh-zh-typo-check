"""CAL-only late fusion screen; three frozen encoders fit a shared 50MB budget."""
import argparse
from datetime import datetime,timezone
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1];WORK=ROOT/'.research/semantic-round8'
spec=importlib.util.spec_from_file_location('r7',ROOT/'tools/semantic-round7.py')
r7=importlib.util.module_from_spec(spec);spec.loader.exec_module(r7)
read,save,sha=r7.read,r7.save,r7.sha;r4=r7.r4;r6=r7.r6


def prepare():
    assert not (WORK/'manifest.json').exists();WORK.mkdir(exist_ok=True)
    data,parent=r7.frozen();data['known_round7_ime']=read(r7.WORK/'prospective-ime-prepared.json')['rows']
    first=read(ROOT/'.research/semantic-round3/selection.json');second=read(r6.WORK/'selection.json')
    models={'round3':{'path':str(ROOT/'.research/semantic-round3'/first['selected']['artifact']),'sha256':first['checkpoint_sha256']},
        'round6':{'path':str(r6.WORK/second['selected']['artifact']),'sha256':second['selected']['artifact_sha256']}}
    assert all(sha(Path(m['path']))==m['sha256'] for m in models.values())
    bases=read(r6.WORK/'bases.json');footprint=sum(Path(m['path']).stat().st_size for m in models.values())
    footprint+=sum((Path(bases[f'{lang}_folder'])/'vocab.txt').stat().st_size for lang in ['zh','en'])
    manifest={'created_at_utc':datetime.now(timezone.utc).isoformat(),'models':models,'artifact_and_shared_vocab_bytes':footprint,
        'parent_manifest_sha256':sha(r7.WORK/'manifest.json'),'split_hashes':{s:r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True)) for s,rows in data.items()},
        'protocol':{'alphas':[0.,.25,.5,.75,1.],'normalization':'Unique TRAIN population standard deviation of each raw noise margin; no mean subtraction',
            'fusion':'(1-alpha)*R3/scale3 + alpha*R6/scale6; separate CAL alpha/threshold per language',
            'threshold':'Same R6: normal99%/each-normal-category99%/max-context/min0, strict >',
            'selection':'Per language CAL max noise recall, min normal FP, alpha closest0.5 then lower alpha',
            'prior_tests':'All known regressions, including200 actual-IME outputs; never described as fresh',
            'prospective_guard':'Only collect a new40 actual-IME cohort if ALL retained regression/size/latency gates pass',
            'budget_bytes':50_000_000,'new_ime_retention':'Two new known batches: >=39/48 noise, no normal warning, <=2/27 context'},
        'sources':{str(p.relative_to(ROOT)):sha(p) for p in [ROOT/'.research/semantic-round5/results.json',r6.WORK/'results.json',
            r6.WORK/'prospective-ime-results.json',r7.WORK/'prospective-ime-results.json']},'code_sha256':sha(Path(__file__))}
    save(WORK/'bases.json',bases);save(WORK/'prepared.json',data);save(WORK/'manifest.json',manifest)


def frozen():
    data,manifest=read(WORK/'prepared.json'),read(WORK/'manifest.json')
    for s,rows in data.items():assert r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True))==manifest['split_hashes'][s]
    for model in manifest['models'].values():assert sha(Path(model['path']))==model['sha256']
    for p,h in manifest['sources'].items():assert sha(ROOT/p)==h
    return data,manifest


def calibrate():
    import numpy as np
    import torch
    from safetensors.torch import load_file
    assert not (WORK/'selection.json').exists() and not (WORK/'results.json').exists()
    data,manifest=frozen();torch.set_num_threads(4)
    first=load_file(str(ROOT/'.research/semantic-round5/train-features.safetensors'))['base_logits']
    features=load_file(str(r6.WORK/'train-features.safetensors'))['features']
    chosen=read(r6.WORK/'selection.json')['selected']
    state=load_file(str(r6.WORK/f"dual-epoch-{chosen['epoch']}-head.safetensors"))
    assert sha(r6.WORK/f"dual-epoch-{chosen['epoch']}-head.safetensors")==chosen['head_sha256']
    with torch.no_grad():
        value=((features-state['center'])/state['scale']).clamp(-10,10)
        hidden=torch.nn.functional.gelu(torch.nn.functional.linear(value,state['head.0.weight'],state['head.0.bias']))
        second=torch.nn.functional.linear(hidden,state['head.3.weight'],state['head.3.bias'])
        margins=[v[:,1]-torch.maximum(v[:,0],v[:,2]) for v in [first,second]]
        scales=[float(v.std(unbiased=False)) for v in margins];assert min(scales)>.001
    r4.r2.WORK=WORK;a,_,truncated=r4.r2.node_scores(Path(manifest['models']['round3']['path']),data['cal'],'r3-cal');assert truncated==0
    # R6 selected native CAL scores, from the identical frozen CAL ordering.
    b=np.array(read(r6.WORK/f"dual-epoch-{chosen['epoch']}-cal-scores.json")['margins']);assert len(a)==len(b)==len(data['cal'])
    history={};selected={}
    for lang in ['en','zh','mixed']:
        ids=[i for i,r in enumerate(data['cal']) if r4.language(r['text'])==lang];rows=[data['cal'][i] for i in ids];records=[]
        for alpha in manifest['protocol']['alphas']:
            scores=(1-alpha)*a[ids]/scales[0]+alpha*b[ids]/scales[1]
            threshold=r6.operating_point(rows,scores);metrics=r4.measured(rows,scores,threshold)
            records.append({'alpha':alpha,'threshold':threshold,'cal':metrics})
        selected[lang]=max(records,key=lambda h:(h['cal']['noise_macro_language_recall'],-h['cal']['normal_false_positives'][0],-abs(h['alpha']-.5),-h['alpha']))
        history[lang]=records
    scores=np.array([(1-selected[r4.language(r['text'])]['alpha'])*x/scales[0]+selected[r4.language(r['text'])]['alpha']*y/scales[1] for r,x,y in zip(data['cal'],a,b)])
    adjusted=scores-np.array([selected[r4.language(r['text'])]['threshold'] for r in data['cal']])
    save(WORK/'selection.json',{'selected':selected,'history':history,'scales':scales,'cal':r4.measured(data['cal'],adjusted,0.),
        'sealed_at_utc':datetime.now(timezone.utc).isoformat(),'split_hashes':manifest['split_hashes'],
        'r6_cal_scores_sha256':sha(r6.WORK/f"dual-epoch-{chosen['epoch']}-cal-scores.json"),'test_opened':False})
    print(json.dumps({'selected':{lang:{k:v[k] for k in ['alpha','threshold']} for lang,v in selected.items()},'scales':scales}),flush=True)


def known_scores(split):
    if split=='known_round6_ime':
        obj=read(r6.WORK/'prospective-ime-results.json')['configurations'];a,b=obj['round3'],obj['dual']
    elif split=='known_round7_ime':
        obj=read(r7.WORK/'prospective-ime-results.json')['configurations'];a,b=obj['round3'],obj['round6']
    else:
        a=read(ROOT/'.research/semantic-round5/results.json')['configurations']['round3']['splits'][split]
        b=read(r6.WORK/'results.json')['configurations']['dual']['splits'][split]
    return a['predictions'],b['predictions']


def evaluate():
    import numpy as np
    assert not (WORK/'results.json').exists();data,manifest=frozen();selection=read(WORK/'selection.json')
    assert selection['split_hashes']==manifest['split_hashes'];selected=selection['selected'];scales=selection['scales'];out={}
    for split,rows in data.items():
        if split in ['train','cal']:continue
        a,b=known_scores(split);assert len(a)==len(b)==len(rows)
        assert all(x['label']==y['label']==r['label'] for r,x,y in zip(rows,a,b))
        scores=np.array([(1-selected[r4.language(r['text'])]['alpha'])*x['raw_score']/scales[0]+selected[r4.language(r['text'])]['alpha']*y['raw_score']/scales[1] for r,x,y in zip(rows,a,b)])
        adjusted=scores-np.array([selected[r4.language(r['text'])]['threshold'] for r in rows])
        out[split]={'metrics':r4.measured(rows,adjusted,0.),'predictions':[{'index':i,'label':r['label'],'raw_score':float(s),'score':float(t),'warning':bool(t>0)} for i,(r,s,t) in enumerate(zip(rows,scores,adjusted))]}
    # Actual sequential two-session measurement, never sum separately observed p95s.
    original=r6.WORK
    try:
        r6.WORK=WORK
        _,_,truncated=r6.node_scores(Path(manifest['models']['round6']['path']),data['known_round2'],'timing-inputs','dual');assert truncated==0
    finally:r6.WORK=original
    inp=WORK/'timing-inputs-inputs.json';timing=WORK/'combined-native.json'
    subprocess.run(['node',str(ROOT/'tools/semantic-fusion-native.mjs'),manifest['models']['round3']['path'],manifest['models']['round6']['path'],str(inp),str(timing)],cwd=ROOT,check=True)
    native=read(timing);a,b=known_scores('known_round2')
    drift=max(abs(float(v)-p['raw_score']) for pair,x,y in zip(native['pairs'],a,b) for v,p in zip(pair,[x,y]));assert drift<1e-5
    source='女哦就是的感受a到啊删掉asd苏打粉二十个s收到'
    original=next(p for r,p in zip(data['known_legacy'],out['known_legacy']['predictions']) if r['text']==source)
    fresh=out['fresh_challenge']['metrics'];new=[out[s]['metrics'] for s in ['known_round6_ime','known_round7_ime']]
    gates={'original':original['warning'],'old_normals':sum(out[s]['metrics']['normal_false_positives'][0] for s in ['known_round2','known_legacy'])==0,
        'r5_challenge_normal':fresh['normal_false_positives'][0]<=1,'r5_challenge_context':fresh['context_warnings'][0]<=1,
        'r5_en_noise':fresh['noise_languages']['en'][0]>=9,'r5_mixed_noise':fresh['noise_languages']['mixed'][0]>=9,
        'old_ime':out['known_ime']['metrics']['noise_detected'][0]>=12,'old_noise':out['known_round2']['metrics']['noise_detected'][0]>=19,
        'public_normal':out['new_public_test']['metrics']['normal_false_positives'][0]<=5,
        'new_ime_noise':sum(m['noise_detected'][0] for m in new)>=39,
        'new_ime_normal':sum(m['normal_false_positives'][0] for m in new)==0,
        'new_ime_context':sum(m['context_warnings'][0] for m in new)<=2,
        'size':manifest['artifact_and_shared_vocab_bytes']<=50_000_000,'latency':native['latency_p95_ms']<=15}
    result={'manifest':manifest,'selection':selection,'splits':out,'original':original,'gates':gates,'all_gates_passed':all(gates.values()),
        'native_latency':{k:v for k,v in native.items() if k!='pairs'},'cached_score_vs_combined_native_max_drift':drift,
        'new_prospective_capture_required':all(gates.values()),'new_entropy_consumed':0,'test_role':'known_regression_only'}
    save(WORK/'results.json',result);save(ROOT/'data/semantic-round8-results.json',result)
    print(json.dumps({'gates':gates,'metrics':{s:v['metrics'] for s,v in out.items()},'latency':result['native_latency']}),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['prepare','calibrate','evaluate']);args=p.parse_args();globals()[args.command]()
