"""Separate pre-TEST small-source resolution comparison; primary plan unchanged."""
import argparse
from datetime import datetime,timezone
import importlib.util
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('r9',ROOT/'tools/semantic-round9.py')
r9=importlib.util.module_from_spec(spec);spec.loader.exec_module(r9)
WORK=r9.WORK


def plan():
    assert not (WORK/'results.json').exists() and not (WORK/'calibration-plan.json').exists()
    assert not (ROOT/'data/ime-keyboard/notepad-batch-004.jsonl').exists()
    _,manifest=r9.frozen()
    r9.save(WORK/'calibration-plan.json',{'created_at_utc':datetime.now(timezone.utc).isoformat(),
        'manifest_sha256':r9.sha(WORK/'manifest.json'),'primary_selection_sha256':r9.sha(WORK/'selection.json'),
        'tests_absent_at_declaration':True,'reason':'CAL showed source strata with <=100 normal examples have higher99% quantile equal to MAX; one disfluent source utterance dominates Chinese cutoff.',
        'normal_rule':'Per-language pooled99%-higher plus per-source99%-higher only if normal n>=101; contextMAX and min0 unchanged; strict >',
        'selection':'Same max minimum language noise recall, macro recall, min normal FP, earliest epoch1/3/6',
        'original_protocol_preserved':True,'old_model_recalibrated_under_same_rule':True,
        'prior_test_role':'known regression; new_short_test newly curated before fit; batch004 actual prospective after both seals',
        'code_sha256':r9.sha(Path(__file__)),'data_split_hashes':manifest['split_hashes']})


def cutoff(rows,scores):
    import numpy as np
    clean=[(r,float(s)) for r,s in zip(rows,scores) if r['label']==0]
    assert len(clean)>=30
    limits=[0.,float(np.quantile([s for _,s in clean],.99,method='higher'))]
    for category in {r['category'] for r,_ in clean}:
        vals=[s for r,s in clean if r['category']==category]
        if len(vals)>=101:limits.append(float(np.quantile(vals,.99,method='higher')))
    limits.extend(float(s) for r,s in zip(rows,scores) if r['label']==2)
    return max(limits)


def calibrated(rows,scores):
    import numpy as np
    thresholds={}
    for lang in ['en','zh','mixed']:
        ids=[i for i,r in enumerate(rows) if r9.r4.language(r['text'])==lang]
        thresholds[lang]=cutoff([rows[i] for i in ids],scores[ids])
    adjusted=scores-np.array([thresholds[r9.r4.language(r['text'])] for r in rows])
    metrics=r9.r4.measured(rows,adjusted,0.)
    metrics['minimum_language_noise_recall']=min(v[0]/v[1] for v in metrics['noise_languages'].values() if v[1])
    return thresholds,metrics


def calibrate():
    import numpy as np
    assert not (WORK/'results.json').exists() and not (WORK/'calibration-selection.json').exists()
    data,manifest=r9.frozen();plan=r9.read(WORK/'calibration-plan.json')
    assert r9.sha(WORK/'manifest.json')==plan['manifest_sha256'] and r9.sha(WORK/'selection.json')==plan['primary_selection_sha256']
    history=[]
    for epoch in [1,3,6]:
        record=r9.read(WORK/f'epoch-{epoch}-cal.json')
        scores=np.array(r9.read(WORK/f'epoch-{epoch}-cal-scores.json')['margins'])
        thresholds,metrics=calibrated(data['cal'],scores)
        history.append(record|{'thresholds':thresholds,'cal':metrics})
    selected=max(history,key=lambda h:(h['cal']['minimum_language_noise_recall'],h['cal']['noise_macro_language_recall'],-h['cal']['normal_false_positives'][0],-h['epoch']))
    scores=np.array(r9.read(WORK/'baseline-cal-scores.json')['margins'])
    thresholds,metrics=calibrated(data['cal'],scores)
    r9.save(WORK/'calibration-selection.json',{'selected':selected,'history':history,'baseline':{'thresholds':thresholds,'cal':metrics},
        'sealed_at_utc':datetime.now(timezone.utc).isoformat(),'plan_sha256':r9.sha(WORK/'calibration-plan.json'),
        'data_split_hashes':manifest['split_hashes'],'selected_before_test':True})
    print({'epoch':selected['epoch'],'thresholds':selected['thresholds'],'noise':selected['cal']['noise_languages'],
        'normal':selected['cal']['normal_false_positives'],'context':selected['cal']['context_warnings']},flush=True)


def evaluate():
    import numpy as np
    assert not (WORK/'pooled-results.json').exists()
    data,manifest=r9.frozen();selection=r9.read(WORK/'calibration-selection.json');primary=r9.read(WORK/'results.json')
    assert selection['data_split_hashes']==manifest['split_hashes'] and selection['selected_before_test']
    chosen=selection['selected'];path=WORK/chosen['artifact'];assert r9.sha(path)==chosen['artifact_sha256']
    out={'selection':selection,'configurations':{'r6_pooled':{'splits':{}},'round9_pooled':{'splits':{}}}}
    for split in primary['configurations']['round9']['splits']:
        original=primary['configurations']['r6_original']['splits'][split]
        if chosen['artifact_sha256']==primary['selection']['selected']['artifact_sha256']:
            new=primary['configurations']['round9']['splits'][split]
            scores=np.array([p['raw_score'] for p in new['predictions']]);p95=new['p95_ms']
        else:
            scores,native,truncated=r9.score(path,data[split],'pooled-'+split);assert truncated==0;p95=native['latency_p95_ms']
        for name,raw,cutoffs,latency in [('r6_pooled',np.array([p['raw_score'] for p in original['predictions']]),selection['baseline']['thresholds'],original['p95_ms']),
                ('round9_pooled',scores,chosen['thresholds'],p95)]:
            adjusted=raw-np.array([cutoffs[r9.r4.language(r['text'])] for r in data[split]])
            out['configurations'][name]['splits'][split]={'metrics':r9.r4.measured(data[split],adjusted,0.),'p95_ms':latency,
                'predictions':[{'index':i,'label':r['label'],'category':r['category'],'group':r.get('group',f'{split}-{i}'),
                    'raw_score':float(s),'score':float(a),'warning':bool(a>0)} for i,(r,s,a) in enumerate(zip(data[split],raw,adjusted))]}
    r9.save(WORK/'pooled-results.json',out)
    print({n:{s:v['metrics'] for s,v in c['splits'].items()} for n,c in out['configurations'].items()},flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['plan','calibrate','evaluate']);args=p.parse_args();globals()[args.command]()
