"""Prospective actual-IME holdout from unused, archived physical-entropy bits."""
import argparse
from collections import Counter
from datetime import datetime,timezone
import importlib.util
import json
from pathlib import Path
import string

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('r6',ROOT/'tools/semantic-round6.py')
r6=importlib.util.module_from_spec(spec);spec.loader.exec_module(r6)
spec=importlib.util.spec_from_file_location('keys',ROOT/'tools/ime-keyboard-generate.py')
keys=importlib.util.module_from_spec(spec);spec.loader.exec_module(keys)
DATA=ROOT/'data/ime-keyboard';WORK=r6.WORK


def generate():
    path=DATA/'batch-002.json';assert not path.exists()
    first=r6.read(DATA/'batch-001.json');raw=(DATA/'entropy-001.txt').read_bytes()
    assert r6.sha(DATA/'entropy-001.txt')==first['entropy']['raw_sha256']
    prior=r6.read(ROOT/'data/semantic-round5-augmentation.json')
    # The prior augmentation and original keyboard/split streams are disjoint.
    assert prior['entropy_bit_end']<=73728
    def replay():
        entropy=keys.Entropy(raw);entropy.offset=73728;counts=Counter(''.join(keys.SAMPLES))
        letters={c:10*counts[c] if counts[c] else 1 for c in string.ascii_lowercase}
        extended={**letters,'[':10*counts['['],';':10*counts[';']};rows=[]
        for i in range(40):
            start=entropy.offset;condition='letters' if i%4!=3 else 'letters-and-observed-punctuation'
            weights=letters if condition=='letters' else extended
            length=8+entropy.below(25);value=''.join(entropy.weighted(weights) for _ in range(length))
            rows.append({'id':f'kb2-{i+1:04d}','split':'test','condition':condition,'keys':value,
                'commit_key':'space','label':None,'label_status':'unreviewed',
                'entropy_bit_start':start,'entropy_bit_end':entropy.offset})
        return rows,entropy.offset,letters,extended
    rows,end,letters,extended=replay();assert replay()==(rows,end,letters,extended)
    assert not ({r['keys'] for r in first['rows']}&{r['keys'] for r in rows})
    r6.save(path,{'generated_at_utc':datetime.now(timezone.utc).isoformat(),'source_samples':keys.SAMPLES,
        'letter_weights':letters,'extended_weights':extended,'rows':rows,
        'entropy':first['entropy']|{'bit_start':73728,'bit_end':end,'previous_used_end':prior['entropy_bit_end'],
            'unused_gap_bits':73728-prior['entropy_bit_end']},
        'algorithm':'Archived physical uint16 LE LSB-first; rejection sampling; integer cumulative weights; no PRNG.',
        'caveat':'Same key-frequency profile and IME; all prospective TEST; assistant labels are not human gold.'})
    print(json.dumps({'rows':len(rows),'entropy_end':end,'preview':rows[:3]},ensure_ascii=False))


def assemble():
    assert (WORK/'selection.json').exists() and not (WORK/'prospective-ime-results.json').exists()
    raw_path=DATA/'notepad-batch-002.jsonl';label_path=DATA/'assistant-labels-002.json'
    raw=[json.loads(line) for line in raw_path.read_text(encoding='utf8').splitlines()]
    labels=r6.read(label_path);assert labels['capture_sha256']==r6.sha(raw_path)
    sealed=datetime.fromisoformat(r6.read(WORK/'selection.json')['sealed_at_utc'])
    assert all(datetime.fromisoformat(r['captured_at'].replace('Z','+00:00'))>sealed for r in raw)
    decisions={r['id']:r for r in labels['decisions']};assert len(raw)==len(decisions)==40
    assert labels['predictions_seen_before_labels'] is False
    data,_=r6.frozen();protected={r6.r4.r2.canonical(r['text']) for rows in data.values() for r in rows}
    rows=[];excluded=[];seen=set()
    for record in raw:
        d=decisions[record['id']];text=record['actual_output_after_one_space'];key=r6.r4.r2.canonical(text)
        reason='pending-composition' if record['pending_composition_detected'] else 'empty' if not key else 'prior-text-overlap' if key in protected else 'duplicate-new-output' if key in seen else None
        if reason:excluded.append({'id':record['id'],'reason':reason});continue
        seen.add(key);assert d['label'] in [0,1,2] and d['reason']
        rows.append({'id':record['id'],'text':text,'label':d['label'],'category':'prospective-real-ime',
            'group':record['id'],'source':'native-notepad-doubao-one-space','confidence':d['confidence']})
    r6.save(WORK/'prospective-ime-prepared.json',{'rows':rows,'excluded':excluded,'raw_sha256':r6.sha(raw_path),
        'labels_sha256':r6.sha(label_path),'selection_sha256':r6.sha(WORK/'selection.json'),
        'assembled_before_predictions':True,'label_caveat':'Assistant-only labels, not independently reviewed.'})
    print(json.dumps({'included':len(rows),'excluded':excluded},ensure_ascii=False))


def evaluate():
    import numpy as np
    assert not (WORK/'prospective-ime-results.json').exists()
    prepared=r6.read(WORK/'prospective-ime-prepared.json');rows=prepared['rows'];sel=r6.read(WORK/'selection.json')
    assert r6.sha(WORK/'selection.json')==prepared['selection_sha256']
    output={'provenance':prepared,'selection':sel,'configurations':{}}
    r3=r6.read(ROOT/'.research/semantic-round3/selection.json')['selected']
    r5=r6.read(ROOT/'.research/semantic-round5/selection.json')['selected']
    configurations={'round3':(ROOT/'.research/semantic-round3'/r3['artifact'],r3),
        'round5':(ROOT/'.research/semantic-round5'/r5['artifact'],r5)}
    configurations.update({mode:(WORK/chosen['artifact'],chosen) for mode,chosen in sel['by_mode'].items()})
    for name,(path,chosen) in configurations.items():
        if name in ['zh','dual']:scores,native,truncated=r6.node_scores(path,rows,'prospective-'+name,name)
        else:
            r6.r4.r2.WORK=WORK;scores,native,truncated=r6.r4.r2.node_scores(path,rows,'prospective-'+name)
        adjusted=scores-chosen['cal']['threshold'] if name=='round3' else scores-np.array([chosen['thresholds'][r6.r4.language(r['text'])] for r in rows])
        output['configurations'][name]={'metrics':r6.r4.measured(rows,adjusted,0.),'p95_ms':native['latency_p95_ms'],
            'truncated_encoder_inputs':truncated,'predictions':[{'id':r['id'],'label':r['label'],'raw_score':float(s),
                'score':float(a),'warning':bool(a>0)} for r,s,a in zip(rows,scores,adjusted)]}
    r6.save(WORK/'prospective-ime-results.json',output)
    print(json.dumps({n:c['metrics'] for n,c in output['configurations'].items()},ensure_ascii=False))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['generate','assemble','evaluate']);args=p.parse_args();globals()[args.command]()
