"""R5 train-only hard examples from unused archived physical entropy.

This is explicit synthetic augmentation, not new real-IME capture. Raw entropy,
draw ranges, frequency weights, outputs and assistant decisions remain separate.
"""
import argparse
from collections import Counter
from datetime import datetime,timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/'.research/semantic-round5'
spec=importlib.util.spec_from_file_location('entropy',ROOT/'tools/ime-keyboard-generate.py')
entropy_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(entropy_module)


def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def canon(t):return re.sub(r'\s+',' ',t).strip()
def rows_hash(rows):return hashlib.sha256(json.dumps(rows,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
def save(p,d):
    p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')


def generate():
    output=ROOT/'data/semantic-round5-augmentation.json'
    assert not output.exists()
    entropy_path=ROOT/'data/ime-keyboard/entropy-001.txt';raw=entropy_path.read_bytes()
    split=read(ROOT/'data/ime-keyboard/split-001.json')
    assert sha(entropy_path)==split['source_hashes']['entropy']
    source=read(ROOT/'.research/semantic-round3/prepared.json')['train']
    normal=[r['text'] for r in source if r['label']==0]
    en=Counter(w for text in normal for w in re.findall('[A-Za-z]+',text.lower()))
    zh=Counter(''.join(normal))
    pool='a an the and of to in on for with from by as at but or so because if when while before after than that this these those it its is am are was were be being been do does did have has had can could will would should may might must not no never only even already still just also yet however therefore although unless since then where whenever who which what whom whose how why any all each both neither either some many much my your our their yours ours themselves i we you they me him her us them'.split()
    en_weights={w:(en[w]*10 if en[w] else 1) for w in sorted(set(pool))}
    chars='的了在是而与于和以把被给就先但又再为着吗呢吧啊地得不也已个'
    zh_weights={c:(zh[c]*10 if zh[c] else 1) for c in sorted(set(chars))}
    entropy=entropy_module.Entropy(raw);start=32768
    assert start>=split['entropy_bit_end'];entropy.offset=start
    rows=[]
    terms=['API','cache','GPU','request','SQL','Git','status','build']
    for i in range(80):
        begin=entropy.offset
        if i<50:
            text=' '.join(entropy.weighted(en_weights) for _ in range(12+entropy.below(9)))
            kind='en-function-words'
        else:
            text=''.join(entropy.weighted(zh_weights) for _ in range(18+entropy.below(9)))
            position=2+entropy.below(len(text)-3);term=terms[entropy.below(len(terms))]
            text=text[:position]+' '+term+' '+text[position:];kind='mixed-function-characters'
        rows.append({'id':f'r5-physical-{i+1:03d}','text':text,'kind':kind,'entropy_bit_start':begin,
                     'entropy_bit_end':entropy.offset,'label':None,'status':'awaiting-assistant-review'})
    assert len({r['text'] for r in rows})==len(rows)
    save(output,{'generated_at_utc':datetime.now(timezone.utc).isoformat(),'raw_entropy_path':'data/ime-keyboard/entropy-001.txt',
        'raw_entropy_sha256':sha(entropy_path),'source_train_sha256':sha(ROOT/'.research/semantic-round3/prepared.json'),
        'entropy_bit_start':start,'entropy_bit_end':entropy.offset,'previous_used_end':split['entropy_bit_end'],
        'skipped_unused_bits':start-split['entropy_bit_end'],'algorithm':'Archived uint16 LE/LSB; rejection sampling; observed normal-word/character counts times10, unseen pool item weight1.',
        'en_weights':en_weights,'zh_weights':zh_weights,'rows':rows,
        'caveat':'Train-only artificial function-word stress examples; not actual keyboard/IME outputs and not natural-distribution gold.'})
    for row in rows:print(json.dumps({k:row[k] for k in ['id','text','kind']},ensure_ascii=False))


def prepare():
    assert not (WORK/'prepared.json').exists()
    old=read(ROOT/'.research/semantic-round4/prepared.json')
    r3=read(ROOT/'.research/semantic-round3/prepared.json')
    aug_file=ROOT/'data/semantic-round5-augmentation.json';aug=read(aug_file)
    decisions_file=ROOT/'data/semantic-round5-labels.json';decisions=read(decisions_file)
    assert decisions['augmentation_sha256']==sha(aug_file)
    by_id={r['id']:r for r in decisions['rows']};assert len(by_id)==len(aug['rows'])==80
    seeds_file=ROOT/'data/mixed-semantic-round5-seeds.json';seeds=read(seeds_file)
    def rec(text,label,category,group,weight=1.):return dict(text=canon(text),label=label,category=category,group=group,source='assistant-r5',weight=weight,task='main')
    train=[r for r in old['train'] if r['task']=='main']
    protected={canon(r['text']) for split,rows in old.items() if split!='train' for r in rows}
    for i,r in enumerate(aug['rows']):
        d=by_id[r['id']];assert d['label'] in [0,1,2] and d['reason']
        assert canon(r['text']) not in protected
        train.extend([rec(r['text'],d['label'],'physical-'+r['kind'],r['id'],.8 if d['label']==1 else 1.)]*4)
    for label,kind in [(0,'normal'),(2,'context')]:
        for i,text in enumerate(seeds['train'][kind]):
            if canon(text) not in protected:train.append(rec(text,label,'counterexample-'+kind,f'r5-train-{kind}-{i}'))
    fresh=[rec(text,label,'fresh-'+kind,f'r5-test-{kind}-{i}')
           for label,kind in enumerate(['normal','noise','context']) for i,text in enumerate(seeds['test'][kind])]
    # Protect ALL prior texts, including previous TRAIN; never call a warm-start
    # model's old training sentence a fresh test merely by removing it now.
    old_all={canon(r['text']) for rows in old.values() for r in rows}
    fresh=[r for r in fresh if canon(r['text']) not in old_all]
    prior_train={canon(r['text']) for r in r3['train']}
    for r in train:r['distill']=float(canon(r['text']) in prior_train)
    data={'train':train,'cal':old['cal'],'fresh_challenge':fresh,
          **{s:old[s] for s in ['new_challenge','new_public_test','known_ime','known_round2','known_legacy']}}
    seen={}
    for split,rows in data.items():
        local={}
        for row in rows:
            key=canon(row['text'])
            assert key not in seen or seen[key]==split,(split,seen.get(key),key)
            seen[key]=split;local.setdefault(key,set()).add(row['label'])
        assert all(len(v)==1 for v in local.values()),split
    from transformers import AutoTokenizer
    tok=AutoTokenizer.from_pretrained(str(ROOT/'.research/semantic-screen/hf-cache/models--hfl--chinese-electra-180g-small-discriminator/snapshots/826a243f3f387450ef8d70de9c3d0706d8d8e924'),local_files_only=True)
    assert all(len(ids)<=128 for rows in data.values() for ids in tok([r['text'] for r in rows],truncation=False)['input_ids'])
    manifest={'split_hashes':{s:rows_hash(r) for s,r in data.items()},
        'counts':{s:dict(Counter(r['label'] for r in rows)) for s,rows in data.items()},
        'unique_train':len({canon(r['text']) for r in train}),
        'source_hashes':{'augmentation':sha(aug_file),'labels':sha(decisions_file),'seeds':sha(seeds_file),
                         'r3_weights':sha(ROOT/'.research/semantic-directml/model.safetensors')},
        'protocol':{'epochs':3,'batch_size':128,'learning_rate':.001,'seed':20261110,
                    'distillation_temperature':2.,'distillation_weight':.5,'residual_l2_weight':.001,
                    'frozen':'All R3 encoder and original classifier tensors; only 66,051 residual MLP parameters train.',
                    'selection':'Native INT8 CAL, per-language same constraints; max noise macro language recall, min normal FP, earliest.',
                    'test_role':'Fresh assistant challenge is new; all R4 and earlier tests are known regression.'},
        'label_caveat':'Assistant-labelled artificial augmentation/challenges, silver public normal/algorithmic corruption; no independent human gold.'}
    save(WORK/'prepared.json',data);save(WORK/'manifest.json',manifest)
    print(json.dumps({'counts':manifest['counts'],'unique_train':manifest['unique_train']}),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['generate','prepare']);args=p.parse_args()
    (generate if args.command=='generate' else prepare)()
