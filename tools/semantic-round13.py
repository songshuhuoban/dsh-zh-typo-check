"""CAL false-positive budget as a hard constraint; new prospective verification."""
import argparse
from collections import Counter
from datetime import datetime,timezone
import importlib.util
import json
from pathlib import Path
import shutil

ROOT=Path(__file__).resolve().parents[1];WORK=ROOT/'.research/semantic-round13';DATA=ROOT/'data/ime-keyboard'
spec=importlib.util.spec_from_file_location('fresh12',ROOT/'tools/semantic-round12-fresh.py')
fresh12=importlib.util.module_from_spec(spec);spec.loader.exec_module(fresh12)
r12=fresh12.r;r9=r12.r9;r4=r12.r4;read,save,sha=r12.read,r12.save,r12.sha;keys=fresh12.keys


def prepare():
    data,prior=r12.frozen();assert not (WORK/'manifest.json').exists();WORK.mkdir(exist_ok=True)
    previous=read(r12.WORK/'prospective-prepared.json');oldsel=read(r12.WORK/'selection.json')
    data['known_r12_ime']=previous['rows']['prospective_ime'];data['known_r12_public']=previous['rows']['prospective_public']
    assert not (DATA/'batch-006.json').exists() and not (WORK/'public-candidates.json').exists()
    n=sum(row['label']==0 for row in data['cal']);budget=int(n*.005);assert n==1472 and budget==7
    candidates=[dict(h,eligible=h['cal']['normal_false_positives'][0]<=budget and h['cal']['context_warnings'][0]==0 and h['artifact_and_vocab_bytes']<=50_000_000) for h in oldsel['history']]
    eligible=[h for h in candidates if h['eligible']];assert eligible
    order={'baseline':0,'head':1,'last2':2}
    selected=max(eligible,key=lambda h:(h['cal']['minimum_language_noise_recall'],h['cal']['noise_macro_language_recall'],-h['cal']['normal_false_positives'][0],-order[h['arm']],-h['epoch']))
    source=r12.WORK/selected['artifact'];assert sha(source)==selected['artifact_sha256']
    shutil.copy2(source,WORK/source.name);save(WORK/'bases.json',read(r12.WORK/'bases.json'));save(WORK/'prepared.json',data)
    sources=[r12.WORK/'manifest.json',r12.WORK/'selection.json',r12.WORK/'prospective-prepared.json',r12.WORK/'results.json',source]
    manifest={'created_at_utc':datetime.now(timezone.utc).isoformat(),'issue':'SIM-1048',
        'split_hashes':{s:r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True)) for s,rows in data.items()},
        'source_hashes':{str(p.relative_to(ROOT)):sha(p) for p in sources},'r12_reference':oldsel['selected'],
        'r9_reference':prior['initial_reference'],'protocol':{'selection':'Hard CAL normal FP<=floor(0.005*n), context0, budget50M, then min/macro language recall and fewer FP; no TEST choice',
            'cal_normal_n':n,'cal_normal_fp_budget':budget,'cal_constraint_is_population_guarantee':False,'retrained':False,
            'previous_test_role':'All R12 samples known regression; new rule motivated by R12 errors, old result preserved',
            'budget_bytes':50_000_000,'prospective':{'actual_rows':50,'key_bit_start':136206,'key_reserved_end':147456,
                'public_rows':200,'public_quotas':{'zh':100,'en':40,'mixed':60},'public_bit_start':149952},'gates':prior['protocol']['gates']}}
    save(WORK/'manifest.json',manifest)
    save(WORK/'selection.json',{'selected':selected,'candidates':candidates,'sealed_at_utc':datetime.now(timezone.utc).isoformat(),
        'split_hashes':manifest['split_hashes'],'prospective_absent_at_seal':True,'r12_prior_tests_already_known':True})
    print({'selected':selected['artifact'],'cal_fp':selected['cal']['normal_false_positives'],'cal_noise':selected['cal']['noise_languages'],'bytes':selected['artifact_and_vocab_bytes']},flush=True)


def frozen():
    data,manifest=read(WORK/'prepared.json'),read(WORK/'manifest.json');selection=read(WORK/'selection.json')
    for name,rows in data.items():assert r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True))==manifest['split_hashes'][name]
    for p,h in manifest['source_hashes'].items():assert sha(ROOT/p)==h
    assert selection['split_hashes']==manifest['split_hashes'] and selection['prospective_absent_at_seal']
    chosen=selection['selected'];assert sha(WORK/chosen['artifact'])==chosen['artifact_sha256']
    return data,manifest,selection


def public_draw(data,plan):
    rows,end,source=fresh12.public_draw(data,plan)
    for i,row in enumerate(rows):row['id']=f'pub13-{i+1:04d}'
    return rows,end,source


