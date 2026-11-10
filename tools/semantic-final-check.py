"""Run the frozen final local recommendation; no cloud request or automatic rewrite."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--text', action='append', required=True)
    args = parser.parse_args()
    selected = json.loads((ROOT / 'data/semantic-final-selection.json').read_text(encoding='utf-8'))
    package = ROOT / selected['model_package']
    for relative, expected in selected['package_sha256'].items():
        with (package / relative).open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != expected:
            raise SystemExit(f'Frozen model package changed: {relative}')
    version_script = "import{createRequire}from'node:module';const r=createRequire(import.meta.url);process.stdout.write(r('onnxruntime-node/package.json').version)"
    version = subprocess.check_output(['node', '--input-type=module', '-e', version_script], cwd=ROOT, encoding='utf-8').strip()
    if version != selected['native_runtime']['version']:
        raise SystemExit('Native ONNX runtime version differs from the calibrated version; semantic result unavailable')
    command = [sys.executable, '-X', 'utf8', str(ROOT / 'tools/semantic-predict.py'), '--package', str(package)]
    for text in args.text:
        command += ['--text', text]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=60)
    if result.returncode:
        raise SystemExit('Local semantic inference failed; result unavailable: ' + result.stderr[-1000:])
    rows = [json.loads(line) for line in result.stdout.splitlines() if line]
    if any(row.get('truncated_encoder_inputs', 0) for row in rows):
        for text in args.text:
            print(json.dumps({'text': text, 'status': 'unavailable', 'reason': 'input_exceeds128_encoder_tokens', 'warning': None}, ensure_ascii=False))
        raise SystemExit(2)
    if len(rows) != len(args.text):
        raise SystemExit('Incomplete inference output; result unavailable')
    for row in rows:
        print(json.dumps(dict(row, model='r13-final-local', cloud_request=False, auto_replace=False,
                              selection_status=selected['status']), ensure_ascii=False))


if __name__ == '__main__':
    main()
