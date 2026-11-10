"""One fixed-recipe ELECTRA-small fine-tuning trial after the frozen screen.

All encoder weights are trained on the same weakly labelled noise training set.
No product fixture is used for training, checkpoint selection or thresholds.
3 epochs, AdamW 8e-5, length-bucketed batch 32, 10% warmup, seed 20261109, max length 96.
Checkpoint selection: AUROC on clean CAL + synthetic corruptions of that CAL.
This tests a training route, not a validated general semantic detector.
"""
import copy
import argparse
import importlib.util
import json
import math
import pathlib
import random
import time

import numpy as np
import torch
import onnxruntime as ort
from onnxruntime.quantization import QuantType, quantize_dynamic
from sklearn.metrics import roc_auc_score
from transformers import AutoModel, AutoTokenizer, get_linear_schedule_with_warmup
from huggingface_hub import snapshot_download

spec = importlib.util.spec_from_file_location('screen', pathlib.Path(__file__).with_name('semantic-screen.py'))
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)
WORK, SEED = screen.WORK, screen.SEED
torch.set_num_threads(4)
torch.set_num_interop_threads(1)
torch.manual_seed(SEED)
random.seed(SEED)
np.random.seed(SEED)
data = json.loads((WORK / 'prepared.json').read_text(encoding='utf-8'))
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--model', choices=list(screen.MODELS), default='electra-small')
model_key = parser.parse_args().model
output_key = model_key + '-finetuned'
repo, revision = screen.MODELS[model_key]
folder = snapshot_download(repo, revision=revision, cache_dir=str(WORK / 'hf-cache'),
    allow_patterns=['config.json', 'pytorch_model.bin', 'vocab.txt'])
tokenizer = AutoTokenizer.from_pretrained(folder, local_files_only=True, trust_remote_code=False, use_fast=True)


