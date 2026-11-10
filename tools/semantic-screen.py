"""Local exploratory screen, NOT a production detector or a leaderboard run.

python tools/semantic-screen.py prepare
python tools/semantic-screen.py run --model minirbt
python tools/semantic-screen.py run --model uer-tiny
python tools/semantic-screen.py run --model electra-small

See REPORT-SEMANTIC-SCREEN.md for task distinctions and limitations. Public
corpora and downloaded models stay in gitignored .research/. No remote code
is executed; all inference is local, on CPU, with frozen encoders.
"""
from __future__ import annotations

import argparse
import collections
import concurrent.futures
import csv
import hashlib
import io
import json
import os
import pathlib
import platform
import random
import re
import sys
import time
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORK = ROOT / '.research' / 'semantic-screen'
SEED = 20261109
MODELS = {
    'minirbt': ('hfl/minirbt-h256', '446e1b4012b10946f479563005700c54c9db3f7c'),
    'uer-tiny': ('uer/chinese_roberta_L-2_H-128', '151f4204cbb5784c4126a89a94ef0bb044273ac0'),
    'electra-small': ('hfl/chinese-electra-180g-small-discriminator', '826a243f3f387450ef8d70de9c3d0706d8d8e924'),
}
MULTILINGUAL = ('Xenova/paraphrase-multilingual-MiniLM-L12-v2', '2c4055b12046f11709e9df2c122e59ffbdc2f900')
GITHUB = {
    'colac': ('huhailinguist/CoLAC', 'b5b79306a940ebcd75164cc3a460f2dd827651dc'),
    'cola': ('nyu-mll/CoLA-baselines', 'dd095d3646ed05a315280aaa8ed4ec84ba435b3e'),
    'cs': ('lfang1/CodeSwitchingResearch', '80757512bc86c386302269f070b2a5e7fe57dfa2'),
    'sling': ('Yixiao-Song/SLING_Data_Code', '5a7f791fbb9db6d2fee66e128fe89c80ac1f993b'),
}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def fetch(url, filename):
    dest = WORK / 'downloads' / filename
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        req = urllib.request.Request(url, headers={'User-Agent': 'dsh-semantic-screen/1'})
        with urllib.request.urlopen(req, timeout=120) as response:
            raw = response.read()
        dest.write_bytes(raw)
    return dest.read_bytes()


def github(key, path):
    repo, rev = GITHUB[key]
    return fetch(f'https://raw.githubusercontent.com/{repo}/{rev}/{path}', key + '-' + path.replace('/', '_'))


def canonical(text):
    return re.sub(r'\s+', ' ', text).strip()


def unsegment(text):
    text = re.sub(r'(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])', '', text)
    text = re.sub(r'\s+([，。？！；：（）])', r'\1', text)
    return re.sub(r'([（：])\s+', r'\1', text).strip()


def take(rows, n, seed=SEED):
    rows = list(rows)
    random.Random(seed).shuffle(rows)
    return rows[:n]


