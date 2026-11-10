"""R12 prospective selection, label assembly and locked evaluation."""
import argparse
from collections import Counter
from datetime import datetime,timezone
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('r12',ROOT/'tools/semantic-round12.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
spec=importlib.util.spec_from_file_location('keys',ROOT/'tools/ime-keyboard-generate.py')
keys=importlib.util.module_from_spec(spec);spec.loader.exec_module(keys)
WORK=r.WORK;DATA=ROOT/'data/ime-keyboard'


def sealed():
    data,manifest=r.frozen();selection=r.read(WORK/'selection.json')
    assert selection['split_hashes']==manifest['split_hashes'] and selection['prospective_files_absent_at_seal']
    for chosen in selection['by_arm'].values():assert r.sha(WORK/chosen['artifact'])==chosen['artifact_sha256']
    return data,manifest,selection


def protected(data):
    result={r.r4.r2.canonical(row['text']) for rows in data.values() for row in rows}
    for batch in range(1,5):
        result.update(r.r4.r2.canonical(json.loads(s)['actual_output_after_one_space'])
            for s in (DATA/f'notepad-batch-{batch:03d}.jsonl').read_text(encoding='utf8').splitlines())
    return result


def public_draw(data,plan):
    source_path=ROOT/'.research/semantic-round4/sources/ascend-text.json';source=r.read(source_path)
    mapping=r.read(ROOT/'.research/semantic-round4/manifest.json')['audit']['speaker_assignments']
    archive=DATA/'entropy-001.txt';meta=r.read(DATA/'entropy-001.metadata.json')
    assert r.sha(archive)==meta['raw_sha256']
    entropy=keys.Entropy(archive.read_bytes());entropy.offset=plan['public_bit_start']
    old=protected(data);seen=set(old);rows=[]
    for lang,count in plan['public_quotas'].items():
        pool=[row for row in source if mapping[str(row['original_speaker_id'])]=='test' and row['language']==lang
            and 2<=len(r.r4.r2.canonical(row['transcription']))<=100 and r.r4.r2.canonical(row['transcription']) not in old]
        taken=0
        while taken<count:
            assert pool,'Source quota exhausted'
            i=entropy.below(len(pool));row=pool[i];pool[i]=pool[-1];pool.pop()
            text=r.r4.r2.canonical(row['transcription'])
            if text in seen:continue
            seen.add(text);taken+=1
            rows.append({'id':f'pub12-{len(rows)+1:04d}','text':text,'source_language':lang,'role':'test',
                'speaker':row['original_speaker_id'],'session':row['session_id'],
                'source_row':f"{row['original_split']}/{row['row_idx']}",'group':f"ascend-speaker-{row['original_speaker_id']}",'label':None})
    return rows,entropy.offset,source_path


def select():
    data,manifest,selection=sealed();assert not (WORK/'public-candidates.json').exists()
    plan=manifest['protocol']['prospective'];batch=r.read(DATA/'batch-005.json')
    assert r.read(r.r9.WORK/'public-candidates.json')['entropy']['bit_end']<=plan['key_bit_start']
    assert batch['entropy']['bit_start']==plan['key_bit_start']
    assert batch['entropy']['bit_end']<=plan['public_bit_start']
    assert datetime.fromisoformat(batch['generated_at'])>datetime.fromisoformat(selection['sealed_at_utc'])
    rows,end,source_path=public_draw(data,plan);archive=DATA/'entropy-001.txt'
    assert r.sha(archive)==batch['entropy']['raw_sha256']
    payload={'created_at_utc':datetime.now(timezone.utc).isoformat(),'rows':rows,'quotas':plan['public_quotas'],
        'source_sha256':r.sha(source_path),'selection_sha256':r.sha(WORK/'selection.json'),
        'entropy':{'raw_sha256':r.sha(archive),'bit_start':plan['public_bit_start'],'bit_end':end,
            'keyboard_end':batch['entropy']['bit_end'],'algorithm':'Physical archived uint16 LE LSB-first unbiased rejection sampling without replacement; no PRNG'},
        'caveat':'New utterances from held-out speakers, exact old text overlaps excluded. Cross-speaker conversations unknown. Assistant labels pending.'}
    r.save(WORK/'public-candidates.json',payload);r.save(ROOT/'data/semantic-round12-public-candidates.json',payload)
    print({'public':len(rows),'physical_end':end},flush=True)


def assemble():
    data,manifest,selection=sealed();assert not (WORK/'prospective-prepared.json').exists()
    raw_path=DATA/'notepad-batch-005.jsonl';raw=[json.loads(s) for s in raw_path.read_text(encoding='utf8').splitlines()]
    label_path=DATA/'assistant-labels-005.json';labels=r.read(label_path)
    assert labels['capture_sha256']==r.sha(raw_path) and not labels['predictions_seen_before_labels']
    decisions={d['id']:d for d in labels['decisions']};assert len(decisions)==len(raw)==manifest['protocol']['prospective']['actual_rows']
    stamp=datetime.fromisoformat(selection['sealed_at_utc']);batch_path=DATA/'batch-005.json';batch=r.read(batch_path)
    assert all(datetime.fromisoformat(row['captured_at'].replace('Z','+00:00'))>stamp and row['source_batch_sha256']==r.sha(batch_path) for row in raw)
    assert [x['id'] for x in raw]==[x['id'] for x in batch['rows']]
    replay=keys.generate((DATA/'entropy-001.txt').read_bytes(),60,manifest['protocol']['prospective']['key_bit_start'],'kb5',True)
    assert replay['rows']==batch['rows'] and replay['entropy_bits_consumed']==batch['entropy']['bit_end']
    assert all(a['keys']==b['keys'] for a,b in zip(raw,batch['rows']))
    old=protected(data);seen=set();actual=[];excluded=[]
    for row in raw:
        key=r.r4.r2.canonical(row['actual_output_after_one_space']);d=decisions[row['id']]
        assert d['label'] in [0,1,2] and d['reason']
        reason='pending-composition' if row['pending_composition_detected'] else 'empty' if not key else 'prior-overlap' if key in old else 'new-duplicate' if key in seen else None
        if reason:excluded.append({'id':row['id'],'reason':reason});continue
        seen.add(key);actual.append({'id':row['id'],'text':row['actual_output_after_one_space'],'label':d['label'],
            'category':'r12-prospective-real-ime','confidence':d['confidence'],'source':'native-notepad-one-space','group':row['id']})
    public=r.read(WORK/'public-candidates.json');public_path=ROOT/'data/semantic-round12-public-labels.json';pl=r.read(public_path)
    replay,end,_=public_draw(data,manifest['protocol']['prospective'])
    assert replay==public['rows'] and end==public['entropy']['bit_end']
    assert pl['candidate_sha256']==r.sha(WORK/'public-candidates.json') and not pl['predictions_seen_before_labels']
    pd={d['id']:d for d in pl['decisions']};assert len(pd)==len(public['rows'])==200
    public_rows=[]
    for row in public['rows']:
        d=pd[row['id']];assert d['label'] in [0,2] and d['reason']
        assert row['text'] not in old and row['text'] not in seen
        public_rows.append(dict(row,label=d['label'],category='r12-prospective-public-short',confidence=d['confidence']))
    assert not (WORK/'results.json').exists()
    payload={'rows':{'prospective_ime':actual,'prospective_public':public_rows},'excluded_ime':excluded,
        'selection_sha256':r.sha(WORK/'selection.json'),'capture_sha256':r.sha(raw_path),'labels_sha256':r.sha(label_path),
        'public_candidates_sha256':r.sha(WORK/'public-candidates.json'),'public_labels_sha256':r.sha(public_path),
        'assembled_at_utc':datetime.now(timezone.utc).isoformat(),'assembled_before_predictions':True,
        'keyboard_entropy_replay_verified':True,'public_entropy_replay_verified':True,
        'label_caveat':'Assistant-only initial semantic labels, not independent human gold; uncertainty remains context.'}
    r.save(WORK/'prospective-prepared.json',payload)
    print({'counts':{s:dict(Counter(row['label'] for row in rows)) for s,rows in payload['rows'].items()},'excluded':excluded},flush=True)


def evaluate():
    import numpy as np
    data,manifest,selection=sealed();fresh=r.read(WORK/'prospective-prepared.json');assert not (WORK/'results.json').exists()
    assert r.sha(WORK/'selection.json')==fresh['selection_sha256']
    assert r.sha(DATA/'notepad-batch-005.jsonl')==fresh['capture_sha256'] and r.sha(DATA/'assistant-labels-005.json')==fresh['labels_sha256']
    assert r.sha(WORK/'public-candidates.json')==fresh['public_candidates_sha256'] and r.sha(ROOT/'data/semantic-round12-public-labels.json')==fresh['public_labels_sha256']
    splits={s:rows for s,rows in data.items() if s not in ['train','cal']};splits.update(fresh['rows'])
    configs=[('selected',WORK,selection['selected']),('binary_seed',WORK,selection['by_arm']['baseline']),
        ('r9_pooled',r.r9.WORK,manifest['initial_reference'])]
    out={'manifest':manifest,'selection':selection,'training':r.read(WORK/'training-started.json'),'prospective_provenance':fresh,'configurations':{}}
    for name,folder,chosen in configs:
        path=folder/chosen['artifact'];assert r.sha(path)==chosen['artifact_sha256'];results={}
        for split,rows in splits.items():
            scores,native,truncated=r.score(path,rows,name+'-'+split);assert truncated==0
            adjusted=scores-np.array([chosen['thresholds'][r.r4.language(row['text'])] for row in rows])
            high=[i for i,row in enumerate(rows) if row.get('confidence')=='high']
            results[split]={'metrics':r.r4.measured(rows,adjusted,0.),'p95_ms':native['latency_p95_ms'],
                'high_confidence_metrics':r.r4.measured([rows[i] for i in high],adjusted[high],0.) if high else None,
                'predictions':[{'id':row.get('id',i),'label':row['label'],'raw_score':float(score),'score':float(a),'warning':bool(a>0)} for i,(row,score,a) in enumerate(zip(rows,scores,adjusted))]}
        out['configurations'][name]={'splits':results}
        print({'configuration':name,'fresh':{s:results[s]['metrics'] for s in fresh['rows']}},flush=True)
    strict=r.read(r.r9.WORK/'selection.json')['selected'];strict_results={}
    assert r.sha(r.r9.WORK/strict['artifact'])==strict['artifact_sha256']
    for split,rows in fresh['rows'].items():
        scores,native,truncated=r.score(r.r9.WORK/strict['artifact'],rows,'r9-strict-'+split);assert truncated==0
        adjusted=scores-np.array([strict['thresholds'][r.r4.language(row['text'])] for row in rows])
        strict_results[split]={'metrics':r.r4.measured(rows,adjusted,0.),'p95_ms':native['latency_p95_ms'],
            'predictions':[{'id':row['id'],'label':row['label'],'raw_score':float(s),'score':float(a),'warning':bool(a>0)} for row,s,a in zip(rows,scores,adjusted)]}
    out['configurations']['r9_strict']={'splits':strict_results}
    current=out['configurations']['selected']['splits'];g=manifest['protocol']['gates']
    actual=current['prospective_ime']['metrics'];public=current['prospective_public']['metrics'];challenge=current['fresh_challenge']['metrics'];old=current['known_round2']['metrics']
    rate=lambda pair:pair[0]/pair[1] if pair[1] else None
    source='女哦就是的感受a到啊删掉asd苏打粉二十个s收到'
    original=next(p for row,p in zip(splits['known_legacy'],current['known_legacy']['predictions']) if row['text']==source)
    gates={'original':original['warning'],'size':selection['selected']['artifact_and_vocab_bytes']<=manifest['protocol']['budget_bytes'],
        'fresh_actual_noise':rate(actual['noise_detected']) is not None and rate(actual['noise_detected'])>=g['actual_noise_recall_min'],
        'fresh_actual_normal':actual['normal_false_positives'][1]>0 and actual['normal_false_positives'][0]<=g['actual_normal_fp_max'],
        'fresh_actual_context':rate(actual['context_warnings']) is not None and rate(actual['context_warnings'])<=g['actual_context_rate_max'],
        'fresh_public_normal':rate(public['normal_false_positives']) is not None and rate(public['normal_false_positives'])<=g['public_normal_rate_max'],
        'fresh_public_context':rate(public['context_warnings']) is not None and rate(public['context_warnings'])<=g['public_context_rate_max'],
        'old425_noise':old['noise_detected'][0]>=g['old425_noise_min'],'old425_normal':old['normal_false_positives'][0]<=g['old425_normal_max'],
        'old_public_normal':current['new_public_test']['metrics']['normal_false_positives'][0]<=g['old_public_normal_max'],
        'old_short_normal':current['new_short_test']['metrics']['normal_false_positives'][0]<=g['old_short_normal_max'],
        'old_short_context':current['new_short_test']['metrics']['context_warnings'][0]<=g['old_short_context_max'],
        'challenge_en':challenge['noise_languages']['en'][0]>=g['challenge_en_min'],
        'challenge_mixed':challenge['noise_languages']['mixed'][0]>=g['challenge_mixed_min'],
        'challenge_normal':challenge['normal_false_positives'][0]<=g['challenge_normal_max'],
        'latency':current['known_round2']['p95_ms']<=g['native_p95_max_ms']}
    out.update(original=original,gates=gates,all_gates_passed=all(gates.values()),
        roles={'prospective_ime':'New actual005 after CAL seal','prospective_public':'New held-out-speaker utterances after CAL seal',
            'known_r9_ime':'Transferred to TRAIN, not tested','all_other_splits':'Known regression'},
        new_entropy_ranges=[r.read(DATA/'batch-005.json')['entropy'],r.read(WORK/'public-candidates.json')['entropy']])
    r.save(WORK/'results.json',out);r.save(ROOT/'data/semantic-round12-results.json',out)
    print({'gates':gates,'all_gates_passed':out['all_gates_passed']},flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['select','assemble','evaluate']);args=p.parse_args();globals()[args.command]()
