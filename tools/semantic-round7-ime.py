"""Prospective third physical-entropy/actual-IME cohort; label before scoring."""
from datetime import datetime
import argparse
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('r7',ROOT/'tools/semantic-round7.py')
r7=importlib.util.module_from_spec(spec);spec.loader.exec_module(r7)
WORK=r7.WORK;DATA=ROOT/'data/ime-keyboard'


def assemble():
    assert (WORK/'selection.json').exists() and not (WORK/'prospective-ime-results.json').exists()
    raw_path=DATA/'notepad-batch-003.jsonl';label_path=DATA/'assistant-labels-003.json'
    raw=[json.loads(s) for s in raw_path.read_text(encoding='utf8').splitlines()];labels=r7.read(label_path)
    assert labels['capture_sha256']==r7.sha(raw_path) and labels['predictions_seen_before_labels'] is False
    sealed=datetime.fromisoformat(r7.read(WORK/'selection.json')['sealed_at_utc'])
    assert all(datetime.fromisoformat(r['captured_at'].replace('Z','+00:00'))>sealed for r in raw)
    decisions={r['id']:r for r in labels['decisions']};assert len(decisions)==len(raw)==40
    data,_=r7.frozen();protected={r7.r4.r2.canonical(r['text']) for rows in data.values() for r in rows}
    rows=[];excluded=[];seen=set()
    for record in raw:
        d=decisions[record['id']];text=record['actual_output_after_one_space'];key=r7.r4.r2.canonical(text)
        reason='pending-composition' if record['pending_composition_detected'] else 'empty' if not key else 'prior-text-overlap' if key in protected else 'duplicate-new-output' if key in seen else None
        if reason:excluded.append({'id':record['id'],'reason':reason});continue
        seen.add(key);assert d['label'] in [0,1,2] and d['reason']
        rows.append({'id':record['id'],'text':text,'label':d['label'],'category':'prospective-real-ime',
            'group':record['id'],'confidence':d['confidence'],'source':'native-notepad-one-space'})
    r7.save(WORK/'prospective-ime-prepared.json',{'rows':rows,'excluded':excluded,'raw_sha256':r7.sha(raw_path),
        'labels_sha256':r7.sha(label_path),'selection_sha256':r7.sha(WORK/'selection.json'),
        'assembled_before_predictions':True,'label_caveat':'Assistant-only, not independently reviewed.'})
    print(json.dumps({'included':len(rows),'excluded':excluded},ensure_ascii=False))


def evaluate():
    import numpy as np
    assert not (WORK/'prospective-ime-results.json').exists()
    prepared=r7.read(WORK/'prospective-ime-prepared.json');rows=prepared['rows']
    assert r7.sha(WORK/'selection.json')==prepared['selection_sha256']
    r3=r7.read(ROOT/'.research/semantic-round3/selection.json')['selected']
    r5=r7.read(ROOT/'.research/semantic-round5/selection.json')['selected']
    r6=r7.read(ROOT/'.research/semantic-round6/selection.json')['selected']
    sel=r7.read(WORK/'selection.json');r7chosen=sel['selected']
    configurations={'round3':(ROOT/'.research/semantic-round3'/r3['artifact'],r3),
        'round5':(ROOT/'.research/semantic-round5'/r5['artifact'],r5),
        'round6':(ROOT/'.research/semantic-round6'/r6['artifact'],r6),'round7':(WORK/r7chosen['artifact'],r7chosen)}
    out={'provenance':prepared,'selection':sel,'configurations':{}}
    for name,(path,chosen) in configurations.items():
        if name in ['round6','round7']:scores,native,truncated=r7.score(path,rows,'prospective-'+name)
        else:
            r7.r4.r2.WORK=WORK;scores,native,truncated=r7.r4.r2.node_scores(path,rows,'prospective-'+name)
        adjusted=scores-chosen['cal']['threshold'] if name=='round3' else scores-np.array([chosen['thresholds'][r7.r4.language(r['text'])] for r in rows])
        high=[i for i,r in enumerate(rows) if r['confidence']=='high']
        out['configurations'][name]={'metrics':r7.r4.measured(rows,adjusted,0.),
            'high_confidence_only_metrics':r7.r4.measured([rows[i] for i in high],adjusted[high],0.),
            'p95_ms':native['latency_p95_ms'],'truncated_encoder_inputs':truncated,
            'predictions':[{'id':r['id'],'label':r['label'],'raw_score':float(s),'score':float(a),'warning':bool(a>0)} for r,s,a in zip(rows,scores,adjusted)]}
    r7.save(WORK/'prospective-ime-results.json',out)
    print(json.dumps({n:c['metrics'] for n,c in out['configurations'].items()},ensure_ascii=False))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['assemble','evaluate']);args=p.parse_args();globals()[args.command]()
