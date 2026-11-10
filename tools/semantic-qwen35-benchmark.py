"""Separate CPU/Vulkan task measurements of three pinned GGUF precisions."""
import argparse
from datetime import datetime,timezone
import importlib.util
import json
import math
from pathlib import Path
import time

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('evaluation',ROOT/'tools/semantic-qwen35-evaluate.py')
evaluation=importlib.util.module_from_spec(spec);spec.loader.exec_module(evaluation)
q=evaluation.q;WORK=q.WORK;read,save,sha=q.read,q.save,q.sha;metrics=evaluation.metrics


def plan():
    data,manifest=q.frozen();selection=read(WORK/'calibration-selection.json');assert not (WORK/'benchmark-plan.json').exists()
    assert not list(WORK.glob('*-evaluation.json'))
    save(WORK/'benchmark-plan.json',{'created_at_utc':datetime.now(timezone.utc).isoformat(),
        'manifest_sha256':sha(WORK/'manifest.json'),'calibration_selection_sha256':sha(WORK/'calibration-selection.json'),
        'prompt_variant':selection['selected']['name'],'variants':['q4','q3','q2'],'backends':['cpu','vulkan'],
        'note':'Because default/FP32-disabled Vulkan probe outputs differ from CPU, report both as separate inference implementations. Neither is assumed ground-truth merely by backend; no equivalence claim, prompt/labels frozen. CPU is main portable reference, Vulkan supplementary task comparison.',
        'rows_per_job':sum(map(len,data.values())),'known_regression_only':True,
        'runtime_source_sha256':{p.name:sha(p) for p in [Path(__file__),ROOT/'tools/semantic-qwen35.py',ROOT/'tools/semantic-qwen35-evaluate.py']}})
    print({'jobs':6,'rows_per_job':sum(map(len,data.values())),'prompt':selection['selected']['name']},flush=True)


def locked():
    data,manifest=q.frozen();plan=read(WORK/'benchmark-plan.json')
    assert sha(WORK/'manifest.json')==plan['manifest_sha256'] and sha(WORK/'calibration-selection.json')==plan['calibration_selection_sha256']
    return data,manifest,plan,read(WORK/'calibration-selection.json')['selected']['config']


def percentiles(values):
    import numpy as np
    return {'n':len(values),'p50':float(np.percentile(values,50)),'p95':float(np.percentile(values,95)),'max':float(max(values))}


def probe(tag):
    data,manifest,plan,config=locked();results={}
    for backend in plan['backends']:
        label=f'{tag}-{backend}-selected-prompt-probes';path=WORK/(label+'.json')
        if path.exists():results[backend]=read(path);continue
        responses=[]
        try:
            with q.server(tag,backend,label) as active:
                for text in manifest['probes']+manifest['probes'][:2]:responses.append({'text':text,**q.classify(active,text,config)})
            result={'ok':True,'responses':responses,'server':read(WORK/(label+'-server.json')),
                'latency_wall_ms':percentiles([r['wall_ms'] for r in responses[3:]])}
        except Exception as error:result={'ok':False,'error':str(error),'responses':responses}
        save(path,result);results[backend]=result
    cpu=results['cpu'];gpu=results['vulkan'];assert cpu['ok'],'CPU selected-prompt protocol failed'
    comparison={'tag':tag,'cpu_ok':cpu['ok'],'vulkan_ok':gpu['ok'],'selected_prompt':plan['prompt_variant']}
    if gpu['ok']:
        comparison['matching_decisions']=[sum(a['code']==b['code'] for a,b in zip(cpu['responses'],gpu['responses'])),len(cpu['responses'])]
    comparison['latency_wall_ms']={b:r.get('latency_wall_ms') for b,r in results.items()}
    save(WORK/(tag+'-selected-prompt-probes.json'),comparison);print(comparison,flush=True)


