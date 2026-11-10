"""Collect immutable CPU/DirectML benchmark records and verify their provenance."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.research/semantic-directml'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == '__main__':
    records = []
    for path in sorted(WORK.glob('*-b*-s*.json')):
        result = json.loads(path.read_text(encoding='utf-8'))
        result['record'] = path.name
        result['record_sha256'] = sha(path)
        records.append(result)
    by_name = {x['record']: x for x in records}
    primary = []
    for sequence in (64, 128):
        cpu = by_name[f'portable-cpu24-b32-s{sequence}.json']
        dml = by_name[f'portable-dml-b32-s{sequence}.json']
        for value in (cpu, dml):
            assert value['ok'] and value['all_final_parameters_finite']
            assert value['model_safetensors_sha256'] == sha(WORK / 'model.safetensors')
            assert value['benchmark_script_sha256'] == sha(ROOT / 'tools/semantic-device-benchmark.py')
            assert value['optimizer_script_sha256'] == sha(ROOT / 'tools/semantic_device_optim.py')
            assert value['backbone_first_gradient_max'] > 0 and value['backbone_weight_max_delta'] > 0
            assert not value['warnings'], value['warnings']
            assert value['optimizer_equivalence_check']['max_abs_parameter_error_vs_stock_cpu_adamw'] < 1e-6
        primary.append({
            'batch': 32, 'sequence': sequence,
            'cpu24_portable_mean_step_seconds': cpu['mean_step_seconds'],
            'directml_portable_mean_step_seconds': dml['mean_step_seconds'],
            'same_torch_optimizer_cpu_to_directml_speed_ratio': cpu['mean_step_seconds']/dml['mean_step_seconds'],
            'directml_examples_per_second': dml['examples_per_second'],
        })
    result = {
        'generated_at_utc': datetime.now(timezone.utc).isoformat(),
        'scope': 'Short FP32 full-backprop training benchmark, not a new model quality experiment.',
        'hardware': json.loads((WORK / 'hardware.json').read_text(encoding='utf-8-sig')),
        'system': json.loads((WORK / 'system.json').read_text(encoding='utf-8-sig')),
        'environment': (WORK / 'environment-directml.txt').read_text(encoding='utf-8-sig').splitlines(),
        'inputs_sha256': sha(WORK / 'inputs.json'),
        'primary_comparisons': primary,
        'records': records,
        'notes': [
            'POST-VALIDATION CORRECTION: stock DirectML CE(reduction=none) fails per-sample weighting backward. These historical timings are not proof of mathematically correct weighted training.',
            '4 CPU threads, batch 32, 2 warm-up + 5 measured steps; synchronized each step.',
            'Weights and inputs are our R3 model and TRAIN-only data, not held-out evaluation text.',
            'Fixed batch and sequence padding; excludes model load and tokenization.',
            'Stock DirectML AdamW falls back for lerp; portable dense-FP32 update passed a 10-step stock-AdamW equivalence probe.',
            'Portable run emitted no unsupported-operator fallback warnings; this is not a kernel-level utilization trace.',
            'GPU and CPU do not have identical dropout random streams; losses here are not a quality comparison.',
        ],
    }
    result['training_correctness']={
        'historical_loss_path_valid':False,
        'reason':'DirectML 0.2.5 stock CE(reduction=none) does not correctly propagate upstream per-row weights and task masks.',
        'reproducer':'data/semantic-directml-loss-check.json',
        'corrected_loss':'tools/semantic_device_loss.py',
        'corrected_full_gradient_evidence':'.research/semantic-round4/device-gradient-corrected-r3.json',
        'warning':'Do not use the old speed ratios as validation of correct fine-tuning.'}
    output = ROOT / 'data/semantic-device-results.json'
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'records': len(records), 'primary_comparisons': primary}, ensure_ascii=False))
