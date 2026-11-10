"""Copy small, auditable research results out of the ignored model cache."""
import hashlib
import json
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parents[1]
work = root / '.research/semantic-screen'
manifest = json.loads((work/'manifest.json').read_text(encoding='utf-8'))
summary = {
    'date': '2026-11-09',
    'base_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
    'counts': manifest['counts'],
    'removed_conflicting_training_negatives': manifest['removed_unchanged_or_conflicting_training_negatives'],
    'source_revisions': manifest['github'],
    'prepared_sha256': hashlib.sha256((work/'prepared.json').read_bytes()).hexdigest(),
    'fixture_sha256': hashlib.sha256((root/'data/mixed-semantic-screen.json').read_bytes()).hexdigest(),
    'cpu': 'AMD Ryzen 7 8745H; 4 inference threads',
    'models': json.loads((work/'hf-survey.json').read_text(encoding='utf-8'))['models'],
    'experiments': {},
}
for filename in sorted(work.glob('*-result.json')):
    result = json.loads(filename.read_text(encoding='utf-8'))
    key = result.get('model', 'current-plugin-' + result.get('version', 'unknown'))
    for name in ['product_predictions', 'quantized_product_predictions', 'predictions']:
        if name in result:
            result[name] = [{'fixture_index': i, **{k: v for k, v in row.items() if k in ['label', 'score', 'warning', 'specific']}}
                            for i, row in enumerate(result[name])]
    summary['experiments'][key] = result
if (work/'native-runtime-check.json').exists():
    summary['native_runtime_check'] = json.loads((work/'native-runtime-check.json').read_text(encoding='utf-8'))
target = root/'data/semantic-screen-results.json'
target.write_text(json.dumps(summary, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print('Saved', target.name, 'with', len(summary['experiments']), 'configurations')