def evaluate(tag,backend):
    data,manifest,plan,config=locked();stem=f'{tag}-{backend}';final=WORK/(stem+'-evaluation.json')
    if final.exists():print({'already_complete':stem},flush=True);return
    probes=read(WORK/(tag+'-selected-prompt-probes.json'));assert probes[backend+'_ok']
    model=next(j for j in read(WORK/'downloads.json')['files'] if j['name']==tag)
    identity={'tag':tag,'backend':backend,'model_sha256':model['sha256'],'plan_sha256':sha(WORK/'benchmark-plan.json')}
    raw_path=WORK/(stem+'-predictions.jsonl')
    existing=[json.loads(x) for x in raw_path.read_text(encoding='utf8').splitlines()] if raw_path.exists() else []
    expected=[(split,i,row) for split,rows in data.items() for i,row in enumerate(rows)]
    assert len(existing)<=len(expected)
    for record,(split,i,row) in zip(existing,expected):
        assert all(record[k]==v for k,v in identity.items()) and record['split']==split and record['index']==i
        assert record['text_sha256']==q.hashlib.sha256(row['text'].encode('utf-8')).hexdigest()
    memory_samples=[];start=time.perf_counter();new=expected[len(existing):]
    if new:
        run_label=stem+'-full-'+str(len(existing))
        with q.server(tag,backend,run_label) as active,raw_path.open('a',encoding='utf8') as out:
            # Explicit warmup; excluded from per-sample latency.
            for text in manifest['probes'][:3]:q.classify(active,text,config)
            memory_samples.append(q.memory(active['pid']))
            for offset,(split,i,row) in enumerate(new):
                response=q.classify(active,row['text'],config)
                record={**identity,'split':split,'index':i,'id':row.get('id',i),'label':row['label'],
                    'text_sha256':q.hashlib.sha256(row['text'].encode('utf-8')).hexdigest(),**response}
                out.write(json.dumps(record,ensure_ascii=False)+'\n');out.flush();existing.append(record)
                if (offset+1)%25==0:
                    memory_samples.append(q.memory(active['pid']))
                    print({'job':stem,'done':len(existing),'total':len(expected),'last_split':split,'seconds':round(time.perf_counter()-start,1)},flush=True)
            memory_samples.append(q.memory(active['pid']))
    result={**identity,'prompt_variant':plan['prompt_variant'],'known_regression_only':True,'splits':{},
        'elapsed_for_this_run_seconds':time.perf_counter()-start,'memory_samples':memory_samples,
        'latency_wall_ms':percentiles([r['wall_ms'] for r in existing]),'server_runs':[]}
    for path in WORK.glob(stem+'-full-*-server.json'):result['server_runs'].append(read(path))
    for split,rows in data.items():
        predictions=[r for r in existing if r['split']==split]
        result['splits'][split]={'metrics':metrics(rows,predictions),'latency_wall_ms':percentiles([r['wall_ms'] for r in predictions]),'predictions':predictions}
    original='女哦就是的感受a到啊删掉asd苏打粉二十个s收到'
    result['original']=next(p for row,p in zip(data['legacy'],result['splits']['legacy']['predictions']) if row['text']==original)
    result['memory_peak_observed']={k:max(s.get(k,0) for s in memory_samples) for k in ['rss','private','peak_wset','peak_pagefile']} if memory_samples else None
    save(final,result)
    print({'complete':stem,'metrics':{s:v['metrics'] for s,v in result['splits'].items()},'wall_ms':result['latency_wall_ms']},flush=True)