def corrupt(text, index):
    """Weak labels, deliberately coarse. Never claim these are human gold."""
    rng = random.Random(SEED + index)
    mode = index % 3
    if mode == 0:
        chunks = re.findall(r'[A-Za-z0-9_.]+|[\u4e00-\u9fff]{1,2}|[^\s]', text)
        rng.shuffle(chunks)
        return ' '.join(chunks), 'shuffle'
    if mode == 1:
        at = len(text) // 2
        return text[:at] + ' qzvxjk ' * 4 + text[at:], 'keyboard-insertion'
    # Preserve some local words while disrupting the sequence of larger spans.
    mid = max(1, len(text) // 3)
    return text[-mid:] + ' ' + text[mid:-mid] + ' ' + text[:mid] + ' ' + text[-mid:], 'span-permutation'


def prepare():
    WORK.mkdir(parents=True, exist_ok=True)
    public, manifest = {}, {'seed': SEED, 'github': GITHUB, 'models': MODELS, 'notes': []}
    with zipfile.ZipFile(io.BytesIO(github('colac', 'CoLAC-final.zip'))) as z:
        for split in ['train', 'dev']:
            rows = list(csv.DictReader(io.StringIO(z.read(split + '.csv').decode('utf-8-sig'))))
            public['colac-' + split] = [{'text': r['sentence'], 'label': int(r['label1'])} for r in rows]
        test_rows = list(csv.DictReader(io.StringIO(z.read('test.csv').decode('utf-8-sig'))))
        assert 'label1' not in test_rows[0], 'Revisit protocol if public test labels change'
    manifest['notes'].append('CoLAC test.csv has NO labels; evaluate the official dev split, never invent test accuracy.')
    for split, files in {
        'train': ['in_domain_train.tsv'],
        'dev': ['in_domain_dev.tsv', 'out_of_domain_dev.tsv'],
    }.items():
        rows = []
        for name in files:
            raw = github('cola', 'acceptability_corpus/raw/' + name).decode('utf-8-sig')
            for r in csv.reader(io.StringIO(raw), delimiter='\t'):
                rows.append({'text': r[3], 'label': int(r[1])})
        public['cola-' + split] = rows

    # Remove exact normalized train/evaluation overlaps and deduplicate within splits.
    for task in ['colac', 'cola']:
        seen = set()
        for split in ['train', 'dev']:
            unique = []
            for row in public[task + '-' + split]:
                key = canonical(row['text'])
                if key in seen:
                    continue
                seen.add(key)
                unique.append(row)
            manifest[task + '-' + split + '-dropped'] = len(public[task + '-' + split]) - len(unique)
            public[task + '-' + split] = unique

    raw = github('cs', '11152019_two_entropies_appended_input_R_v4.csv').decode('utf-8-sig')
    groups, seen = collections.defaultdict(list), set()
    for row in csv.DictReader(io.StringIO(raw)):
        text = unsegment(row['original_sentence'])
        if not (re.search('[\u4e00-\u9fff]', text) and re.search('[A-Za-z]', text)):
            continue
        key = canonical(text)
        if key in seen:
            continue
        seen.add(key)
        # University/post ID keeps original-source groups together across splits.
        group = row['university'] + '/' + row['sent_id']
        bucket = int(hashlib.sha256(group.encode()).hexdigest()[:8], 16) % 10
        split = 'train' if bucket < 6 else 'cal' if bucket < 8 else 'test'
        groups[split].append({'text': text, 'label': 0, 'group': group})
    assert not ({r['group'] for r in groups['train']} & {r['group'] for r in groups['test']})
    assert not ({canonical(r['text']) for r in groups['train']} & {canonical(r['text']) for r in groups['test']})
    for split, rows in groups.items():
        public['cs-' + split] = rows

    # Separate acceptability and obvious-corruption probes. Grammar-invalid != noise.
    accepted = []
    extra_cal = []
    for name in ['colac', 'cola']:
        good = take([r for r in public[name + '-train'] if r['label'] == 1], 1100)
        accepted += [{'text': r['text'], 'label': 0} for r in good[:900]]
        extra_cal += [{'text': r['text'], 'label': 0} for r in good[900:]]
    normal_train = accepted + public['cs-train']
    public['noise-train'] = normal_train + [
        {'text': corrupt(r['text'], i)[0], 'label': 1, 'corruption': corrupt(r['text'], i)[1]}
        for i, r in enumerate(normal_train)
    ]
    # A shuffle can accidentally be the original sentence, especially for short
    # inputs. Such negatives contradict the positive source label and are removed.
    clean_keys = {canonical(r['text']) for r in normal_train}
    before = len(public['noise-train'])
    public['noise-train'] = [r for r in public['noise-train'] if r['label'] == 0 or canonical(r['text']) not in clean_keys]
    manifest['removed_unchanged_or_conflicting_training_negatives'] = before - len(public['noise-train'])
    train_labels = collections.defaultdict(set)
    for row in public['noise-train']:
        train_labels[canonical(row['text'])].add(row['label'])
    assert all(len(labels) == 1 for labels in train_labels.values()), 'Contradictory noise labels'
    public['noise-cal'] = extra_cal + public['cs-cal']
    public['synthetic-test'] = [
        {'text': corrupt(r['text'], 100000 + i)[0], 'label': 1,
         'corruption': corrupt(r['text'], 100000 + i)[1]}
        for i, r in enumerate(public['cs-test'])
    ]
    test_clean_keys = {canonical(r['text']) for r in public['cs-test']}
    public['synthetic-test'] = [r for r in public['synthetic-test'] if canonical(r['text']) not in test_clean_keys]
    fixture = json.loads((ROOT / 'data/mixed-semantic-screen.json').read_text(encoding='utf-8'))
    public['product-test'] = [{'category': c, 'label': y, 'text': t} for c, y, t in fixture['rows']]
    fit_texts = {canonical(r['text']) for r in public['noise-train']}
    assert not fit_texts & {canonical(r['text']) for r in public['product-test']}, 'Product holdout leaked'
    assert not fit_texts & {canonical(r['text']) for r in public['noise-cal']}, 'Calibration leaked'

    # A stratified, explicitly small SLING subset: 2 pairs per paradigm. These are
    # used ONLY as an auxiliary transfer probe, not the paper's PLL evaluation.
    tree = json.loads(fetch(f'https://api.github.com/repos/{GITHUB["sling"][0]}/git/trees/{GITHUB["sling"][1]}?recursive=1', 'sling-tree.json'))
    paths = sorted(x['path'] for x in tree['tree'] if x['path'].startswith('SLING_Data/') and x['path'].endswith('.jsonl'))
    sling = []
    def sling_file(path):
        rows = [json.loads(line) for line in github('sling', path).decode('utf-8-sig').splitlines() if line.strip()]
        return path, take(rows, 2)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for path, pairs in pool.map(sling_file, paths):
            for pair in pairs:
                # Source format follows BLiMP: sentence_good/sentence_bad.
                sling.append({'good': pair['sentence_good'], 'bad': pair['sentence_bad'], 'paradigm': path})
    public['sling-pairs'] = sling
    manifest['counts'] = {k: len(v) for k, v in public.items()}
    manifest['download_sha256'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (WORK / 'downloads').iterdir() if p.is_file()}
    write_json(WORK / 'prepared.json', public)
    write_json(WORK / 'manifest.json', manifest)
    print(json.dumps(manifest['counts']), flush=True)


def run(model_key):
    import numpy as np
    import torch
    import transformers
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.linear_model import LogisticRegression
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics import accuracy_score, matthews_corrcoef, roc_auc_score
    from transformers import AutoModel, AutoTokenizer

    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    torch.manual_seed(SEED)
    data = json.loads((WORK / 'prepared.json').read_text(encoding='utf-8'))
    result = {'model': model_key, 'seed': SEED, 'max_length': 96, 'cpu_threads': 4,
              'python': platform.python_version(), 'torch': torch.__version__, 'transformers': transformers.__version__,
              'protocol': 'frozen CLS+mean features; independent linear acceptability/noise probes; no encoder fine-tuning'}
    classifiers = {}
    if model_key != 'char-ngram':
        from huggingface_hub import snapshot_download
        multilingual = model_key == 'mminilm'
        name, revision = MULTILINGUAL if multilingual else MODELS[model_key]
        patterns = ['config.json', 'tokenizer_config.json', 'special_tokens_map.json', 'tokenizer.json', 'sentencepiece.bpe.model'] if multilingual else ['config.json', 'pytorch_model.bin', 'vocab.txt', 'tokenizer_config.json', 'special_tokens_map.json']
        if multilingual:
            patterns.append('onnx/model_int8.onnx')
        folder = snapshot_download(name, revision=revision, cache_dir=str(WORK / 'hf-cache'), allow_patterns=patterns)
        tokenizer = AutoTokenizer.from_pretrained(folder, use_fast=True, local_files_only=True, trust_remote_code=False)
        if multilingual:
            import onnxruntime as ort
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 4
            opts.inter_op_num_threads = 1
            encoder_path = pathlib.Path(folder, 'onnx/model_int8.onnx')
            encoder = ort.InferenceSession(str(encoder_path), opts, providers=['CPUExecutionProvider'])
            def multilingual_features(texts):
                # INT8 activations depend on the batch: fixed batch=1 reproduces
                # the actual composer path for BOTH fitting and evaluation.
                rows = []
                for text in texts:
                    inp = tokenizer(text, truncation=True, max_length=96, return_tensors='np')
                    feed = {v.name: inp[v.name].astype(np.int64) for v in encoder.get_inputs()}
                    outputs = encoder.run(None, feed)
                    hidden = next(v for v in outputs if v.ndim == 3)
                    mask = inp['attention_mask'][..., None]
                    mean = (hidden * mask).sum(1) / mask.sum(1)
                    rows.append(np.concatenate([hidden[:, 0], mean], 1)[0])
                return np.array(rows, dtype=np.float32)
            result.update(repo=name, revision=revision, parameters=117000000,
                source_weight_bytes=encoder_path.stat().st_size, encoder_already_int8=True)
        else:
            model = AutoModel.from_pretrained(folder, local_files_only=True, trust_remote_code=False, attn_implementation='eager')
            model.eval()
            result.update(repo=name, revision=revision, parameters=sum(p.numel() for p in model.parameters()),
                          source_weight_bytes=pathlib.Path(folder, 'pytorch_model.bin').stat().st_size)
        all_texts = sorted({r['text'] for k, rows in data.items() if k != 'sling-pairs' for r in rows}
                           | {r[v] for r in data['sling-pairs'] for v in ['good', 'bad']})
        cache_file = WORK / (model_key + '-features.npz')
        cache_key = [revision, all_texts, 96] + (['batch1'] if multilingual else [])
        cache_id = hashlib.sha256(json.dumps(cache_key, ensure_ascii=False).encode()).hexdigest()
        if cache_file.exists() and json.loads((WORK / (model_key + '-cache.json')).read_text())['id'] == cache_id:
            arr = np.load(cache_file)
            features = arr['features']
            result['unknown_token_fraction'] = float(arr['unknown'])
            result['truncated_inputs'] = int(arr['truncated'])
        else:
            vectors, unknown, token_count, truncated = [], 0, 0, 0
            start = time.perf_counter()
            with torch.inference_mode():
                for offset in range(0, len(all_texts), 64):
                    texts = all_texts[offset:offset + 64]
                    uncut = tokenizer(texts, truncation=False)['input_ids']
                    truncated += sum(len(ids) > 96 for ids in uncut)
                    inputs = tokenizer(texts, padding=True, truncation=True, max_length=96, return_tensors='pt')
                    if multilingual:
                        vectors.append(multilingual_features(texts))
                    else:
                        hidden = model(**inputs).last_hidden_state
                        mask = inputs['attention_mask'].unsqueeze(-1).to(hidden.dtype)
                        pooled = (hidden * mask).sum(1) / mask.sum(1)
                        vectors.append(torch.cat([hidden[:, 0], pooled], 1).numpy())
                    unknown += int((inputs['input_ids'] == tokenizer.unk_token_id).sum())
                    token_count += int(inputs['attention_mask'].sum())
                    if offset % 4096 == 0:
                        print(f'{model_key}: encoded {offset}/{len(all_texts)}', flush=True)
            features = np.concatenate(vectors)
            result['unknown_token_fraction'] = unknown / max(1, token_count)
            result['truncated_inputs'] = truncated
            result['feature_seconds'] = time.perf_counter() - start
            np.savez_compressed(cache_file, features=features, unknown=result['unknown_token_fraction'], truncated=truncated)
            write_json(WORK / (model_key + '-cache.json'), {'id': cache_id})
        positions = {text: i for i, text in enumerate(all_texts)}
        def transform(texts):
            return features[[positions[t] for t in texts]]
        def fit(rows, task):
            classifier = make_pipeline(StandardScaler(), LogisticRegression(C=1, max_iter=1000, random_state=SEED))
            classifier.fit(transform([r['text'] for r in rows]), [r['label'] for r in rows])
            classifiers[task] = classifier
            return lambda texts: classifier.predict_proba(transform(texts))[:, 1]
    else:
        def fit(rows, task):
            classifier = make_pipeline(TfidfVectorizer(analyzer='char', ngram_range=(2, 4), max_features=30000,
                sublinear_tf=True, dtype=np.float32), LogisticRegression(C=1, max_iter=1000, random_state=SEED))
            classifier.fit([r['text'] for r in rows], [r['label'] for r in rows])
            classifiers[task] = classifier
            return lambda texts: classifier.predict_proba(texts)[:, 1]

    grammar_rows = data['colac-train'] + data['cola-train']
    grammar = fit(grammar_rows, 'grammar')
    result['grammar'] = {}
    for task in ['colac-dev', 'cola-dev']:
        rows = data[task]
        y = np.array([r['label'] for r in rows])
        p = grammar([r['text'] for r in rows])
        result['grammar'][task] = {'n': len(y), 'mcc': float(matthews_corrcoef(y, p >= .5)),
                                   'accuracy': float(accuracy_score(y, p >= .5))}
    pairs = data['sling-pairs']
    good = grammar([r['good'] for r in pairs])
    bad = grammar([r['bad'] for r in pairs])
    result['grammar']['sling-transfer'] = {'pairs': len(pairs), 'paradigms': len({r['paradigm'] for r in pairs}),
                                         'pair_accuracy': float(np.mean(good > bad)),
                                         'note': 'Linear CoLAC+CoLA probe ranking, NOT the official MLM/PLL metric'}
    noise = fit(data['noise-train'], 'noise')
    cal_scores = noise([r['text'] for r in data['noise-cal']])
    threshold = float(np.quantile(cal_scores, .99, method='higher'))
    result['noise_threshold'] = threshold
    result['calibration'] = {'n': len(cal_scores), 'false_positive_rate': float(np.mean(cal_scores > threshold)),
                              'selection': '99th percentile of clean CAL only; strict >; product holdout untouched'}
    result['noise'] = {}
    for task in ['cs-test', 'synthetic-test', 'product-test']:
        rows = data[task]
        scores = noise([r['text'] for r in rows])
        labels = np.array([r['label'] for r in rows])
        predictions = scores > threshold
        metrics = {'n': len(rows)}
        for label, metric in [(0, 'false_positive_rate'), (1, 'recall'), (-1, 'uncertain_warning_rate')]:
            mask = labels == label
            if mask.any():
                metrics[metric] = float(np.mean(predictions[mask]))
                metrics[metric + '_count'] = [int(predictions[mask].sum()), int(mask.sum())]
        if len(set(labels[labels >= 0])) == 2:
            mask = labels >= 0
            metrics['auroc'] = float(roc_auc_score(labels[mask], scores[mask]))
        result['noise'][task] = metrics
        if task == 'product-test':
            result['product_predictions'] = [dict(r, score=float(score), warning=bool(pred)) for r, score, pred in zip(rows, scores, predictions)]
    clean_scores = noise([r['text'] for r in data['cs-test']])
    broken_scores = noise([r['text'] for r in data['synthetic-test']])
    result['noise']['synthetic_pair_auroc'] = float(roc_auc_score(
        [0] * len(clean_scores) + [1] * len(broken_scores), np.concatenate([clean_scores, broken_scores])))

    def summarize_noise(rows, scores, cutoff):
        y = np.array([r['label'] for r in rows])
        predictions = np.array(scores) > cutoff
        metrics = {'n': len(rows)}
        for label, name in [(0, 'false_positive_rate'), (1, 'recall'), (-1, 'uncertain_warning_rate')]:
            selected = y == label
            if selected.any():
                metrics[name] = float(np.mean(predictions[selected]))
                metrics[name + '_count'] = [int(predictions[selected].sum()), int(selected.sum())]
        selected = y >= 0
        if len(set(y[selected])) == 2:
            metrics['auroc'] = float(roc_auc_score(y[selected], np.array(scores)[selected]))
        return metrics

    if model_key not in ['char-ngram', 'mminilm']:
        # Export the exact fitted probes and quantize. Embeddings may remain FP32:
        # do not estimate artifact size by assuming every parameter becomes INT8.
        class Probes(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.encoder = model
                for task, classifier in classifiers.items():
                    scale, head = classifier.steps[0][1], classifier.steps[1][1]
                    self.register_buffer(task + '_mean', torch.tensor(scale.mean_, dtype=torch.float32))
                    self.register_buffer(task + '_scale', torch.tensor(scale.scale_, dtype=torch.float32))
                    self.register_buffer(task + '_coef', torch.tensor(head.coef_, dtype=torch.float32))
                    self.register_buffer(task + '_bias', torch.tensor(head.intercept_, dtype=torch.float32))
            def forward(self, input_ids, attention_mask, token_type_ids):
                hidden = self.encoder(input_ids=input_ids, attention_mask=attention_mask, token_type_ids=token_type_ids).last_hidden_state
                mask = attention_mask.unsqueeze(-1).to(hidden.dtype)
                mean = (hidden * mask).sum(1) / mask.sum(1)
                x = torch.cat([hidden[:, 0], mean], 1)
                values = []
                for task in ['grammar', 'noise']:
                    normalized = (x - getattr(self, task + '_mean')) / getattr(self, task + '_scale')
                    values.append(torch.sigmoid(normalized @ getattr(self, task + '_coef').T + getattr(self, task + '_bias')))
                return torch.cat(values, 1)
        import onnxruntime as ort
        from onnxruntime.quantization import quantize_dynamic, QuantType
        wrapper = Probes().eval()
        sample = tokenizer('这个 API 请求需要重试。', return_tensors='pt')
        args = tuple(sample[name] for name in ['input_ids', 'attention_mask', 'token_type_ids'])
        full = WORK / (model_key + '-probes.onnx')
        small = WORK / (model_key + '-probes-int8.onnx')
        torch.onnx.export(wrapper, args, str(full), input_names=['input_ids', 'attention_mask', 'token_type_ids'],
            output_names=['scores'], dynamic_axes={name: {0: 'batch', 1: 'sequence'} for name in ['input_ids', 'attention_mask', 'token_type_ids']}
            | {'scores': {0: 'batch'}}, opset_version=17, dynamo=False)
        quantize_dynamic(str(full), str(small), weight_type=QuantType.QInt8)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(str(small), options, providers=['CPUExecutionProvider'])
        full_session = ort.InferenceSession(str(full), options, providers=['CPUExecutionProvider'])
        def ort_scores(rows, target_session=session):
            output = []
            for row in rows:
                inputs = tokenizer(row['text'], truncation=True, max_length=96, return_tensors='np')
                feed = {v.name: inputs[v.name].astype(np.int64) for v in target_session.get_inputs()}
                output.append(target_session.run(None, feed)[0][0])
            return np.array(output)
        full_scores = ort_scores(data['product-test'], full_session)
        full_drift = float(np.max(np.abs(full_scores[:, 1] - np.array([r['score'] for r in result['product_predictions']]))))
        assert full_drift < .001, f'FP32 export or batching mismatch: {full_drift}'
        quant_cal = ort_scores(data['noise-cal'])[:, 1]
        quant_threshold = float(np.quantile(quant_cal, .99, method='higher'))
        result['quantized_threshold'] = quant_threshold
        result['quantized_noise'] = {}
        for task in ['cs-test', 'synthetic-test', 'product-test']:
            qs = ort_scores(data[task])[:, 1]
            result['quantized_noise'][task] = summarize_noise(data[task], qs, quant_threshold)
            if task == 'product-test':
                result['quantized_product_predictions'] = [dict(row, score=float(p), warning=bool(p > quant_threshold)) for row, p in zip(data[task], qs)]
        scores, elapsed = [], []
        for i, row in enumerate(data['product-test'] * 2):
            started = time.perf_counter()
            inputs = tokenizer(row['text'], truncation=True, max_length=96, return_tensors='np')
            feed = {v.name: inputs[v.name].astype(np.int64) for v in session.get_inputs()}
            scored = session.run(None, feed)[0][0]
            if i >= len(data['product-test']):
                elapsed.append((time.perf_counter() - started) * 1000)
                scores.append(scored[1])
        fp32 = np.array([r['score'] for r in result['product_predictions']])
        result['export'] = {'fp32_bytes': full.stat().st_size, 'int8_bytes': small.stat().st_size,
             'quantized_sha256': hashlib.sha256(small.read_bytes()).hexdigest(),
             'max_noise_probability_drift': float(np.max(np.abs(np.array(scores) - fp32))),
             'fp32_ort_max_drift': full_drift,
             'product_decision_changes': int(np.sum((np.array(scores) > threshold) != (fp32 > threshold))),
             'latency_p50_ms': float(np.median(elapsed)), 'latency_p95_ms': float(np.percentile(elapsed, 95)),
             'latency_note': 'warm batch=1, tokenization+ORT+heads; 4 CPU threads; short exploratory fixture only'}
    elif model_key == 'mminilm':
        # The feature encoder is already INT8. Retain sklearn's two small heads
        # for this screen, rather than download the 470 MB FP32 checkpoint.
        import joblib
        artifact = WORK / 'mminilm-probes.joblib'
        joblib.dump(classifiers, artifact, compress=3)
        result['quantized_threshold'] = threshold
        result['quantized_noise'] = result['noise']
        result['quantized_product_predictions'] = result['product_predictions']
        elapsed = []
        for row in data['product-test']:
            t = time.perf_counter()
            x = multilingual_features([row['text']])
            classifiers['noise'].predict_proba(x)
            elapsed.append((time.perf_counter() - t) * 1000)
        result['export'] = {'int8_bytes': encoder_path.stat().st_size, 'head_bytes': artifact.stat().st_size,
             'tokenizer_bytes': pathlib.Path(folder, 'tokenizer.json').stat().st_size,
             'latency_p50_ms': float(np.median(elapsed)), 'latency_p95_ms': float(np.percentile(elapsed, 95)),
             'note': 'published INT8 encoder + fitted heads; no FP32-to-INT8 accuracy comparison performed'}
    else:
        import joblib
        artifact = WORK / 'char-ngram-probes.joblib'
        joblib.dump(classifiers, artifact, compress=3)
        result['export'] = {'bytes': artifact.stat().st_size}
    if model_key == 'electra-small':
        # Test the pretrained replacement-detection head separately, without
        # downstream training. Top-quarter mean logits is fixed before inspection.
        from transformers import AutoModelForPreTraining
        discriminator = AutoModelForPreTraining.from_pretrained(folder, local_files_only=True, trust_remote_code=False).eval()
        def replaced_scores(rows):
            out = []
            with torch.inference_mode():
                for row in rows:
                    inp = tokenizer(row['text'], max_length=96, truncation=True, return_tensors='pt')
                    values = discriminator(**inp).logits[0, 1:-1]
                    n = max(1, (values.numel() + 3) // 4)
                    out.append(float(torch.topk(values, min(n, values.numel())).values.mean()))
            return np.array(out)
        cut = float(np.quantile(replaced_scores(data['noise-cal']), .99, method='higher'))
        result['pretrained_replacement_detection'] = {'threshold': cut}
        for task in ['cs-test', 'synthetic-test', 'product-test']:
            result['pretrained_replacement_detection'][task] = summarize_noise(data[task], replaced_scores(data[task]), cut)
    write_json(WORK / (model_key + '-result.json'), result)
    print(json.dumps({k: v for k, v in result.items() if not k.endswith('predictions')}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'run'])
    parser.add_argument('--model', choices=[*MODELS, 'mminilm', 'char-ngram'], default='minirbt')
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare()
    else:
        run(args.model)
