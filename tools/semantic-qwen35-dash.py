"""Prespecified exploratory DASH-Q alternative; original six jobs stay immutable."""
import argparse
from datetime import datetime,timezone
import importlib.util
import json
from pathlib import Path
import shutil

ROOT=Path(__file__).resolve().parents[1];BASE=ROOT/'.research/semantic-qwen35';WORK=ROOT/'.research/semantic-qwen35-dash'
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def save(p,d):p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')


def plan():
    assert not (WORK/'supplemental-plan.json').exists();WORK.mkdir(exist_ok=True)
    source=read(ROOT/'.research/qwen35-quant-survey-20261110.json')['repositories'][2]
    item=source['files'][0];assert source['repo']=='jkim96/Qwen3.5-0.8B-DASHQ-Q2-GGUF'
    save(WORK/'supplemental-plan.json',{'created_at_utc':datetime.now(timezone.utc).isoformat(),'issue':'SIM-1049',
        'reason':'Q3_CPU showed severe missed-noise increase under fixed prompt. Add a separately-published2bit method as exploratory comparison, not an independent holdout or revision of original results.',
        'prompt':'Use the exact prior CAL-selected3-shot prompt, no tuning on DASH outcomes','data':'Same675 known-regression rows, unchanged labels',
        'candidate':{'name':'q2dash','file':'models/'+item['file'],'bytes':item['bytes'],'sha256':item['sha256'],
            'repo':source['repo'],'revision':source['revision'],
            'url':f"https://huggingface.co/{source['repo']}/resolve/{source['revision']}/{item['file']}?download=true"},
        'runtime':'Same official b12110 portable binaries; separately score CPU and Vulkan.'})
    print({'supplemental_candidate':item['file'],'bytes':item['bytes']},flush=True)


def run():
    assert (BASE/'results.json').exists(),'Finish original benchmark before extra download/inference to avoid contention'
    spec=importlib.util.spec_from_file_location('download',ROOT/'tools/semantic-qwen35-download.py')
    downloader=importlib.util.module_from_spec(spec);spec.loader.exec_module(downloader);downloader.WORK=WORK
    extra=read(WORK/'supplemental-plan.json');record=downloader.download(extra['candidate'])
    source=read(BASE/'downloads.json')
    downloads=dict(source,files=[record],shared_runtime_source=str((BASE/'downloads.json').relative_to(ROOT)))
    if not (WORK/'downloads.json').exists():save(WORK/'downloads.json',downloads)
    else:assert read(WORK/'downloads.json')==downloads,'Keep supplemental download identity immutable on resume'
    for filename in ['prepared.json','r13-reference.json','calibration-selection.json','r13-local-evaluation.json','completion-policy.json']:
        destination=WORK/filename
        if not destination.exists():shutil.copy2(BASE/filename,destination)
    if not (WORK/'manifest.json').exists():
        manifest=read(BASE/'manifest.json');manifest['created_at_utc']=datetime.now(timezone.utc).isoformat()
        manifest['protocol']['variants']=['q2dash'];manifest['supplemental_to']=str((BASE/'manifest.json').relative_to(ROOT))
        manifest['source_hashes'].update({str(p.relative_to(ROOT)):downloader.sha(p) for p in [WORK/'downloads.json',WORK/'supplemental-plan.json',BASE/'calibration-selection.json',BASE/'results.json']})
        save(WORK/'manifest.json',manifest)
    if not (WORK/'benchmark-plan.json').exists():
        bplan=read(BASE/'benchmark-plan.json');bplan['created_at_utc']=datetime.now(timezone.utc).isoformat();bplan['variants']=['q2dash']
        bplan['manifest_sha256']=downloader.sha(WORK/'manifest.json');bplan['calibration_selection_sha256']=downloader.sha(WORK/'calibration-selection.json')
        bplan['note']='Exploratory additional quantization publisher after original known-regression results; frozen prompt/data and same runtime; no new-blind claim.'
        save(WORK/'benchmark-plan.json',bplan)
    spec=importlib.util.spec_from_file_location('bench',ROOT/'tools/semantic-qwen35-benchmark.py')
    bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
    bench.WORK=WORK;bench.q.WORK=WORK;bench.evaluation.WORK=WORK;bench.q.configuration.cache_clear();bench.q.completion_policy.cache_clear()
    bench.run_all()
    # Original data/semantic-qwen35-results.json belongs to the primary study.
    shutil.copy2(WORK/'results.json',ROOT/'data/semantic-qwen35-dash-results.json')
    shutil.copy2(BASE/'results.json',ROOT/'data/semantic-qwen35-results.json')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['plan','run']);a=p.parse_args();globals()[a.command]()
