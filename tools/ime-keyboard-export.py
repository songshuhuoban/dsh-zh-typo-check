"""Validate native IME captures and export explicit assistant-reviewed labels."""
from collections import Counter, defaultdict
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT/'data/ime-keyboard'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


batch_file = DATA/'batch-001.json'
raw_file = DATA/'notepad-batch-001.jsonl'
decisions_file = DATA/'assistant-labels-001.json'
batch = json.loads(batch_file.read_text(encoding='utf-8'))
raw = [json.loads(line) for line in raw_file.read_text(encoding='utf-8').splitlines()]
labels = json.loads(decisions_file.read_text(encoding='utf-8'))
split_file = DATA/'split-001.json'
split_info = json.loads(split_file.read_text(encoding='utf-8'))
assert split_info['source_hashes']['batch'] == sha(batch_file)
assert split_info['source_hashes']['labels'] == sha(decisions_file)
decisions = {d[0]:d[1:] for d in labels['decisions']}
assert len(decisions) == len(labels['decisions']), 'Duplicate label ID'
assert len(raw) == len(batch['rows']) == 120, 'Incomplete capture'
assert len({r['id'] for r in raw}) == len(raw), 'Duplicate captured ID'
assert {r['id'] for r in raw} == set(decisions) == {r['id'] for r in batch['rows']}
source_hash = sha(batch_file)
assert sha(DATA/'entropy-001.txt') == batch['entropy']['raw_sha256']
by_id = {r['id']:r for r in raw}
pilot = json.loads((DATA/'notepad-pilot-001-results.json').read_text(encoding='utf-8'))
assert all(by_id[r['id']]['actual_output_after_one_space'] == r['actual_output_after_one_space'] for r in pilot['rows'])

rows = []
groups = defaultdict(list)
for source in batch['rows']:
    row = by_id[source['id']]
    assert row['source_batch_sha256'] == source_hash
    for key in ['keys','split','condition','entropy_bit_start','entropy_bit_end']:
        assert row[key] == source[key], f'{key} differs from frozen batch'
    label, confidence, reason = decisions[row['id']]
    assert label in [0,1,2] and confidence in ['high','medium'] and reason.strip()
    assert row['pending_composition_detected'] == (row['actual_output_after_one_space'] != row['text_after_cancel'])
    text = row['actual_output_after_one_space'].strip()
    assert text, 'Empty output needs separate capture review'
    pending = row['pending_composition_detected']
    use = ('exclude_pending' if pending else 'context_or_abstain_only' if label == 2
           else 'primary_candidate' if confidence == 'high' else 'review_before_training')
    annotated = {
        'id':row['id'],'split':split_info['assignments'][row['id']],
        'generation_split':row['split'],'condition':row['condition'],'keys':row['keys'],
        'raw_output':row['actual_output_after_one_space'],'text':text,
        'raw_output_sha256':hashlib.sha256(row['actual_output_after_one_space'].encode()).hexdigest(),
        'label':label,'label_name':labels['labels'][str(label)],'confidence':confidence,
        'reason':reason,'suggested_use':use,'pending_composition_detected':pending,
        'annotator':'Codex assistant','user_reviewed':False,
    }
    rows.append(annotated)
    groups[text].append(annotated)

duplicates = [items for items in groups.values() if len(items)>1]
assert all(len({r['label'] for r in items})==1 for items in duplicates), 'Conflicting duplicate labels'
cross_split = [[r['id'] for r in items] for items in duplicates if len({r['split'] for r in items})>1]
assert not cross_split, f'Exact normalized output leaks across splits: {cross_split}'
result = {
    'date':'2026-11-09','issue':'SIM-1036','labels':labels['labels'],
    'annotation_source':labels['annotation_source'],'user_reviewed':False,
    'source_hashes':{'batch':source_hash,'raw_capture':sha(raw_file),
                     'decisions':sha(decisions_file),'stratified_split':sha(split_file),
                     'physical_entropy':sha(DATA/'entropy-001.txt')},
    'counts':dict(Counter(r['label_name'] for r in rows)),
    'confidence_counts':dict(Counter(r['confidence'] for r in rows)),
    'suggested_use_counts':dict(Counter(r['suggested_use'] for r in rows)),
    'split_counts':{s:dict(Counter(r['label_name'] for r in rows if r['split']==s)) for s in ['train','cal','test']},
    'pending_count':sum(r['pending_composition_detected'] for r in rows),
    'split_protocol':split_info,
    'exact_duplicate_output_groups':[[r['id'] for r in items] for items in duplicates],
    'limitations':[
        'Assistant annotations are provisional, not independent human gold.',
        'All splits share the same weighted key profile and IME environment; they do not prove generalization to user input.',
        'CAL and TEST each contain only one normal case; add independently held-out real normal text before measuring false positives.',
        'Confidence is a subjective ordinal judgment, not a calibrated probability.',
        'Pending composition is checked by an Escape difference; cross-process IMM strings were unavailable.',
        'Only whitespace is trimmed in text; exact raw_output and raw capture remain unchanged.',
    ],
    'rows':rows,
}
(DATA/'annotated-001.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

def safe_cell(value):
    value = str(value)
    return "'"+value if value.startswith(('=','+','-','@')) else value


with (DATA/'review-001.csv').open('w',encoding='utf-8-sig',newline='') as f:
    w = csv.writer(f)
    w.writerow(['编号','原按键串','实际输出','助手标签','信心','理由','建议用途','划分','你的修订标签','你的修订理由'])
    for r in rows:
        w.writerow([safe_cell(v) for v in [r['id'],r['keys'],r['raw_output'],r['label_name'],
                    r['confidence'],r['reason'],r['suggested_use'],r['split'],'','']])

def cell(value):
    return str(value).replace('|','\\|').replace('\r\n','<br>').replace('\n','<br>')


lines = ['# IME 输出初标：120 条', '',
         '2026-11-09，SIM-1036。标签来自助手逐条语义审阅，未由用户独立复核。', '',
         '0=可理解（允许口语、方言和有意的混排）；1=明显异常；2=需要上下文（含专名、简称与未完成口语）。',
         '仅依据输出语义判断，不因随机来源、英文、括号或陌生名称单独判错。', '',
         'CSV 中保留修订列：[review-001.csv](review-001.csv)。原始采集和标注分开保存。', '',
         '| 编号 | 输出 | 助手标签 | 信心 | 理由 |', '| --- | --- | --- | --- | --- |']
lines.extend('| '+' | '.join(cell(v) for v in [r['id'],r['text'],r['label_name'],r['confidence'],r['reason']])+' |' for r in rows)
(DATA/'review-001.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
print(json.dumps({k:result[k] for k in ['counts','confidence_counts','suggested_use_counts','split_counts','pending_count','exact_duplicate_output_groups']},ensure_ascii=False))
