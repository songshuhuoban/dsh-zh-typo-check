"""Build the CPU-only, under-600 MB Q4 research package after timed jobs finish."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.research/semantic-qwen35'
OUT = WORK / 'package'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    # Keep file copies, compression and large hashes out of measured inference runs.
    assert (WORK / 'results.json').exists()
    assert (ROOT / '.research/semantic-qwen35-dash/results.json').exists()
    downloads = read(WORK / 'downloads.json')
    model = next(item for item in downloads['files'] if item['name'] == 'q4')
    runtime = ROOT / downloads['runtime_dir']
    OUT.mkdir(exist_ok=True)
    (OUT / 'runtime').mkdir(exist_ok=True)
    (OUT / 'licenses').mkdir(exist_ok=True)
    # Official CPU dispatch variants are preserved; unrelated executables and Vulkan
    # are omitted. No native binary is modified or rebuilt.
    names = ['llama-server.exe', 'llama-server-impl.dll', 'llama-common.dll',
             'llama.dll', 'mtmd.dll', 'ggml.dll', 'ggml-base.dll', 'libomp.dll',
             'ggml-rpc.dll', 'LICENSE-LLVM-OpenMP']
    source_files = [runtime / name for name in names] + sorted(runtime.glob('ggml-cpu-*.dll'))
    for source in source_files:
        expected = downloads['runtime_inventory'][source.name]
        if isinstance(expected, dict):
            expected = expected['sha256']
        assert sha(source) == expected
        shutil.copy2(source, OUT / 'runtime' / source.name)
    source_model = WORK / model['file']
    assert source_model.stat().st_size == model['bytes'] and sha(source_model) == model['sha256']
    shutil.copy2(source_model, OUT / 'model.gguf')
    shutil.copy2(ROOT / 'tools/semantic-qwen35-check.mjs', OUT / 'check.mjs')
    for source in (WORK / 'licenses').glob('*.txt'):
        shutil.copy2(source, OUT / 'licenses' / source.name)
    selected = read(WORK / 'calibration-selection.json')['selected']
    config = {
        'model': 'model.gguf', 'model_sha256': model['sha256'],
        'server': 'runtime/llama-server.exe', 'backend': 'cpu',
        'vulkan_included': False, 'variant': 'q4',
        'status': 'research-only-not-approved', 'env_override': {},
        'prompt': dict(selected['config'], n_predict=8),
        'completion_policy': read(WORK / 'completion-policy.json'),
        'runtime_release': 'b12110',
        'host_prerequisite': 'Existing Node.js with fetch and AbortSignal.timeout; not bundled.',
        'budget_bytes': 600_000_000,
    }
    save(OUT / 'config.json', config)
    (OUT / 'README.txt').write_text(
        'Qwen3.5-0.8B Q4_K_M CPU research reference, SIM-1049, 2026-11-10\n'
        'Requires an existing Node.js installation and Windows x64. Node is not bundled.\n'
        'Run from this folder: node check.mjs --text "text to classify"\n'
        '0=normal, 1=anomaly/warn, 2=uncertain/no warning.\n'
        'The model is SHA256 checked before launch. The server binds to localhost only,\n'
        'uses a temporary port, and is stopped when the check finishes. No input logs are saved.\n'
        'Frozen 3-shot prompt; at most 8 tokens, stop at the first complete label.\n'
        'This package contains the Q4 CPU reference, not a selected product replacement.\n'
        'Its known-regression results were worse than the task-finetuned R13 reference.\n'
        'The original reported gibberish was missed; see REPORT-SEMANTIC-QWEN35.md.\n'
        'The 600 MB limit is disk package size, not RAM consumption.\n', encoding='utf-8')
    inventory = {str(path.relative_to(OUT)).replace('\\', '/'):
                 {'bytes': path.stat().st_size, 'sha256': sha(path)}
                 for path in sorted(OUT.rglob('*')) if path.is_file() and path.name != 'inventory.json'}
    save(OUT / 'inventory.json', {'files': inventory, 'note': 'Inventory excludes its own hash.'})
    size = sum(path.stat().st_size for path in OUT.rglob('*') if path.is_file())
    assert size <= 600_000_000, size
    assert sha(OUT / 'model.gguf') == model['sha256']
    archive = WORK / 'qwen35-q4-cpu-research.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as zipped:
        for path in sorted(OUT.rglob('*')):
            if path.is_file():
                zipped.write(path, str(path.relative_to(OUT)))
    with zipfile.ZipFile(archive) as zipped:
        assert zipped.testzip() is None
        assert sum(item.file_size for item in zipped.infolist()) == size
    result = {'built_at_utc': datetime.now(timezone.utc).isoformat(), 'variant': 'q4-cpu',
              'package_dir': str(OUT.relative_to(ROOT)), 'unpacked_bytes': size,
              'model_bytes': model['bytes'], 'runtime_bytes': sum(path.stat().st_size for path in source_files),
              'archive': str(archive.relative_to(ROOT)), 'archive_bytes': archive.stat().st_size,
              'archive_sha256': sha(archive), 'budget_bytes': 600_000_000,
              'host_prerequisite': config['host_prerequisite'], 'inventory': 'package/inventory.json'}
    save(WORK / 'package-result.json', result)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
