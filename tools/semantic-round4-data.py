"""Pinned public-text acquisition and leakage-aware data preparation for R4.

ASCEND reads only text columns from pinned Parquet files, using HTTP ranges.
Existing IME data and its physical entropy are reused without regeneration.
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import re
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT/'.research/semantic-round4'
SRC = WORK/'sources'
ASCEND_REV = '737e9800ae31be9932ba8464c80366559bd28424'
INCOHERENT_REV = '7f1159d91ba900f3d4307367f1d49cd13d9064a0'


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def canonical(text):
    return re.sub(r'\s+',' ',text).strip()


def fetched(url, destination):
    destination.parent.mkdir(parents=True,exist_ok=True)
    if not destination.exists():
        for attempt in range(3):
            try:
                request=urllib.request.Request(url,headers={'User-Agent':'dsh-semantic-research/4'})
                with urllib.request.urlopen(request,timeout=50) as response:
                    raw=response.read()
                partial=destination.with_suffix(destination.suffix+'.partial')
                partial.write_bytes(raw);partial.replace(destination)
                break
            except Exception:
                if attempt==2:raise
                time.sleep(1+attempt)
    return destination.read_bytes()


class RangeReader(io.RawIOBase):
    """Seekable, bounded HTTP range reader; cache exact bytes for provenance."""
    def __init__(self,url,cache):
        super().__init__();self.url=url;self.cache=cache;self.position=0;self.ranges={}
        request=urllib.request.Request(url,headers={'Range':'bytes=-8','User-Agent':'dsh-semantic-research/4'})
        with urllib.request.urlopen(request,timeout=50) as response:
            assert response.status==206
            self.size=int(response.headers['Content-Range'].split('/')[-1])
            assert response.read(9)[-4:]==b'PAR1'
    def readable(self):return True
    def seekable(self):return True
    def tell(self):return self.position
    def seek(self,offset,whence=0):
        self.position=offset if whence==0 else self.position+offset if whence==1 else self.size+offset
        assert 0<=self.position<=self.size
        return self.position
    def read(self,size=-1):
        size=min(self.size-self.position,size if size>=0 else self.size)
        if not size:return b''
        assert size<8*1024*1024, 'Refuse broad/audio column download'
        start=self.position;end=start+size-1;path=self.cache/f'{start}-{size}.bin'
        if path.exists():raw=path.read_bytes()
        else:
            request=urllib.request.Request(self.url,headers={'Range':f'bytes={start}-{end}',
                                                           'User-Agent':'dsh-semantic-research/4'})
            with urllib.request.urlopen(request,timeout=50) as response:
                assert response.status==206 and response.headers['Content-Range']==f'bytes {start}-{end}/{self.size}'
                raw=response.read(size+1)
            path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
        assert len(raw)==size
        self.ranges[path.name]=hashlib.sha256(raw).hexdigest();self.position+=size
        return raw


def fetch():
    if (WORK/'prepared.json').exists():raise FileExistsError('Data already frozen')
    source_meta={}
    for repo, revision, name in [('CAiRE/ASCEND',ASCEND_REV,'ascend'),
                                 ('SuccubusBot/incoherent-text-dataset',INCOHERENT_REV,'incoherent')]:
        raw=fetched(f'https://huggingface.co/api/datasets/{repo}/revision/{revision}',SRC/f'{name}-metadata.json')
        meta=json.loads(raw);assert meta['sha']==revision
        fetched(f'https://huggingface.co/datasets/{repo}/resolve/{revision}/README.md',SRC/f'{name}-README.md')
        source_meta[name]={'repository':repo,'revision':revision,'metadata_sha256':sha(SRC/f'{name}-metadata.json'),
                           'card_sha256':sha(SRC/f'{name}-README.md'),'license':meta['cardData']['license']}
    fetched(f'https://huggingface.co/datasets/SuccubusBot/incoherent-text-dataset/resolve/{INCOHERENT_REV}/data/train-00000-of-00001.parquet',SRC/'incoherent.parquet')
    source_meta['incoherent']['parquet_sha256']=sha(SRC/'incoherent.parquet')
    import pyarrow.parquet as pq
    all_rows=[];range_hashes={};totals=Counter()
    # These columns are contiguous after audio in each row group. Prebuffer
    # merges their small reads without spanning the large audio column.
    columns=['transcription','language','original_speaker_id','session_id','topic']
    meta=json.loads((SRC/'ascend-metadata.json').read_bytes())
    filenames=[s['rfilename'] for s in meta['siblings'] if s['rfilename'].endswith('.parquet')]
    for filename in filenames:
        split=Path(filename).name.split('-')[0]
        url=f'https://huggingface.co/datasets/CAiRE/ASCEND/resolve/{ASCEND_REV}/{filename}'
        reader=RangeReader(url,SRC/'ascend-ranges'/Path(filename).name)
        table=pq.ParquetFile(reader,pre_buffer=True).read(columns=columns,use_threads=False)
        for row in table.to_pylist():
            all_rows.append(row|{'original_split':split,'row_idx':totals[split]})
            totals[split]+=1
        range_hashes[filename]={'source_bytes':reader.size,'ranges_sha256':reader.ranges,
                                'downloaded_bytes':sum(int(k.split('-')[1].split('.')[0]) for k in reader.ranges)}
        reader.close()
        print(json.dumps({'phase':'ascend-text-columns','file':filename,'rows':table.num_rows}),flush=True)
    all_rows.sort(key=lambda r:(r['original_split'],r['row_idx']))
    save(SRC/'ascend-text.json',all_rows)
    source_meta['ascend'].update(original_split_rows=totals,text_sha256=sha(SRC/'ascend-text.json'),
                                 parquet_ranges=range_hashes,audio_downloaded=False)
    save(SRC/'manifest.json',source_meta)
    print(json.dumps({'source_rows':totals,'incoherent_bytes':(SRC/'incoherent.parquet').stat().st_size}),flush=True)


def prepare():
    if (WORK/'prepared.json').exists():raise FileExistsError('Keep the frozen experiment')
    import pyarrow.parquet as pq
    from transformers import AutoTokenizer
    source_manifest=json.loads((SRC/'manifest.json').read_bytes())
    assert sha(SRC/'incoherent.parquet')==source_manifest['incoherent']['parquet_sha256']
    assert sha(SRC/'ascend-text.json')==source_manifest['ascend']['text_sha256']
    old=json.loads((ROOT/'.research/semantic-round3/prepared.json').read_bytes())
    old_manifest=json.loads((ROOT/'.research/semantic-round3/manifest.json').read_bytes())
    def rows_hash(rows):return digest(json.dumps(rows,ensure_ascii=False,sort_keys=True))
    assert all(rows_hash(rows)==old_manifest['split_hashes'][s] for s,rows in old.items())
    protected={canonical(r['text']) for rows in old.values() for r in rows}
    folder=ROOT/'.research/semantic-screen/hf-cache/models--hfl--chinese-electra-180g-small-discriminator/snapshots/826a243f3f387450ef8d70de9c3d0706d8d8e924'
    tokenizer=AutoTokenizer.from_pretrained(str(folder),local_files_only=True,trust_remote_code=False)
    def fits(rows):
        if not rows:return []
        lengths=tokenizer([r['text'] for r in rows],add_special_tokens=True,truncation=False)['input_ids']
        return [r for r,ids in zip(rows,lengths) if 6<=len(ids)<=128 and canonical(r['text']) not in protected]
    def record(text,label,category,source,group,weight=1.,**extra):
        return dict(text=canonical(text),label=label,category=category,source=source,group=group,weight=weight,task='main',**extra)
    sources={'ascend':defaultdict(list),'public_en':defaultdict(list),'csed':defaultdict(list)}
    # Session numbers are local to a speaker; all sessions of one person stay
    # together. The original utterance split is deliberately not reused.
    speakers=sorted({r['original_speaker_id'] for r in json.loads((SRC/'ascend-text.json').read_bytes())},key=lambda s:digest(f'ascend-speaker-{s}'))
    mapping={s:('train' if i<int(.6*len(speakers)) else 'cal' if i<int(.8*len(speakers)) else 'test') for i,s in enumerate(speakers)}
    for row in json.loads((SRC/'ascend-text.json').read_bytes()):
        text=row['transcription']
        if row['language']!='mixed' or len(re.findall(r'[\u4e00-\u9fff]',text))<3 or len(re.findall('[A-Za-z]',text))<3:continue
        speaker=row['original_speaker_id'];split=mapping[speaker]
        sources['ascend'][split].append(record(text,0,'ascend-natural-mixed','CAiRE/ASCEND@'+ASCEND_REV,
            f'ascend-speaker-{speaker}',.5,original_session=row['session_id'],source_row=f"{row['original_split']}/{row['row_idx']}"))
    for split in ['train','cal','test']:
        pool=fits(sources['ascend'][split]);seen=set()
        pool=[r for r in sorted(pool,key=lambda r:digest(r['text'])) if not (canonical(r['text']) in seen or seen.add(canonical(r['text'])))]
        sources['ascend'][split]=pool[:{'train':1800,'cal':300,'test':400}[split]]

    raw=pq.read_table(SRC/'incoherent.parquet').to_pylist()
    # Infer near-source families using bag-of-word overlap across all short EN
    # types, not labels. This groups many clean/corrupted variants together.
    candidates=[]
    for index,row in enumerate(raw):
        text=canonical(row['text'])
        if row['lang']=='en' and 20<=len(text)<=600 and '\ufffd' not in text:
            words=set(re.findall(r'[a-z]{3,}',text.lower()))
            if len(words)>=8:
                candidates.append({'text':text,'label':0,'original':row,'index':index,'features':words})
    lengths=tokenizer([r['text'] for r in candidates],truncation=False)['input_ids']
    candidates=[r for r,ids in zip(candidates,lengths) if len(ids)<=128]
    parent=list(range(len(candidates)))
    def find(i):
        while parent[i]!=i:parent[i]=parent[parent[i]];i=parent[i]
        return i
    postings=defaultdict(list)
    for i,row in enumerate(candidates):
        for word in row['features']:postings[word].append(i)
    for i,row in enumerate(candidates):
        counts=Counter(j for w in row['features'] if len(postings[w])<=80 for j in postings[w] if j<i)
        for j,count in counts.items():
            if count<3:continue
            a,b=row['features'],candidates[j]['features'];shared=len(a&b)
            if shared/len(a|b)>=.6 or (shared/min(len(a),len(b))>=.85 and shared>=8):
                x,y=find(i),find(j)
                if x!=y:parent[max(x,y)]=min(x,y)
    family=defaultdict(list)
    for i,row in enumerate(candidates):family[find(i)].append(row)
    family_ids={k:min(digest(r['text']) for r in v) for k,v in family.items()}
    public_counts=Counter()
    for i,row in enumerate(candidates):
        original=row['original'];typ=original['type']
        if typ not in ('coherent','word_soup'):continue
        # A list of unrelated words can be intentional data: random_words,
        # byte/token noise, run-ons and ordinary grammar errors are not mapped.
        fid=family_ids[find(i)];bucket=int(fid[:8],16)%10
        split='train' if bucket<6 else 'cal' if bucket<8 else 'test'
        label=int(typ=='word_soup')
        sources['public_en'][split].append(record(row['text'],label,'public-en-'+typ,
            'SuccubusBot/incoherent-text-dataset@'+INCOHERENT_REV,'public-en-family-'+fid,
            .7 if label else .5,source_row=row['index']))
        public_counts[(split,typ)]+=1
    for split in ['train','cal','test']:
        sources['public_en'][split]=fits(sources['public_en'][split])

    csed_audit=json.loads((ROOT/'data/semantic-dataset-audit.json').read_bytes())
    for expected in csed_audit['splits']:
        source_split=expected['split'];path=ROOT/f'.research/dataset-audit/csed-r-{source_split}.tsv'
        assert sha(path)==expected['sha256']
        groups=defaultdict(list)
        for i,line in enumerate(path.read_text(encoding='utf-8-sig').split('\n')):
            if not line:continue
            label,text=line.removesuffix('\r').split('\t',1)
            groups[canonical(text)].append((i+1,int(label)))
        split={'train':'train','dev':'cal','test':'test'}[source_split]
        pool=[]
        for text,values in groups.items():
            if len({v[1] for v in values})>1:continue
            pool.append(record(text,values[0][1],'csed-semantic-aux','CSED-R@'+csed_audit['revision'],
                               'csed-'+digest(text),1.,source_row=values[0][0])|{'task':'csed'})
        pool=fits(pool)
        if split=='train':
            pool=[r for label in [0,1] for r in sorted([x for x in pool if x['label']==label],key=lambda r:digest(r['text']))[:4000]]
        sources['csed'][split]=pool

    seeds_path=ROOT/'data/mixed-semantic-round4-seeds.json';seeds=json.loads(seeds_path.read_bytes())
    authored={}
    for split in ['cal','test']:
        authored[split]=[record(text,label,'challenge-'+kind,'assistant-authored-r4',f'challenge-{split}-{kind}-{i}')
                         for label,kind in enumerate(['normal','noise','context']) for i,text in enumerate(seeds[split][kind])
                         if canonical(text) not in protected]
    data={'train':[dict(r,task='main') for r in old['train']],
          'cal':[dict(r,task='main') for r in old['cal']]+authored['cal'],
          'new_public_test':sources['ascend']['test']+sources['public_en']['test'],
          'new_challenge':authored['test'],
          'aux_cal':sources['csed']['cal'],'aux_test':sources['csed']['test'],
          'known_ime':old['ime_test'],'known_round2':old['known_round2'],'known_legacy':old['known_legacy']}
    data['train']+=sources['ascend']['train']+sources['csed']['train']
    for row in sources['public_en']['train']:data['train'].extend([row]*(4 if row['label']==1 else 1))
    data['cal']+=sources['ascend']['cal']+sources['public_en']['cal']
    # Prior held-out rows take precedence; source data is removed on overlap.
    order=['known_ime','known_round2','known_legacy','new_challenge','new_public_test','aux_test','cal','aux_cal','train']
    seen={};removed=Counter()
    for split in order:
        kept=[]
        for row in data[split]:
            key=canonical(row['text'])
            if key in seen and seen[key]!=split:removed[split]+=1;continue
            seen[key]=split;kept.append(row)
        data[split]=kept
    # Source families/speakers must not cross train/cal/new-test partitions.
    family_sets={}
    for split in ['train','cal','new_public_test']:
        family_sets[split]={r['group'] for r in data[split] if r['group'].startswith(('ascend-speaker-','public-en-family-'))}
    for left,right in [('train','cal'),('train','new_public_test'),('cal','new_public_test')]:
        assert family_sets[left].isdisjoint(family_sets[right]),(left,right)
    for split,rows in data.items():
        groups=defaultdict(set)
        for r in rows:groups[(canonical(r['text']),r.get('task','main'))].add(r['label'])
        assert all(len(v)==1 for v in groups.values()),split
        assert all(len(ids)<=128 for ids in tokenizer([r['text'] for r in rows],truncation=False)['input_ids'])
    public_audit={'actual_rows':len(raw),'source_type_counts':dict(Counter(r['type'] for r in raw)),
                  'selected_en_candidates':len(candidates),'near_source_families':len(family),
                  'main_types_used':['coherent','word_soup'],'other_types_excluded':True,
                  'speaker_assignments':mapping,'removed_cross_split_exact':dict(removed)}
    manifest={'split_hashes':{s:rows_hash(rows) for s,rows in data.items()},
              'counts':{s:dict(Counter((r.get('task','main')+':'+str(r['label'])) for r in rows)) for s,rows in data.items()},
              'unique_train_texts':len({canonical(r['text']) for r in data['train']}),
              'categories':{s:dict(Counter(r['category'] for r in rows)) for s,rows in data.items()},
              'source_manifest_sha256':sha(SRC/'manifest.json'),'challenge_file_sha256':sha(seeds_path),
              'r3_weights_sha256':sha(ROOT/'.research/semantic-directml/model.safetensors'),
              'protocol':{'seed':20261110,'epochs':3,'learning_rate':3e-5,'batch_size':32,'max_tokens':128,
                  'backend':'DirectML AMD 780M FP32','aux_csed_loss_weight':.25,
                  'selection':'Native INT8 CAL threshold as R3; max macro recall across en/zh/mixed noise, then min normal FP, then earliest epoch.',
                  'main_label_mapping':'CSED stays an auxiliary task. Public word_soup is weak noise; coherent and ASCEND are silver normal.',
                  'evaluation':'Open fresh frozen challenge/public and CSED test after selection; earlier tests are known regression.',
                  'provisional_gates':{'original_detected':True,'known_normal_max_fp':0,'fresh_challenge_normal_max_fp':1,
                      'fresh_challenge_context_max_warnings':1,'fresh_en_and_mixed_noise_min_recall':.6,
                      'known_ime_min_noise_detected':12,'known_ime_max_context_warnings':1,
                      'known_round2_min_noise_detected':19,'max_int8_bytes':15000000,'max_native_p95_ms':15}},
              'audit':public_audit,
              'limitations':['Public corpus is algorithm-generated and silver-labelled; not independent human gold.',
                  'ASCEND is speaker-disjoint across all local sessions; cross-speaker conversation relationships are not provided.',
                  'Word-set grouping is approximate; near-source leakage cannot be ruled out completely.',
                  'Assistant challenge labels are authored and frozen before predictions, not an independent natural benchmark.']}
    save(WORK/'prepared.json',data);save(WORK/'manifest.json',manifest)
    print(json.dumps({'counts':manifest['counts'],'unique_train':manifest['unique_train_texts'],'audit':public_audit}),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['fetch','prepare'])
    args=parser.parse_args()
    (fetch if args.command=='fetch' else prepare)()
