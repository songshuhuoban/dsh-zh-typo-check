"""CAL-only language-stratified comparison, declared before opening R4 TEST.

Preserves the original R4 protocol/model; adds three thresholds using exactly
the same normal/context constraints within each language stratum.
"""
import argparse
from datetime import datetime,timezone
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/'.research/semantic-round4'
spec=importlib.util.spec_from_file_location('round4',ROOT/'tools/semantic-round4.py')
r4=importlib.util.module_from_spec(spec);spec.loader.exec_module(r4)


def plan():
    assert not (WORK/'results.json').exists() and not (WORK/'calibration-plan.json').exists()
    _,manifest=r4.frozen()
    r4.save(WORK/'calibration-plan.json',{
        'created_at_utc':datetime.now(timezone.utc).isoformat(),
        'test_results_absent_at_declaration':True,'manifest_sha256':r4.sha(WORK/'manifest.json'),
        'test_role':'previously_opened_R4_regression' if WORK.name!='semantic-round4' else 'R4_initial_holdout',
        'split_hashes':manifest['split_hashes'],
        'reason':'CAL-only: Chinese/mixed context outliers raise the single cutoff for otherwise separable English noise.',
        'language_definition':'CJK + contiguous >=2 Latin letters: mixed; CJK only: zh; otherwise en.',
        'threshold_rule':'Same R3 normal overall99%, per-source97.5%, max context, minimum0, computed within each language.',
        'epoch_selection':'CAL max macro language noise recall, min normal FP, earliest epoch; no TEST scores.',
        'original_global_working_point_retained':True,
        'code_sha256':r4.sha(Path(__file__)),
    })


def calibrate():
    import numpy as np
    assert not (WORK/'results.json').exists() and not (WORK/'calibration-selection.json').exists()
    data,manifest=r4.frozen();plan=r4.read(WORK/'calibration-plan.json')
    assert r4.sha(WORK/'manifest.json')==plan['manifest_sha256']
    history=[]
    for epoch in [1,2,3]:
        record=r4.read(WORK/f'epoch-{epoch}-cal.json')
        scores=np.array(r4.read(WORK/f'epoch-{epoch}-cal-scores.json')['margins'])
        thresholds={}
        for lang in ['en','zh','mixed']:
            ids=[i for i,r in enumerate(data['cal']) if r4.language(r['text'])==lang]
            rows=[data['cal'][i] for i in ids]
            assert sum(r['label']==0 for r in rows)>=30 and sum(r['label']==1 for r in rows)>=5
            thresholds[lang]=r4.r2.operating_point(rows,scores[ids])
        adjusted=scores-np.array([thresholds[r4.language(r['text'])] for r in data['cal']])
        metrics=r4.measured(data['cal'],adjusted,0.)
        assert metrics['context_warnings'][0]==0
        history.append({'epoch':epoch,'artifact':record['artifact'],'thresholds':thresholds,'cal':metrics,
                        'artifact_sha256':r4.sha(WORK/record['artifact'])})
    chosen=max(history,key=lambda h:(h['cal']['noise_macro_language_recall'],-h['cal']['normal_false_positives'][0],-h['epoch']))
    r4.save(WORK/'calibration-selection.json',{'selected':chosen,'history':history,
        'plan_sha256':r4.sha(WORK/'calibration-plan.json'),'split_hashes':manifest['split_hashes'],
        'selected_before_test_results':True,'selected_at_utc':datetime.now(timezone.utc).isoformat()})
    print(json.dumps({'phase':'language-cal-selected',**chosen}),flush=True)


def evaluate():
    import numpy as np
    assert not (WORK/'calibrated-results.json').exists()
    data,manifest=r4.frozen();selection=r4.read(WORK/'calibration-selection.json')
    assert selection['split_hashes']==manifest['split_hashes'] and selection['selected_before_test_results']
    assert r4.sha(WORK/'calibration-plan.json')==selection['plan_sha256']
    chosen=selection['selected'];model=WORK/chosen['artifact']
    assert r4.sha(model)==chosen['artifact_sha256']
    output={'thresholds':chosen['thresholds'],'selection':selection,'splits':{}}
    for split in ['new_challenge','new_public_test','known_ime','known_round2','known_legacy']:
        scores,native,truncated=r4.r2.node_scores(model,data[split],'language-calibrated-'+split);assert truncated==0
        adjusted=scores-np.array([chosen['thresholds'][r4.language(r['text'])] for r in data[split]])
        output['splits'][split]={'metrics':r4.measured(data[split],adjusted,0.),
            'latency_p50_ms':native['latency_p50_ms'],'latency_p95_ms':native['latency_p95_ms'],
            'truncated':0,'native_version':native['native_version'],
            'predictions':[{'index':i,'group':r.get('group',f'{split}-{i}'),'label':r['label'],
                            'category':r.get('category','legacy'),'language':r4.language(r['text']),
                            'raw_score':float(raw),'score':float(a),'warning':bool(a>0)}
                           for i,(r,raw,a) in enumerate(zip(data[split],scores,adjusted))]}
    r4.save(WORK/'calibrated-results.json',output)
    print(json.dumps({'phase':'language-cal-results','metrics':{s:v['metrics'] for s,v in output['splits'].items()}}),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['plan','calibrate','evaluate'])
    p.add_argument('--workdir',type=Path,default=WORK);args=p.parse_args()
    WORK=args.workdir.resolve();r4.WORK=WORK;r4.r2.WORK=WORK
    {'plan':plan,'calibrate':calibrate,'evaluate':evaluate}[args.command]()
