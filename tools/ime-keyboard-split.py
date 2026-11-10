"""Stratify reviewed labels before any model fitting using unused physical bits.

The immutable generator's initial split is preserved in the raw capture. The
recommended split is separate and cannot silently change after label revision.
"""
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT/'data/ime-keyboard'
spec = importlib.util.spec_from_file_location('physical_keys', ROOT/'tools/ime-keyboard-generate.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


batch_file, label_file, entropy_file = [DATA/name for name in
    ['batch-001.json','assistant-labels-001.json','entropy-001.txt']]
batch = json.loads(batch_file.read_text(encoding='utf-8'))
labels = json.loads(label_file.read_text(encoding='utf-8'))
assert sha(entropy_file) == batch['entropy']['raw_sha256']
hashes = {'batch':sha(batch_file),'labels':sha(label_file),'entropy':sha(entropy_file)}
target = DATA/'split-001.json'
if target.exists():
    existing = json.loads(target.read_text(encoding='utf-8'))
    assert existing['source_hashes'] == hashes, 'Inputs changed; retain the old split and create a new version'
    print('Retained existing stratified split')
    raise SystemExit(0)
counts = {label:sorted(d[0] for d in labels['decisions'] if d[1]==label) for label in [0,1,2]}
# Preserve 80/20/20 while retaining at least one of the five normal cases in CAL
# and TEST. These quotas are chosen from label counts, never model predictions.
quotas = {0:{'train':3,'cal':1,'test':1},
          1:{'train':55,'cal':13,'test':13},
          2:{'train':22,'cal':6,'test':6}}
entropy = module.Entropy(entropy_file.read_bytes())
entropy.offset = batch['entropy_bits_consumed']
start = entropy.offset
assignments = {}
for label, ids in counts.items():
    assert len(ids) == sum(quotas[label].values())
    for i in range(len(ids)-1,0,-1):
        j = entropy.below(i+1)
        ids[i],ids[j] = ids[j],ids[i]
    index = 0
    for split, count in quotas[label].items():
        for key in ids[index:index+count]:
            assignments[key] = split
        index += count
assert len(assignments)==120
result = {'source_hashes':hashes,'quotas':quotas,'assignments':dict(sorted(assignments.items())),
          'entropy_bit_start':start,'entropy_bit_end':entropy.offset,
          'method':'Per-label Fisher-Yates with rejection sampling over previously unused archived physical-entropy bits.',
          'timing':'After output annotation, before any fitting or classifier evaluation on these data.',
          'reason':'All five normal cases fell in the initial generator train split; initial split remains in raw records.',
          'limitation':'CAL and TEST each contain only one normal case. This cannot establish a reliable false-positive rate.'}
target.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('Created separate stratified split using physical bits',start,'..',entropy.offset)