class NoiseModel(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = AutoModel.from_pretrained(folder, local_files_only=True, trust_remote_code=False, attn_implementation='eager')
        self.dropout = torch.nn.Dropout(.1)
        self.head = torch.nn.Linear(self.encoder.config.hidden_size * 2, 1)
    def forward(self, input_ids, attention_mask, token_type_ids):
        hidden = self.encoder(input_ids=input_ids, attention_mask=attention_mask, token_type_ids=token_type_ids).last_hidden_state
        mask = attention_mask.unsqueeze(-1).to(hidden.dtype)
        mean = (hidden * mask).sum(1) / mask.sum(1)
        return self.head(self.dropout(torch.cat([hidden[:, 0], mean], 1))).squeeze(-1)


model = NoiseModel()
optimizer = torch.optim.AdamW(model.parameters(), lr=8e-5, weight_decay=.01)
steps = math.ceil(len(data['noise-train']) / 32) * 3
scheduler = get_linear_schedule_with_warmup(optimizer, num_warmup_steps=steps // 10, num_training_steps=steps)
train_inputs = tokenizer([r['text'] for r in data['noise-train']], padding=True, truncation=True, max_length=96, return_tensors='pt')
labels = torch.tensor([r['label'] for r in data['noise-train']], dtype=torch.float32)
cal_clean = data['noise-cal']
cal_broken = [{'text': screen.corrupt(row['text'], 200000 + i)[0], 'label': 1} for i, row in enumerate(cal_clean)]
cal_clean_keys = {screen.canonical(row['text']) for row in cal_clean}
cal_broken = [r for r in cal_broken if screen.canonical(r['text']) not in cal_clean_keys]
cal = cal_clean + cal_broken


def torch_scores(rows):
    model.eval()
    values = []
    with torch.inference_mode():
        for offset in range(0, len(rows), 64):
            inp = tokenizer([r['text'] for r in rows[offset:offset+64]], padding=True, truncation=True, max_length=96, return_tensors='pt')
            values.extend(model(**inp).tolist())
    return np.array(values)


history, best_auc, best_weights = [], -1, None
started = time.perf_counter()
for epoch in range(3):
    model.train()
    order = torch.argsort(train_inputs['attention_mask'].sum(1))
    buckets = list(order.split(32))
    bucket_order = torch.randperm(len(buckets))
    losses = []
    for step, bucket_index in enumerate(bucket_order):
        batch = buckets[int(bucket_index)]
        width = int(train_inputs['attention_mask'][batch].sum(1).max())
        inp = {k: v[batch, :width] for k, v in train_inputs.items()}
        optimizer.zero_grad(set_to_none=True)
        logits = model(**inp)
        loss = torch.nn.functional.binary_cross_entropy_with_logits(logits, labels[batch])
        assert torch.isfinite(loss), 'Non-finite training loss'
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.)
        optimizer.step()
        scheduler.step()
        losses.append(loss.item())
        if step % 50 == 0:
            print(f'epoch {epoch+1}, batch {step}/{len(buckets)}', flush=True)
    auc = float(roc_auc_score([r['label'] for r in cal], torch_scores(cal)))
    history.append({'epoch': epoch + 1, 'training_loss': float(np.mean(losses)), 'cal_synthetic_auroc': auc})
    print(json.dumps(history[-1]), flush=True)
    if auc > best_auc:
        best_auc = auc
        best_weights = copy.deepcopy(model.state_dict())
model.load_state_dict(best_weights)
model.eval()
torch.save(best_weights, WORK / (output_key + '-weights.pt'))
train_seconds = time.perf_counter() - started

sample = tokenizer('这个 API 请求需要重试。', return_tensors='pt')
names = ['input_ids', 'attention_mask', 'token_type_ids']
full, small = WORK / (output_key + '.onnx'), WORK / (output_key + '-int8.onnx')
torch.onnx.export(model, tuple(sample[n] for n in names), str(full), input_names=names, output_names=['logits'],
    dynamic_axes={n: {0: 'batch', 1: 'sequence'} for n in names} | {'logits': {0: 'batch'}}, opset_version=17, dynamo=False)
quantize_dynamic(str(full), str(small), weight_type=QuantType.QInt8)
options = ort.SessionOptions()
options.intra_op_num_threads, options.inter_op_num_threads = 4, 1


def scores(rows, session):
    values = []
    for row in rows:
        inp = tokenizer(row['text'], truncation=True, max_length=96, return_tensors='np')
        feed = {n.name: inp[n.name].astype(np.int64) for n in session.get_inputs()}
        values.append(float(session.run(None, feed)[0][0]))
    return np.array(values)


def metrics(rows, values, threshold):
    y = np.array([r['label'] for r in rows])
    p = values > threshold
    result = {'n': len(rows)}
    for label, name in [(0, 'false_positive_rate'), (1, 'recall'), (-1, 'uncertain_warning_rate')]:
        selected = y == label
        if selected.any():
            result[name] = float(p[selected].mean())
            result[name + '_count'] = [int(p[selected].sum()), int(selected.sum())]
    selected = y >= 0
    if len(set(y[selected])) == 2:
        result['auroc'] = float(roc_auc_score(y[selected], values[selected]))
    return result


result = {'model': output_key, 'repo': repo, 'revision': revision,
    'protocol': __doc__, 'seed': SEED, 'training_rows': len(labels), 'cal_rows': len(cal),
    'history': history, 'train_seconds': train_seconds, 'quantized_noise': {}, 'fp32_noise': {},
    'export': {'int8_bytes': small.stat().st_size, 'fp32_bytes': full.stat().st_size}}
float_session = ort.InferenceSession(str(full), options, providers=['CPUExecutionProvider'])
quant_session = ort.InferenceSession(str(small), options, providers=['CPUExecutionProvider'])
for key, session in [('fp32_noise', float_session), ('quantized_noise', quant_session)]:
    cut = float(np.quantile(scores(cal_clean, session), .99, method='higher'))
    result[key + '_threshold'] = cut
    for task in ['cs-test', 'synthetic-test', 'product-test']:
        values = scores(data[task], session)
        result[key][task] = metrics(data[task], values, cut)
        if task == 'product-test' and key == 'quantized_noise':
            result['quantized_product_predictions'] = [dict(r, score=float(v), warning=bool(v > cut)) for r, v in zip(data[task], values)]
float_values = scores(data['product-test'], float_session)
torch_values = torch_scores(data['product-test'])
result['export']['fp32_ort_max_logit_drift'] = float(np.abs(float_values - torch_values).max())
assert result['export']['fp32_ort_max_logit_drift'] < .001
elapsed = []
for row in data['product-test']:
    tick = time.perf_counter()
    scores([row], quant_session)
    elapsed.append((time.perf_counter() - tick) * 1000)
result['export']['latency_p50_ms'] = float(np.median(elapsed))
result['export']['latency_p95_ms'] = float(np.percentile(elapsed, 95))
screen.write_json(WORK / (output_key + '-result.json'), result)
screen.write_json(WORK / (output_key + '-native-inputs.json'), {
    'threshold': result['quantized_noise_threshold'],
    'cal': [dict(row, inputs=dict(tokenizer(row['text'], truncation=True, max_length=96))) for row in cal_clean],
    'rows': [dict(row, inputs=dict(tokenizer(row['text'], truncation=True, max_length=96)))
             for row in result['quantized_product_predictions']],
})
print(json.dumps({k: v for k, v in result.items() if k != 'quantized_product_predictions'}), flush=True)
