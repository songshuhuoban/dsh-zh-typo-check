"""Export the fixed round-3 comparison and uncertainty, without public texts."""
import hashlib
import json
import math
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT/'.research/semantic-round3'
data = json.loads((WORK/'prepared.json').read_text(encoding='utf-8'))
result = json.loads((WORK/'results.json').read_text(encoding='utf-8'))
selection = result['selection']
for name, expected in selection['split_hashes_before_selection'].items():
    actual = hashlib.sha256(json.dumps(data[name],ensure_ascii=False,sort_keys=True).encode()).hexdigest()
    assert actual == expected
assert hashlib.sha256((WORK/selection['selected']['artifact']).read_bytes()).hexdigest() == selection['checkpoint_sha256']
assert hashlib.sha256((WORK/selection['selected']['torch_checkpoint']).read_bytes()).hexdigest() == selection['torch_checkpoint_sha256']


def rate(values):
    k,n = values
    if not n:
        return {'count':k,'total':n,'rate':None,'wilson_95':None}
    p = k/n;z = 1.959963984540054
    denominator = 1+z*z/n
    center = (p+z*z/(2*n))/denominator
    radius = z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/denominator
    return {'count':k,'total':n,'rate':p,'wilson_95':[max(0.,center-radius),min(1.,center+radius)]}


summary = {'date':'2026-11-09','issue':'SIM-1037',
           'base_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
           'code_hashes':{str(p.relative_to(ROOT)).replace('\\','/'):hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in [ROOT/'tools/semantic-round3.py',ROOT/'tools/semantic-round2.py',
                                    ROOT/'tools/semantic-round2-native.mjs',ROOT/'tools/semantic-screen-requirements.txt']},
           'manifest':result['manifest'],'selection':selection,
           'cpu':'AMD Ryzen 7 8745H; 4 inference threads; batch=1',
           'latency_scope':'Native tensor construction and inference, excluding tokenization and model load.',
           'split_roles':{'ime_test':'New model-held-out IME examples, assistant labels; only one normal.',
                          'known_round2':'Previously opened 425-case regression set.',
                          'known_legacy':'Previously opened 70-case regression set.'},
           'configurations':{}}
for key, configuration in result['configurations'].items():
    item = {'threshold':configuration['threshold'],'splits':{}}
    for split, measured in configuration['splits'].items():
        out = {k:v for k,v in measured.items() if k!='predictions'}
        out['rates'] = {k:rate(measured['metrics'][k]) for k in
                        ['normal_false_positives','noise_detected','context_warnings']}
        out['predictions'] = []
        for prediction, row in zip(measured['predictions'],data[split]):
            recorded = {**prediction,'category':row['category']}
            if split=='ime_test':
                recorded.update(text=row['text'],confidence=row['confidence'])
            out['predictions'].append(recorded)
        item['splits'][split] = out
    summary['configurations'][key] = item
target = ROOT/'data/semantic-round3-results.json'
target.write_text(json.dumps(summary,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8')
print('Saved',target.name)