def select():
    data,manifest,selection=frozen();assert not (WORK/'public-candidates.json').exists()
    plan=manifest['protocol']['prospective'];batch=read(DATA/'batch-006.json')
    assert batch['entropy']['bit_start']==plan['key_bit_start'] and batch['entropy']['bit_end']<=plan['key_reserved_end']
    assert read(r12.WORK/'public-candidates.json')['entropy']['bit_end']<=plan['public_bit_start']
    assert datetime.fromisoformat(batch['generated_at'])>datetime.fromisoformat(selection['sealed_at_utc'])
    rows,end,source=public_draw(data,plan)
    payload={'created_at_utc':datetime.now(timezone.utc).isoformat(),'rows':rows,'quotas':plan['public_quotas'],
        'source_sha256':sha(source),'selection_sha256':sha(WORK/'selection.json'),
        'entropy':{'raw_sha256':sha(DATA/'entropy-001.txt'),'bit_start':plan['public_bit_start'],'bit_end':end,
            'algorithm':'Archived physical uint16 LE LSB-first rejection sampling without replacement; no PRNG'},
        'caveat':'New held-out-speaker utterances, all old texts excluded; labels pending, cross-speaker conversation links unavailable.'}
    save(WORK/'public-candidates.json',payload);save(ROOT/'data/semantic-round13-public-candidates.json',payload)
    print({'public_rows':len(rows),'entropy_end':end},flush=True)


def assemble():
    data,manifest,selection=frozen();assert not (WORK/'prospective-prepared.json').exists()
    path=DATA/'notepad-batch-006.jsonl';raw=[json.loads(x) for x in path.read_text(encoding='utf8').splitlines()]
    labels=read(DATA/'assistant-labels-006.json');assert labels['capture_sha256']==sha(path) and not labels['predictions_seen_before_labels']
    decisions={d['id']:d for d in labels['decisions']};plan=manifest['protocol']['prospective'];assert len(raw)==len(decisions)==plan['actual_rows']
    batch=read(DATA/'batch-006.json');replay=keys.generate((DATA/'entropy-001.txt').read_bytes(),50,plan['key_bit_start'],'kb6',True,plan['key_reserved_end'])
    assert replay['rows']==batch['rows'] and replay['entropy_bits_consumed']==batch['entropy']['bit_end']
    assert [row['id'] for row in raw]==[row['id'] for row in batch['rows']]
    stamp=datetime.fromisoformat(selection['sealed_at_utc']);old=fresh12.protected(data);seen=set();actual=[];excluded=[]
    for a,b in zip(raw,batch['rows']):
        assert a['source_batch_sha256']==sha(DATA/'batch-006.json') and a['keys']==b['keys'] and datetime.fromisoformat(a['captured_at'].replace('Z','+00:00'))>stamp
        key=r4.r2.canonical(a['actual_output_after_one_space']);d=decisions[a['id']];assert d['label'] in [0,1,2] and d['reason']
        reason='pending' if a['pending_composition_detected'] else 'empty' if not key else 'old-overlap' if key in old else 'duplicate' if key in seen else None
        if reason:excluded.append({'id':a['id'],'reason':reason});continue
        seen.add(key);actual.append({'id':a['id'],'text':a['actual_output_after_one_space'],'label':d['label'],
            'category':'r13-prospective-real-ime','confidence':d['confidence'],'source':'native-notepad-one-space','group':a['id']})
    public=read(WORK/'public-candidates.json');pl=read(ROOT/'data/semantic-round13-public-labels.json')
    assert pl['candidate_sha256']==sha(WORK/'public-candidates.json') and not pl['predictions_seen_before_labels']
    replay,end,_=public_draw(data,plan);assert replay==public['rows'] and end==public['entropy']['bit_end']
    pd={d['id']:d for d in pl['decisions']};assert len(pd)==len(public['rows'])==200;pub=[]
    for row in public['rows']:
        d=pd[row['id']];assert d['label'] in [0,2] and d['reason'] and row['text'] not in seen and row['text'] not in old
        pub.append(dict(row,label=d['label'],confidence=d['confidence'],category='r13-prospective-public-short'))
    result={'rows':{'prospective_ime':actual,'prospective_public':pub},'excluded_ime':excluded,'selection_sha256':sha(WORK/'selection.json'),
        'capture_sha256':sha(path),'labels_sha256':sha(DATA/'assistant-labels-006.json'),'public_candidates_sha256':sha(WORK/'public-candidates.json'),
        'public_labels_sha256':sha(ROOT/'data/semantic-round13-public-labels.json'),'assembled_at_utc':datetime.now(timezone.utc).isoformat(),
        'entropy_keyboard_and_public_replay_verified':True,'labels_before_predictions':True,'label_caveat':'Assistant-only initial labels, not independent human gold.'}
    save(WORK/'prospective-prepared.json',result)
    print({'counts':{s:dict(Counter(row['label'] for row in rows)) for s,rows in result['rows'].items()},'excluded':excluded},flush=True)


def score(path,rows,name):
    original=r12.WORK
    try:r12.WORK=WORK;return r12.score(path,rows,name)
    finally:r12.WORK=original


