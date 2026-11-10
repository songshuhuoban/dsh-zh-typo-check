"""Export sealed round-2 evidence without redistributing public source text."""
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.research/semantic-round2'


def read(name):
    return json.loads((WORK / name).read_text(encoding='utf-8'))


def rate(counts):
    """Wilson interval describes this sample only, not distribution guarantees."""
    k, n = counts
    p = k / n
    z = 1.959963984540054
    denominator = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denominator
    radius = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return {'count': k, 'total': n, 'rate': p,
            'wilson_95': [max(0., center - radius), min(1., center + radius)]}


def script_bucket(text):
    cjk = bool(re.search('[\u4e00-\u9fff]', text))
    latin = bool(re.search('[A-Za-z]', text))
    return 'cjk_latin' if cjk and latin else 'cjk' if cjk else 'latin_or_other'


data, manifest, result = read('prepared.json'), read('manifest.json'), read('results.json')
for split, expected in manifest['split_hashes'].items():
    actual = hashlib.sha256(json.dumps(data[split], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    assert actual == expected, f'{split} data changed after freezing'
selected = result['selection']
assert selected['test_sha256_before_selection'] == manifest['split_hashes']['test']
assert hashlib.sha256((WORK / selected['selected']['artifact']).read_bytes()).hexdigest() == selected['checkpoint_sha256']

summary = {
    'date': '2026-11-09',
    'issue': 'SIM-1035',
    'base_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    'label_caveat': result['label_caveat'],
    'manifest': manifest,
    'selection': selected,
    'cpu': 'AMD Ryzen 7 8745H; 4 inference threads; batch=1',
    'latency_scope': 'Native tensor construction plus session.run, excluding tokenization and model load; first 5 samples excluded.',
    'configurations': {},
}
for key, config in result['configurations'].items():
    out = {'threshold': config['threshold']}
    for split in ['test', 'regression']:
        native = read(f'{key}-{split}-scores.json')
        stats = config[split]
        out[split] = {
            'normal_false_positives': rate(stats['normal_false_positives']),
            'noise_detected': rate(stats['noise_detected']),
            'context_warnings': rate(stats['context_warnings']),
            'auroc': stats['auroc'],
            'categories': stats['categories'],
            'truncated': config[split + '_truncated'],
            'native_version': native['native_version'],
            'latency_p50_ms': native['latency_p50_ms'],
            'latency_p95_ms': native['latency_p95_ms'],
            'predictions': [],
            'script_breakdown': {},
        }
        for prediction in config[split + '_predictions']:
            index = prediction['index']
            row = data[split][index]
            recorded = {**prediction, 'category': row.get('category', 'regression')}
            # Authored text is in tracked fixtures. Public text stays in ignored caches.
            if row.get('source', '').startswith('https://'):
                recorded['source_url'] = row['source']
            out[split]['predictions'].append(recorded)
        for bucket in ['cjk_latin', 'cjk', 'latin_or_other']:
            entries = [(row, p) for row, p in zip(data[split], config[split + '_predictions'])
                       if script_bucket(row['text']) == bucket]
            out[split]['script_breakdown'][bucket] = {
                label: [sum(p['warning'] for r, p in entries if r['label'] == number),
                        sum(r['label'] == number for r, p in entries)]
                for number, label in [(0, 'normal_false_positives'), (1, 'noise_detected'), (2, 'context_warnings')]
            }
    summary['configurations'][key] = out

target = ROOT / 'data/semantic-round2-results.json'
target.write_text(json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
print('Saved', target.name)
