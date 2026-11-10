"""Target-domain supplementation; old IME batches002/003 change roles explicitly."""
import argparse
from collections import Counter
from datetime import datetime,timezone
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1];WORK=ROOT/'.research/semantic-round9'
spec=importlib.util.spec_from_file_location('r8',ROOT/'tools/semantic-round8.py')
r8=importlib.util.module_from_spec(spec);spec.loader.exec_module(r8)
read,save,sha=r8.read,r8.save,r8.sha;r4=r8.r4
spec=importlib.util.spec_from_file_location('keys',ROOT/'tools/ime-keyboard-generate.py')
keys=importlib.util.module_from_spec(spec);spec.loader.exec_module(keys)


def protected_data():
    data,_=r8.frozen()
    protected={r4.r2.canonical(r['text']) for rows in data.values() for r in rows}
    for filename in ['annotated-001.json']:
        # The original excluded/medium-confidence raw outputs also remain protected.
        raw=[json.loads(x) for x in (ROOT/'data/ime-keyboard/notepad-batch-001.jsonl').read_text(encoding='utf8').splitlines()]
        protected.update(r4.r2.canonical(r['actual_output_after_one_space']) for r in raw)
    return data,protected


def select():
    assert not (WORK/'public-candidates.json').exists();WORK.mkdir(exist_ok=True)
    _,protected=protected_data();mapping=read(ROOT/'.research/semantic-round4/manifest.json')['audit']['speaker_assignments']
    source_path=ROOT/'.research/semantic-round4/sources/ascend-text.json';source=read(source_path)
    archive=ROOT/'data/ime-keyboard/entropy-001.txt';entropy=keys.Entropy(archive.read_bytes());entropy.offset=114688
    fourth=read(ROOT/'data/ime-keyboard/batch-004.json');assert fourth['entropy']['bit_end']<entropy.offset
    seen=set(protected);rows=[]
    quotas={'train':{'zh':100,'en':40,'mixed':60},'cal':{'zh':50,'en':20,'mixed':30},'test':{'zh':100,'en':40,'mixed':60}}
    for role,by_lang in quotas.items():
        for lang,count in by_lang.items():
            pool=[r for r in source if mapping[str(r['original_speaker_id'])]==role and r['language']==lang
                and 2<=len(r4.r2.canonical(r['transcription']))<=100 and r4.r2.canonical(r['transcription']) not in protected]
            taken=0
            while taken<count:
                assert pool,'Source quota exhausted'
                index=entropy.below(len(pool));row=pool[index];pool[index]=pool[-1];pool.pop()
                text=r4.r2.canonical(row['transcription'])
                if text in seen:continue
                seen.add(text);taken+=1
                rows.append({'id':f'pub9-{role}-{len([r for r in rows if r["role"]==role])+1:03d}',
                    'role':role,'text':text,'source_language':lang,'speaker':row['original_speaker_id'],
                    'session':row['session_id'],'source_row':f"{row['original_split']}/{row['row_idx']}",
                    'group':f"ascend-speaker-{row['original_speaker_id']}",'label':None})
    save(WORK/'public-candidates.json',{'created_at_utc':datetime.now(timezone.utc).isoformat(),'rows':rows,'quotas':quotas,
        'source_path':str(source_path.relative_to(ROOT)),'source_sha256':sha(source_path),
        'entropy':{'raw_sha256':sha(archive),'bit_start':114688,'bit_end':entropy.offset,
            'prior_keyboard_end':fourth['entropy']['bit_end'],'algorithm':'Archived physical uint16 LE LSB-first rejection sampling without replacement; no PRNG'},
        'caveat':'Public human speech, assistant semantic labels pending; speaker-disjoint, exact overlaps excluded. Conversation cross-speaker links unavailable.'})
    print(json.dumps({'rows':len(rows),'entropy_bit_end':entropy.offset}),flush=True)


