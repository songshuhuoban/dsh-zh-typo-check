"""Fresh60 actual IME outputs, after R9 seal; label before predictions."""
from datetime import datetime
import argparse
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('r9',ROOT/'tools/semantic-round9.py')
r9=importlib.util.module_from_spec(spec);spec.loader.exec_module(r9)
WORK=r9.WORK;DATA=ROOT/'data/ime-keyboard'


def assemble():
    assert not (WORK/'prospective-ime-results.json').exists()
    raw_path=DATA/'notepad-batch-004.jsonl';labels=r9.read(DATA/'assistant-labels-004.json')
    raw=[json.loads(s) for s in raw_path.read_text(encoding='utf8').splitlines()]
    assert labels['capture_sha256']==r9.sha(raw_path) and not labels['predictions_seen_before_labels']
    decisions={r['id']:r for r in labels['decisions']};assert len(decisions)==len(raw)==60
    pooled=r9.read(WORK/'calibration-selection.json')
    sealed=max(datetime.fromisoformat(r9.read(WORK/'selection.json')['sealed_at_utc']),datetime.fromisoformat(pooled['sealed_at_utc']))
    assert all(datetime.fromisoformat(r['captured_at'].replace('Z','+00:00'))>sealed for r in raw)
    data,_=r9.frozen();protected={r9.r4.r2.canonical(r['text']) for rows in data.values() for r in rows}
    first=[json.loads(s) for s in (DATA/'notepad-batch-001.jsonl').read_text(encoding='utf8').splitlines()]
    protected.update(r9.r4.r2.canonical(r['actual_output_after_one_space']) for r in first)
    seen=set();rows=[];excluded=[]
    for record in raw:
        text=record['actual_output_after_one_space'];key=r9.r4.r2.canonical(text);d=decisions[record['id']]
        reason='pending-composition' if record['pending_composition_detected'] else 'empty' if not key else 'prior-text-overlap' if key in protected else 'new-duplicate' if key in seen else None
        if reason:excluded.append({'id':record['id'],'reason':reason});continue
        seen.add(key);assert d['label'] in [0,1,2] and d['reason']
        rows.append({'id':record['id'],'text':text,'label':d['label'],'category':'r9-prospective-real-ime',
            'confidence':d['confidence'],'group':record['id'],'source':'native-notepad-one-space'})
    r9.save(WORK/'prospective-ime-prepared.json',{'rows':rows,'excluded':excluded,'raw_sha256':r9.sha(raw_path),
        'labels_sha256':r9.sha(DATA/'assistant-labels-004.json'),'selection_sha256':r9.sha(WORK/'selection.json'),
        'calibration_selection_sha256':r9.sha(WORK/'calibration-selection.json'),
        'assembled_before_predictions':True,'label_caveat':'Assistant-only, not independently reviewed.'})
    print(json.dumps({'included':len(rows),'excluded':excluded},ensure_ascii=False))


def evaluate():
    import numpy as np
    assert not (WORK/'prospective-ime-results.json').exists()
    prepared=r9.read(WORK/'prospective-ime-prepared.json');rows=prepared['rows'];sel=r9.read(WORK/'selection.json');chosen=sel['selected']
    assert r9.sha(WORK/'selection.json')==prepared['selection_sha256']
    assert r9.sha(WORK/'calibration-selection.json')==prepared['calibration_selection_sha256']
    pooled=r9.read(WORK/'calibration-selection.json')
    manifest=r9.read(WORK/'manifest.json');old=manifest['initial']
    first,native_first,truncated=r9.score(r9.r6.WORK/old['artifact'],rows,'prospective-r6');assert truncated==0
    second,native_second,truncated=r9.score(WORK/chosen['artifact'],rows,'prospective-r9');assert truncated==0
    r3=r9.read(ROOT/'.research/semantic-round3/selection.json')['selected'];r9.r4.r2.WORK=WORK
    third,native_third,truncated=r9.r4.r2.node_scores(ROOT/'.research/semantic-round3'/r3['artifact'],rows,'prospective-r3');assert truncated==0
    configs=[('r3_original',third,native_third,None),('r6_original',first,native_first,old['thresholds']),
        ('r6_recalibrated',first,native_first,sel['baseline_recalibrated']['thresholds']),('round9',second,native_second,chosen['thresholds'])]
    if pooled['selected']['artifact_sha256']==chosen['artifact_sha256']:
        fourth,native_fourth=second,native_second
    else:
        fourth,native_fourth,truncated=r9.score(WORK/pooled['selected']['artifact'],rows,'prospective-r9-pooled');assert truncated==0
    configs.extend([('r6_pooled',first,native_first,pooled['baseline']['thresholds']),
        ('round9_pooled',fourth,native_fourth,pooled['selected']['thresholds'])])
    out={'provenance':prepared,'selection':sel,'configurations':{}}
    for name,scores,native,cutoffs in configs:
        adjusted=scores-r3['cal']['threshold'] if name=='r3_original' else scores-np.array([cutoffs[r9.r4.language(r['text'])] for r in rows])
        high=[i for i,r in enumerate(rows) if r['confidence']=='high']
        out['configurations'][name]={'metrics':r9.r4.measured(rows,adjusted,0.),
            'high_confidence_only_metrics':r9.r4.measured([rows[i] for i in high],adjusted[high],0.),
            'p95_ms':native['latency_p95_ms'],'predictions':[{'id':r['id'],'label':r['label'],'raw_score':float(s),
                'score':float(a),'warning':bool(a>0)} for r,s,a in zip(rows,scores,adjusted)]}
    r9.save(WORK/'prospective-ime-results.json',out)
    print(json.dumps({n:c['metrics'] for n,c in out['configurations'].items()},ensure_ascii=False))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['assemble','evaluate']);args=p.parse_args();globals()[args.command]()
