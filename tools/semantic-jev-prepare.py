"""Prepare a reviewable Jev experiment without calling the inference API."""
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.research/semantic-jev'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def save(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    assert not (WORK / 'manifest.json').exists(), 'Keep the sealed plan unchanged'
    WORK.mkdir(exist_ok=True)
    spec = importlib.util.spec_from_file_location('q', ROOT / 'tools/semantic-qwen35.py')
    q = importlib.util.module_from_spec(spec); spec.loader.exec_module(q)
    evaluation, _ = q.frozen(); prior, _, _ = q.r13.frozen()
    screen = read(q.WORK / 'calibration-plan.json')['rows']
    decorate = lambda row: dict(row, language=q.r13.r4.language(row['text']))
    data = {'screen': [decorate(row) for row in screen], 'cal': [decorate(row) for row in prior['cal']],
            'evaluation': {split: [decorate(row) for row in rows] for split, rows in evaluation.items()}}
    assert len(data['screen']) == 90 and len(data['cal']) == 1670
    assert sum(map(len, data['evaluation'].values())) == 675
    cal_texts = {row['text'] for row in data['cal']}
    assert all(row['text'] in cal_texts for row in data['screen'])
    assert not (cal_texts & {row['text'] for rows in evaluation.values() for row in rows})
    save(WORK / 'prepared.json', data)
    script = "import {requestFor} from './tools/semantic-jev-questions.mjs';process.stdout.write(JSON.stringify(requestFor('女哦就是的感受a到啊删掉asd苏打粉二十个s收到')))"
    # Use structured subprocess input; the text is never interpreted by a shell.
    preview = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script], cwd=ROOT, encoding='utf-8'))
    save(WORK / 'request-preview.json', preview)
    sources = [q.WORK / 'prepared.json', q.WORK / 'calibration-plan.json', q.r13.WORK / 'prepared.json',
               q.r13.WORK / 'selection.json', ROOT / 'data/semantic-qwen35-comparison.json',
               ROOT / 'tools/semantic-jev-questions.mjs', Path(__file__)]
    sources += sorted((WORK / 'docs').glob('*'))
    manifest = {
        'prepared_at_utc': datetime.now(timezone.utc).isoformat(),
        'model': preview['model'], 'endpoint': 'https://api.typesafe.ai/v1/systemone',
        'source_sha256': {str(path.relative_to(ROOT)): sha(path) for path in sources},
        'prepared_sha256': sha(WORK / 'prepared.json'),
        'data_role': '1670 existing CAL and675 known-regression assistant labels; not new blind/human gold; no new physical randomness.',
        'screen': {'rows': 90, 'variants': ['direct_en', 'direct_zh', 'decomposed'],
                   'thresholds': [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99],
                   'selection': 'Min noiseFN+3*(normalFP+contextWarnings); then fewer normalFP, fewer context warnings, more noiseTP, variant order. CAL only.'},
        'calibration': {'rows': 1670,
            'primary': 'Match prior R13 CAL operating policy: normal warnings<=floor(0.005*n_normal), context warnings0; highest attainable noise recall under these constraints.',
            'secondary': 'Fixed0.7 and CAL minimum FN+3*(normalFP+contextWarnings), reported separately; never select thresholds on675.',
            'policy_is_user_agreed_release_threshold': False},
        'evaluation': {'rows': 675, 'all_known_regression': True,
                       'primary': 'Frozen selected question variant and threshold; compare R13/Qwen and prespecified R13 AND/OR Jev combinations.'},
        'runtime': {'concurrency': 6, 'timeout_seconds': 20, 'max_attempts_per_case': 3,
                    'rate_limit': 'Respect Retry-After; bounded backoff; abort on auth, payment or schema errors.',
                    'model_per_request_token_ceiling': 64000, 'input_usd_per_million': 0.042,
                    'network_failures': 'Separate unavailable/error, never count as a normal or correct uncertain answer.',
                    'timing': 'Report concurrent throughput separately from serial20-case wall latency; no claim of local/offline Jev.'},
        'authorization': 'Required before sending sample text; proposed USD0.25 hard cap, existing Nuto Secret key exposed only to child environment TYPESAFE_API_KEY.',
        'scope': 'Final research comparison and final scheme recommendation; no plugin UI/deployment or default cloud-input switch in this unit.'
    }
    save(WORK / 'manifest.json', manifest)
    save(WORK / 'authorization-proposal.json', {
        'suggested_budget_usd': 0.25, 'expected_usd': 'Under0.10 estimate; actual input_tokens recorded from API.',
        'data_sent': 'Text fields only from existing1670 CAL plus675 regression and repeated short probes. Includes actual IME outputs, public/self-authored zh/en/mixed sentences, the original user example, and any names within those samples.',
        'credential': 'Existing private Nuto Secret TYPESAFE_JEV_API_KEY, used as TYPESAFE_API_KEY; no key value in files/logs.',
        'payload_preview': str((WORK / 'request-preview.json').relative_to(ROOT)),
        'manifest_sha256': sha(WORK / 'manifest.json'), 'approval': None
    })
    print(json.dumps({'prepared_cal': 1670, 'screen_subset': 90, 'known_regression': 675,
                      'model': preview['model'], 'api_calls_made': 0, 'manifest_sha256': sha(WORK / 'manifest.json')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