def prepare():
    assert not (WORK/'prepared.json').exists()
    data,protected=protected_data();public=read(WORK/'public-candidates.json')
    labels=read(ROOT/'data/semantic-round9-public-labels.json');authored=read(ROOT/'data/mixed-semantic-round9-seeds.json')
    assert labels['candidate_sha256']==sha(WORK/'public-candidates.json') and not labels['predictions_seen_before_labels']
    decisions={r['id']:r for r in labels['decisions']};assert len(decisions)==len(public['rows'])==500
    added={'train':[],'cal':[],'test':[]};removed=[]
    def record(text,label,category,source,group,weight=1.,**extra):
        return {'text':r4.r2.canonical(text),'label':label,'category':category,'source':source,'group':group,
            'weight':weight,'teacher':0.,**extra}
    # Both batches have already been inspected: explicitly transfer their roles.
    for role,batch in [('train',2),('cal',3)]:
        raw_path=ROOT/f'data/ime-keyboard/notepad-batch-{batch:03d}.jsonl'
        raw=[json.loads(s) for s in raw_path.read_text(encoding='utf8').splitlines()]
        label_obj=read(ROOT/f'data/ime-keyboard/assistant-labels-{batch:03d}.json');assert label_obj['capture_sha256']==sha(raw_path)
        by_id={r['id']:r for r in label_obj['decisions']}
        for row in raw:
            d=by_id[row['id']];assert not row['pending_composition_detected']
            added[role].append(record(row['actual_output_after_one_space'],d['label'],'r9-real-ime-'+str(batch),
                'native-notepad-one-space',row['id'],1. if d['confidence']=='high' else .75,confidence=d['confidence']))
    for row in public['rows']:
        d=decisions[row['id']];assert d['label'] in [0,2] and d['reason']
        added[row['role']].append(record(row['text'],d['label'],'r9-public-short',
            'CAiRE/ASCEND@737e9800ae31be9932ba8464c80366559bd28424',row['group'],1.,source_row=row['source_row'],review_id=row['id']))
    seen=set(protected)
    for rows in added.values():seen.update(r['text'] for r in rows)
    for role in ['train','cal','test']:
        for label,key in [(0,'normal'),(2,'context')]:
            for i,text in enumerate(authored[role][key]):
                text=r4.r2.canonical(text)
                if text in seen:removed.append({'role':role,'key':key,'index':i,'reason':'exact-overlap'});continue
                seen.add(text)
                added[role].append(record(text,label,'r9-authored-'+key,'assistant-authored',f'r9-authored-{role}-{key}-{i}'))
    old_train=data['train'];data['train']=[dict(r,teacher=1.) for r in old_train]
    for row in added['train']:
        data['train'].extend([row.copy() for _ in range(4 if row['category']=='r9-real-ime-2' else 2)])
    data['cal']+=added['cal'];data['new_short_test']=added['test']
    del data['known_round6_ime'];del data['known_round7_ime']
    # No transferred batch remains a test cohort.
    train={r['text'] for r in data['train']};cal={r['text'] for r in data['cal']};test={r['text'] for r in data['new_short_test']}
    assert not (train&cal or train&test or cal&test)
    assert all(not ({r['text'] for r in rows}&(train|cal)) for name,rows in data.items() if name not in ['train','cal'])
    speaker_sets={role:{r['group'] for r in rows if r['group'].startswith('ascend-speaker-')} for role,rows in [('train',data['train']),('cal',data['cal']),('test',data['new_short_test']+data['new_public_test'])]}
    assert not (speaker_sets['train']&speaker_sets['cal'] or speaker_sets['train']&speaker_sets['test'] or speaker_sets['cal']&speaker_sets['test'])
    initial=read(r8.r6.WORK/'selection.json')['selected']
    manifest={'created_at_utc':datetime.now(timezone.utc).isoformat(),'split_hashes':{s:r4.r2.digest(json.dumps(rows,ensure_ascii=False,sort_keys=True)) for s,rows in data.items()},
        'counts':{s:dict(Counter(r['label'] for r in rows)) for s,rows in data.items()},'unique_train':len(train),
        'added_unique_counts':{s:dict(Counter(r['label'] for r in rows)) for s,rows in added.items()},
        'source_hashes':{'public_candidates':sha(WORK/'public-candidates.json'),'public_labels':sha(ROOT/'data/semantic-round9-public-labels.json'),
            'authored_seeds':sha(ROOT/'data/mixed-semantic-round9-seeds.json'),'r6_features':sha(r8.r6.WORK/'train-features.safetensors'),
            'r6_head':sha(r8.r6.WORK/f"dual-epoch-{initial['epoch']}-head.safetensors")},
        'initial':initial,'protocol':{'epochs':6,'checkpoints':[1,3,6],'learning_rate':.0002,'batch_size':128,'seed':20261113,
            'class_weights':[2.,1.,2.],'teacher_temperature':2.,'teacher_weight':.5,'budget_bytes':50_000_000,
            'threshold':'R6 per-language normal99%/each-normal-category99%/max-context/min0; strict >',
            'selection':'CAL max minimum language noise recall, then macro recall, fewer normal warnings, earlier epoch',
            'frozen':'Original R6 dual encoders and RTD heads, original train-only center/scale; only134659-parameter MLP',
            'transferred_roles':{'batch002':'TRAIN','batch003':'CAL'},'prospective':'60 actual IME outputs after seal, physical bits[98304,110754), label before scores'},
        'removed_authored_overlaps':removed,'label_caveat':'Assistant labels, not independent human gold; ASCEND source human speech, supplemental author examples artificial.'}
    save(WORK/'bases.json',read(r8.r6.WORK/'bases.json'));save(WORK/'prepared.json',data);save(WORK/'manifest.json',manifest)
    print(json.dumps({'counts':manifest['counts'],'unique_train':len(train),'new':manifest['added_unique_counts'],'removed':len(removed)}),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['select','prepare']);args=p.parse_args();globals()[args.command]()