def reference():
    import subprocess
    from transformers import AutoTokenizer
    data,manifest,plan,config=locked();path=WORK/'r13-local-evaluation.json';assert not path.exists()
    original=read(WORK/'r13-reference.json');selected=manifest['r13_artifact'];model=q.r13.WORK/selected['artifact'];assert sha(model)==selected['artifact_sha256']
    bases=read(q.r13.WORK/'bases.json');toks={lang:AutoTokenizer.from_pretrained(bases[f'{lang}_folder'],local_files_only=True,trust_remote_code=False) for lang in ['zh','en']}
    helper=ROOT/'tools/semantic-qwen35-reference.mjs';load_tick=time.perf_counter()
    with (WORK/'r13-native-reference.log').open('w',encoding='utf-8') as err:
        child=subprocess.Popen(['node',str(helper),str(model)],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,
            stderr=err,text=True,encoding='utf-8',bufsize=1,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        try:
            ready=json.loads(child.stdout.readline());assert ready['ready'];load_seconds=time.perf_counter()-load_tick
            def run(text):
                tick=time.perf_counter();inputs={prefix+n:v for lang,prefix in [('zh','z_'),('en','e_')] for n,v in toks[lang](text,truncation=True,max_length=128).items()}
                child.stdin.write(json.dumps({'inputs':inputs},ensure_ascii=False)+'\n');child.stdin.flush()
                response=json.loads(child.stdout.readline());value=response['raw_score'];threshold=selected['thresholds'][q.r13.r4.language(text)]
                return {'raw_score':value,'score':value-threshold,'warning':value>threshold,
                    'wall_ms':(time.perf_counter()-tick)*1000,'native_ms':response['native_ms']}
            for text in manifest['probes'][:5]:run(text)
            splits={};all_times=[];drift=0.
            for name,rows in data.items():
                predictions=[run(row['text']) for row in rows]
                assert [p['warning'] for p in predictions]==[p['warning'] for p in original[name]],name
                drift=max(drift,max(abs(a['raw_score']-b['raw_score']) for a,b in zip(predictions,original[name])))
                splits[name]={'metrics':metrics(rows,predictions),'predictions':predictions,'latency_wall_ms':percentiles([r['wall_ms'] for r in predictions])};all_times.extend(r['wall_ms'] for r in predictions)
            peak=q.memory(child.pid)
        finally:
            child.stdin.close()
            try:child.wait(timeout=15)
            except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
    assert child.returncode==0,child.returncode
    result={'splits':splits,'latency_wall_ms':percentiles(all_times),'native_archive_max_margin_drift':drift,'warning_parity_all675':True,
        'native_version':ready['native_version'],'load_to_ready_seconds':load_seconds,'memory_end':peak,
        'native_helper_sha256':sha(helper),
        'timing_caveat':'Tokenization+Python/Node stdio+native ONNX Runtime+decision, no model load. Qwen wall includes loopback HTTP/template application. Same native runtime as prior R13 scores; Python ORT1.23 diagnostics are separate and not substituted.'}
    save(path,result);print({'r13_reference':result['latency_wall_ms'],'native_drift':drift},flush=True)


def run_all():
    data,manifest,plan,config=locked()
    for tag in plan['variants']:
        probe(tag)
        for backend in plan['backends']:
            check=read(WORK/(tag+'-selected-prompt-probes.json'))
            if check[backend+'_ok']:evaluate(tag,backend)
    if not (WORK/'r13-local-evaluation.json').exists():reference()
    combine()


def combine():
    data,manifest,plan,config=locked();runs={}
    for tag in plan['variants']:
        for backend in plan['backends']:
            path=WORK/f'{tag}-{backend}-evaluation.json'
            if path.exists():runs[tag+'-'+backend]=read(path)
    result={'manifest':manifest,'benchmark_plan':plan,'prompt_calibration':read(WORK/'calibration-selection.json'),
        'downloads':read(WORK/'downloads.json'),'configurations':runs,'r13_reference':read(WORK/'r13-local-evaluation.json'),
        'completion_policy':read(WORK/'completion-policy.json') if (WORK/'completion-policy.json').exists() else None,
        'completed_at_utc':datetime.now(timezone.utc).isoformat(),'source_hashes':{p.name:sha(p) for p in [Path(__file__),ROOT/'tools/semantic-qwen35.py',ROOT/'tools/semantic-qwen35-evaluate.py']}}
    save(WORK/'results.json',result);save(ROOT/'data/semantic-qwen35-results.json',result)
    print({'complete_jobs':len(runs),'result':'data/semantic-qwen35-results.json'},flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['plan','probe','evaluate','reference','run-all','combine']);p.add_argument('--tag',choices=['q4','q3','q2'],default='q4');p.add_argument('--backend',choices=['cpu','vulkan'],default='cpu');a=p.parse_args()
    if a.command=='probe':probe(a.tag)
    elif a.command=='evaluate':evaluate(a.tag,a.backend)
    else:globals()[a.command.replace('-','_')]()