def evaluate():
    import numpy as np
    data,manifest,selection=frozen();fresh=read(WORK/'prospective-prepared.json');assert not (WORK/'results.json').exists()
    assert sha(WORK/'selection.json')==fresh['selection_sha256']
    for p,key in [(DATA/'notepad-batch-006.jsonl','capture_sha256'),(DATA/'assistant-labels-006.json','labels_sha256'),
        (WORK/'public-candidates.json','public_candidates_sha256'),(ROOT/'data/semantic-round13-public-labels.json','public_labels_sha256')]:assert sha(p)==fresh[key]
    splits={k:v for k,v in data.items() if k not in ['train','cal']};splits.update(fresh['rows']);out={'manifest':manifest,'selection':selection,'prospective_provenance':fresh,'configurations':{}}
    configurations=[('selected',WORK,selection['selected']),('r12_original',r12.WORK,manifest['r12_reference']),('r9_pooled',r9.WORK,manifest['r9_reference'])]
    for name,folder,chosen in configurations:
        path=folder/chosen['artifact'];assert sha(path)==chosen['artifact_sha256'];results={}
        for split,rows in splits.items():
            scores,native,truncated=score(path,rows,name+'-'+split);assert truncated==0
            adjusted=scores-np.array([chosen['thresholds'][r4.language(row['text'])] for row in rows])
            results[split]={'metrics':r4.measured(rows,adjusted,0.),'p95_ms':native['latency_p95_ms'],
                'predictions':[{'id':row.get('id',i),'label':row['label'],'raw_score':float(s),'score':float(a),'warning':bool(a>0)} for i,(row,s,a) in enumerate(zip(rows,scores,adjusted))]}
        out['configurations'][name]={'splits':results}
        print({'configuration':name,'fresh':{s:results[s]['metrics'] for s in fresh['rows']}},flush=True)
    strict=read(r9.WORK/'selection.json')['selected'];assert sha(r9.WORK/strict['artifact'])==strict['artifact_sha256'];out['configurations']['r9_strict']={'splits':{}}
    for split,rows in fresh['rows'].items():
        scores,native,truncated=score(r9.WORK/strict['artifact'],rows,'r9-strict-'+split);assert truncated==0
        adjusted=scores-np.array([strict['thresholds'][r4.language(row['text'])] for row in rows])
        out['configurations']['r9_strict']['splits'][split]={'metrics':r4.measured(rows,adjusted,0.),'p95_ms':native['latency_p95_ms'],
            'predictions':[{'id':row['id'],'label':row['label'],'raw_score':float(s),'score':float(a),'warning':bool(a>0)} for row,s,a in zip(rows,scores,adjusted)]}
    current=out['configurations']['selected']['splits'];g=manifest['protocol']['gates'];a=current['prospective_ime']['metrics'];b=current['prospective_public']['metrics']
    old=current['known_round2']['metrics'];challenge=current['fresh_challenge']['metrics'];rate=lambda p:p[0]/p[1] if p[1] else float('inf')
    text='女哦就是的感受a到啊删掉asd苏打粉二十个s收到';original=next(p for row,p in zip(splits['known_legacy'],current['known_legacy']['predictions']) if row['text']==text)
    gates={'original':original['warning'],'size':selection['selected']['artifact_and_vocab_bytes']<=50_000_000,
        'fresh_actual_noise':a['noise_detected'][1]>0 and rate(a['noise_detected'])>=g['actual_noise_recall_min'],
        'fresh_actual_normal':a['normal_false_positives'][1]>0 and a['normal_false_positives'][0]==0,
        'fresh_actual_context':rate(a['context_warnings'])<=g['actual_context_rate_max'],
        'fresh_public_normal':rate(b['normal_false_positives'])<=g['public_normal_rate_max'],'fresh_public_context':rate(b['context_warnings'])<=g['public_context_rate_max'],
        'old425_noise':old['noise_detected'][0]>=g['old425_noise_min'],'old425_normal':old['normal_false_positives'][0]<=g['old425_normal_max'],
        'old_public_normal':current['new_public_test']['metrics']['normal_false_positives'][0]<=g['old_public_normal_max'],
        'old_short_normal':current['new_short_test']['metrics']['normal_false_positives'][0]<=g['old_short_normal_max'],
        'old_short_context':current['new_short_test']['metrics']['context_warnings'][0]<=g['old_short_context_max'],
        'challenge_en':challenge['noise_languages']['en'][0]>=g['challenge_en_min'],'challenge_mixed':challenge['noise_languages']['mixed'][0]>=g['challenge_mixed_min'],
        'challenge_normal':challenge['normal_false_positives'][0]<=g['challenge_normal_max'],'latency':current['known_round2']['p95_ms']<=g['native_p95_max_ms']}
    out.update(gates=gates,all_gates_passed=all(gates.values()),original=original,
        test_role={'prospective_ime':'New00650 after R13 seal','prospective_public':'New200 held-out-speaker utterances after R13 seal','all_other_splits':'Known regression'},
        entropy_ranges=[read(DATA/'batch-006.json')['entropy'],read(WORK/'public-candidates.json')['entropy']])
    save(WORK/'results.json',out);save(ROOT/'data/semantic-round13-results.json',out);print({'gates':gates,'all_gates_passed':out['all_gates_passed']},flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['prepare','select','assemble','evaluate']);args=p.parse_args();globals()[args.command]()
