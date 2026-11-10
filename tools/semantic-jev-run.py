"""Resolve the existing private credential into a child environment, never files/logs."""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.research/semantic-jev'
SECRET_REF = os.environ.get('TYPESAFE_NUTO_SECRET_REF')


def main():
    approval = json.loads((WORK / 'authorization.json').read_text(encoding='utf-8'))
    if not approval.get('approval'):
        raise SystemExit('Cloud experiment approval is missing')
    child_env = os.environ.copy()
    if not child_env.get('TYPESAFE_API_KEY'):
        if not SECRET_REF:
            raise SystemExit('Provide TYPESAFE_API_KEY or TYPESAFE_NUTO_SECRET_REF; no private credential reference is bundled')
        # Only this process receives the producer's raw stdout. It is never returned to
        # the model/tool output, printed, put into a command argument, or written to disk.
        producer = subprocess.Popen(['nuto', '--env', 'staging', 'secret', 'resolve', SECRET_REF, '--raw'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        value, diagnostic = producer.communicate(timeout=30)
        if producer.returncode != 0:
            raise SystemExit(f'Nuto Secret resolution failed, exit{producer.returncode}; credential output withheld')
        child_env['TYPESAFE_API_KEY'] = value.decode('utf-8').strip()
        if not child_env['TYPESAFE_API_KEY']:
            raise SystemExit('Resolved credential is empty')
    command = ['node', str(ROOT / 'tools/semantic-jev.mjs'), *(sys.argv[1:] or ['run-all'])]
    try:
        completed = subprocess.run(command, cwd=ROOT, env=child_env,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        raise SystemExit(completed.returncode)
    finally:
        child_env.pop('TYPESAFE_API_KEY', None)


if __name__ == '__main__':
    main()
