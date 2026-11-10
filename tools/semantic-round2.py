"""Domain-data continuation of SIM-1034. Local research, no plugin changes.

prepare: build/lock source-separated data before fitting.
train: three-way ELECTRA, 3 fixed epochs; select using CAL only via Node INT8.
evaluate: open the new test only after selection is written; compare round 1.
Public conversation quality labels and issue titles are silver normal labels,
not a human-verified semantic-error corpus. Authored cases are assistant labels.
"""
from __future__ import annotations

import argparse
import collections
import concurrent.futures
import gzip
import hashlib
import importlib.util
import json
import math
import pathlib
import random
import re
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORK = ROOT / '.research/semantic-round2'
OLD = ROOT / '.research/semantic-screen'
SEED = 20261110
REV = '826a243f3f387450ef8d70de9c3d0706d8d8e924'
OASST_REV = 'fdf72ae0827c1cda404aff25b6603abec9e3399b'
REPOS = {
    'train': ['element-plus/element-plus', 'ant-design/ant-design'],
    'cal': ['Tencent/tdesign-vue-next', 'vitejs/vite'],
    'test': ['Tencent/tdesign-miniprogram', 'microsoft/vscode'],
}


def save(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def canonical(text):
    return re.sub(r'\s+', ' ', text).strip()


def downloaded(url, filename):
    dest = WORK / filename
    if not dest.exists():
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'dsh-semantic-research'}), timeout=90) as r:
            dest.write_bytes(r.read())
    return dest


def record(text, label, category, source, group, weight=1.):
    return dict(text=text.strip(), label=label, category=category, source=source, group=group, weight=weight)


def augment(train):
    """Training-only normal contexts, code, and context-dependent phrases."""
    result = []
    bad = [r['text'] for r in train if r['label'] == 1 and len(r['text']) < 85]
    wrappers = [
        '用于测试的原始字符串是「{}」，请原样显示。',
        '请分析这条异常输入：\"{}\"。',
        '日志中的内容为 `{}`，这里是在引用日志。',
        '我把随机文本 {} 作为压力测试材料。',
        'The test fixture contains the literal string "{}".',
        'Please classify this quoted input without editing it: "{}".',
        '{{"sample_text": "{}", "purpose": "input testing"}}',
        '用户粘贴了“{}”，我想排查为什么会产生这些字。',
    ]
    for i, body in enumerate(bad[:160]):
        wrapper = wrappers[i % len(wrappers)]
        safe_body = body.replace('"', '').replace('\n', ' ')
        result.append(record(wrapper.format(safe_body), 0, 'quoted-data', 'training-only-augmentation', f'quote-wrapper-{i % 8}'))
    for i in range(40):
        examples = [
            f'const item_{i} = response.items?.[{i % 5}] ?? null;',
            f"payload_{i} = {{'key': 'zqx_{i}', 'count': {i}}}",
            f"SELECT id FROM tasks_{i} WHERE retries < {i + 2} ORDER BY id;",
            f'curl --retry {i % 4 + 1} https://api.example.org/v{i % 5 + 1}/ping',
            f'请求 172.16.{i % 20}.{i + 1}:{8000+i} 后，返回码是 200。',
            f'把 cache-utils 升到 2.{i}.0-preview.{i % 7} 后重新构建。',
            f'这个 trace_id 是 pxw_{i:04d}，不是一句话。',
            f'Profile {i} uses HTTP/3 and a {i + 10}s timeout.',
        ]
        for j, text in enumerate(examples):
            result.append(record(text, 0, 'technical-augmentation', 'training-only-augmentation', f'tech-template-{j}'))
    for prefix in ['刚才的', '前面提到的', '对方说的', '上次用过的', '左侧的', '之前确认的']:
        for noun in ['那个版本', '那两项', '那个 case', '那条记录', '那一份', '那个选项']:
            for suffix in ['先留着。', '怎么处理？', '等一会再说。', '按原来的来。']:
                result.append(record(prefix + noun + suffix, 2, 'context-reference', 'training-only-augmentation', 'reference-template'))
    return result


def prepare():
    WORK.mkdir(parents=True, exist_ok=True)
    old = json.loads((OLD / 'prepared.json').read_text(encoding='utf-8'))
    seeds = json.loads((ROOT / 'data/mixed-semantic-round2-seeds.json').read_text(encoding='utf-8'))
    splits = {s: [] for s in ['train', 'cal', 'test']}
    for s in splits:
        for category, label in [('normal', 0), ('noise', 1), ('context', 2)]:
            for i, text in enumerate(seeds[s][category]):
                splits[s].append(record(text, label, 'authored-' + category, 'assistant-authored', f'authored-{s}-{category}-{i}'))

    # Preserve normal monolingual/natural code-switch examples. Downsample the
    # old synthetic noise, rather than letting keyboard/space artifacts dominate.
    normal = [r for r in old['noise-train'] if r['label'] == 0]
    noise = [r for r in old['noise-train'] if r['label'] == 1]
    random.Random(SEED).shuffle(noise)
    for i, row in enumerate(normal + noise[:1200]):
        splits['train'].append(record(row['text'], row['label'], 'legacy-source' if row['label'] == 0 else 'weak-corruption', 'round1-training-only', f'legacy-{i}', .7 if row['label'] else 1.))
    for i, row in enumerate(old['noise-cal']):
        splits['cal'].append(record(row['text'], 0, 'legacy-cal-normal', 'round1-cal-only', f'oldcal-{i}'))

    archive = downloaded(f'https://huggingface.co/datasets/OpenAssistant/oasst1/resolve/{OASST_REV}/2023-04-12_oasst_ready.messages.jsonl.gz', 'oasst-ready.messages.jsonl.gz')
    oa = collections.defaultdict(list)
    with gzip.open(archive, 'rt', encoding='utf-8') as f:
        for line in f:
            row = json.loads(line)
            if row.get('role') != 'prompter' or row.get('lang') not in ['zh', 'en'] or row.get('deleted') or row.get('synthetic'):
                continue
            lab = row.get('labels') or {}
            value = lambda k, default: lab.get(k, {}).get('value', default)
            if value('quality', 0) < .66 or value('spam', 1) != 0 or value('pii', 1) != 0 or value('lang_mismatch', 1) != 0:
                continue
            text = row['text'].strip()
            if not 12 <= len(text) <= 160:
                continue
            bucket = int(digest(row['message_tree_id'])[:8], 16) % 10
            split = 'train' if bucket < 6 else 'cal' if bucket < 8 else 'test'
            oa[(split, row['lang'])].append(record(text, 0, 'public-conversation', f'OpenAssistant/oasst1@{OASST_REV}', 'oasst-' + row['message_tree_id'], .8))
    for split in splits:
        for lang in ['zh', 'en']:
            pool = sorted(oa[(split, lang)], key=lambda r: digest(r['text']))
            limit = {'train': 600, 'cal': 60, 'test': 100}[split]
            splits[split].extend(pool[:limit])

    def repo_rows(repo):
        rows = []
        for page in [1, 2]:
            name = repo.replace('/', '--') + '-issues-' + str(page) + '.json'
            filename = downloaded(f'https://api.github.com/repos/{repo}/issues?state=closed&per_page=100&page={page}', name)
            for item in json.loads(filename.read_text(encoding='utf-8')):
                title = item['title'].strip()
                if not 14 <= len(title) <= 170 or len(re.findall('[A-Za-z\u4e00-\u9fff]', title)) < 10:
                    continue
                rows.append(record(title, 0, 'public-technical-title', item['html_url'], 'repo-' + repo, .8))
        return repo, rows
    repos = [r for v in REPOS.values() for r in v]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        by_repo = dict(pool.map(repo_rows, repos))
    for split, repos in REPOS.items():
        for repo in repos:
            unique = {canonical(r['text']): r for r in by_repo[repo]}
            rows = sorted(unique.values(), key=lambda r: digest(r['text']))
            splits[split].extend(rows[:{'train': 160, 'cal': 70, 'test': 90}[split]])
    splits['train'].extend(augment(splits['train']))
    # Never turn a clipped quote/code example into a false normal/noise label.
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(str(OLD / 'hf-cache/models--hfl--chinese-electra-180g-small-discriminator/snapshots' / REV), local_files_only=True)
    too_long = {}
    for split in splits:
        before = len(splits[split])
        splits[split] = [r for r in splits[split] if len(tokenizer(r['text'])['input_ids']) <= 128]
        too_long[split] = before - len(splits[split])

    # The previous fixture is already known. Keep it out of all fitting/new-test
    # splits, and call it a regression/development set rather than a blind test.
    regression = [dict(r, label=2 if r['label'] == -1 else r['label']) for r in old['product-test']]
    forbidden = {canonical(r['text']) for r in regression}
    seen, removed = set(forbidden), collections.Counter()
    # Hold the test stable; remove exact normalized overlap from CAL and TRAIN.
    for split in ['test', 'cal', 'train']:
        kept = []
        for row in splits[split]:
            key = canonical(row['text'])
            if key in seen:
                removed[split] += 1
                continue
            seen.add(key)
            kept.append(row)
        splits[split] = kept
    labels = collections.defaultdict(set)
    for row in splits['train']:
        labels[canonical(row['text'])].add(row['label'])
    assert all(len(v) == 1 for v in labels.values())
    for a, b in [('train', 'cal'), ('train', 'test'), ('cal', 'test')]:
        assert not {canonical(r['text']) for r in splits[a]} & {canonical(r['text']) for r in splits[b]}
        assert not {r['group'] for r in splits[a] if r['group'].startswith(('oasst-', 'repo-'))} & {r['group'] for r in splits[b] if r['group'].startswith(('oasst-', 'repo-'))}
    splits['regression'] = regression
    manifest = {
        'seed': SEED, 'labels': {'0': 'comprehensible_or_intentional_data', '1': 'obvious_corruption', '2': 'context_needed'},
        'source_repositories': REPOS, 'oasst_revision': OASST_REV, 'removed_exact_overlaps': dict(removed),
        'excluded_over_128_tokens': too_long,
        'label_caveat': 'Public text uses silver normal labels; authored cases are assistant-labelled, not independent human gold.',
        'counts': {s: dict(collections.Counter(r['label'] for r in rows)) for s, rows in splits.items()},
        'categories': {s: dict(collections.Counter(r.get('category', 'regression') for r in rows)) for s, rows in splits.items()},
        'split_hashes': {s: digest(json.dumps(rows, ensure_ascii=False, sort_keys=True)) for s, rows in splits.items()},
        'public_snapshot_sha256': {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in WORK.glob('*issues-*.json')},
        'protocol': 'Test locked before training. Repo-separated technical titles; tree-separated conversations; authored split-specific cases. Legacy 70 are regression only. No test-driven parameter changes.',
    }
    if (WORK / 'selection.json').exists():
        raise RuntimeError('A model was already selected; create a new round instead of rewriting its held-out test.')
    save(WORK / 'prepared.json', splits)
    save(WORK / 'manifest.json', manifest)
    print(json.dumps(manifest['counts']), flush=True)


def node_scores(model_file, rows, output_name):
    """Native runtime is the single scoring path for CAL and final evaluation."""
    import numpy as np
    from transformers import AutoTokenizer
    folder = OLD / 'hf-cache/models--hfl--chinese-electra-180g-small-discriminator/snapshots' / REV
    tokenizer = AutoTokenizer.from_pretrained(str(folder), local_files_only=True, trust_remote_code=False)
    payload = []
    truncated = 0
    for row in rows:
        full = tokenizer(row['text'])
        truncated += len(full['input_ids']) > 128
        payload.append(dict(inputs=dict(tokenizer(row['text'], truncation=True, max_length=128))))
    inputs = WORK / (output_name + '-inputs.json')
    outputs = WORK / (output_name + '-scores.json')
    save(inputs, payload)
    subprocess.run(['node', str(ROOT / 'tools/semantic-round2-native.mjs'), str(model_file), str(inputs), str(outputs)], cwd=ROOT, check=True)
    values = json.loads(outputs.read_text(encoding='utf-8'))
    return np.array(values['margins']), values, truncated


def operating_point(rows, scores):
    import numpy as np
    # One decision threshold. CAL-only: <=1% overall normal FP, <=2.5% in each
    # normal source stratum, zero observed CAL context warnings; positive margin.
    clean = [(r, s) for r, s in zip(rows, scores) if r['label'] == 0]
    context = [s for r, s in zip(rows, scores) if r['label'] == 2]
    limits = [0., float(np.quantile([s for r, s in clean], .99, method='higher'))]
    for category in {r['category'] for r, s in clean}:
        vals = [s for r, s in clean if r['category'] == category]
        limits.append(float(np.quantile(vals, .975, method='higher')))
    if context:
        limits.append(float(max(context)))
    return max(limits)


def metrics(rows, scores, threshold):
    import numpy as np
    from sklearn.metrics import roc_auc_score
    y = np.array([r['label'] for r in rows])
    flags = scores > threshold
    result = {'n': len(rows), 'threshold': float(threshold), 'categories': {}}
    for label, key in [(0, 'normal_false_positives'), (1, 'noise_detected'), (2, 'context_warnings')]:
        mask = y == label
        result[key] = [int(flags[mask].sum()), int(mask.sum())]
    mask = y != 2
    if len(set(y[mask])) == 2:
        result['auroc'] = float(roc_auc_score(y[mask], scores[mask]))
    for category in sorted({r.get('category', 'regression') for r in rows}):
        mask = np.array([r.get('category', 'regression') == category for r in rows])
        result['categories'][category] = [int(flags[mask].sum()), int(mask.sum())]
    return result


def train():
    import copy
    import numpy as np
    import torch
    import onnxruntime as ort
    from onnxruntime.quantization import quantize_dynamic, QuantType
    from transformers import AutoModel, AutoTokenizer, get_linear_schedule_with_warmup
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    torch.manual_seed(SEED)
    random.seed(SEED)
    data = json.loads((WORK / 'prepared.json').read_text(encoding='utf-8'))
    manifest = json.loads((WORK / 'manifest.json').read_text(encoding='utf-8'))
    assert manifest['split_hashes']['test'] == digest(json.dumps(data['test'], ensure_ascii=False, sort_keys=True))
    if (WORK / 'selection.json').exists():
        raise RuntimeError('Selection already exists; do not retune against an opened test.')
    folder = OLD / 'hf-cache/models--hfl--chinese-electra-180g-small-discriminator/snapshots' / REV
    tokenizer = AutoTokenizer.from_pretrained(str(folder), local_files_only=True, trust_remote_code=False)
    class ThreeWay(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.encoder = AutoModel.from_pretrained(str(folder), local_files_only=True, trust_remote_code=False, attn_implementation='eager')
            self.drop = torch.nn.Dropout(.1)
            self.head = torch.nn.Linear(self.encoder.config.hidden_size * 2, 3)
        def forward(self, input_ids, attention_mask, token_type_ids):
            h = self.encoder(input_ids=input_ids, attention_mask=attention_mask, token_type_ids=token_type_ids).last_hidden_state
            mask = attention_mask.unsqueeze(-1).to(h.dtype)
            v = torch.cat([h[:, 0], (h * mask).sum(1) / mask.sum(1)], 1)
            return self.head(self.drop(v))
    model = ThreeWay()
    rows = data['train']
    inputs = tokenizer([r['text'] for r in rows], padding=True, truncation=True, max_length=128, return_tensors='pt')
    labels = torch.tensor([r['label'] for r in rows])
    weights = torch.tensor([r['weight'] for r in rows])
    optimizer = torch.optim.AdamW(model.parameters(), lr=8e-5, weight_decay=.01)
    steps = math.ceil(len(rows)/32)*3
    scheduler = get_linear_schedule_with_warmup(optimizer, steps//10, steps)
    history = []
    started = time.perf_counter()
    sample = tokenizer('请检查这个 WebSocket 的 close code。', return_tensors='pt')
    for epoch in range(3):
        model.train()
        buckets = list(torch.argsort(inputs['attention_mask'].sum(1)).split(32))
        losses = []
        for step, b in enumerate(torch.randperm(len(buckets))):
            ids = buckets[int(b)]
            width = int(inputs['attention_mask'][ids].sum(1).max())
            inp = {k: v[ids, :width] for k, v in inputs.items()}
            optimizer.zero_grad(set_to_none=True)
            output = model(**inp)
            # Normal and context errors are more expensive than missed warnings.
            loss = torch.nn.functional.cross_entropy(output, labels[ids], reduction='none', weight=torch.tensor([1.5, 1., 1.5]))
            loss = (loss * weights[ids]).mean()
            assert torch.isfinite(loss)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.)
            optimizer.step()
            scheduler.step()
            losses.append(float(loss.detach()))
            if step % 60 == 0:
                print(f'epoch {epoch+1} batch {step}/{len(buckets)}', flush=True)
        model.eval()
        full = WORK / f'epoch-{epoch+1}.onnx'
        small = WORK / f'epoch-{epoch+1}-int8.onnx'
        names = ['input_ids', 'attention_mask', 'token_type_ids']
        torch.onnx.export(model, tuple(sample[n] for n in names), str(full), input_names=names, output_names=['logits'],
            dynamic_axes={n:{0:'batch',1:'sequence'} for n in names}|{'logits':{0:'batch'}}, opset_version=17, dynamo=False)
        # Check float export on CAL only, before quantization or test inspection.
        opt = ort.SessionOptions(); opt.intra_op_num_threads=4; opt.inter_op_num_threads=1
        session = ort.InferenceSession(str(full), opt, providers=['CPUExecutionProvider'])
        drift = 0.
        with torch.inference_mode():
            for row in data['cal'][:12]:
                inp = tokenizer(row['text'], truncation=True, max_length=128, return_tensors='pt')
                expected = model(**inp).numpy()
                actual = session.run(None, {n:inp[n].numpy() for n in names})[0]
                drift = max(drift, float(np.abs(expected-actual).max()))
        assert drift < .001, f'FP32 export mismatch {drift}'
        quantize_dynamic(str(full), str(small), weight_type=QuantType.QInt8)
        scores, native, truncated = node_scores(small, data['cal'], f'epoch-{epoch+1}-cal')
        cutoff = operating_point(data['cal'], scores)
        measured = metrics(data['cal'], scores, cutoff)
        row = {'epoch':epoch+1,'loss':float(np.mean(losses)),'cal':measured,'cal_truncated':truncated,
               'fp32_export_max_drift':drift,'artifact':small.name,'artifact_bytes':small.stat().st_size,
               'native_version':native['native_version']}
        history.append(row)
        print(json.dumps(row), flush=True)
    # CAL recall first, then normal FP, then earlier epoch. No new-test scores.
    chosen = max(history, key=lambda h:(h['cal']['noise_detected'][0],-h['cal']['normal_false_positives'][0],-h['epoch']))
    selection = {'selected':chosen,'history':history,'train_seconds':time.perf_counter()-started,
        'seed':SEED,'test_sha256_before_selection':manifest['split_hashes']['test'],
        'protocol':'Three classes, fixed 3 epochs. Select native INT8 epoch by CAL recall under fixed specificity/context constraints. No test-driven tuning.',
        'checkpoint_sha256':hashlib.sha256((WORK/chosen['artifact']).read_bytes()).hexdigest()}
    save(WORK/'selection.json',selection)


def evaluate():
    import numpy as np
    data = json.loads((WORK/'prepared.json').read_text(encoding='utf-8'))
    selection = json.loads((WORK/'selection.json').read_text(encoding='utf-8'))
    assert selection['test_sha256_before_selection'] == digest(json.dumps(data['test'],ensure_ascii=False,sort_keys=True))
    target = WORK/'results.json'
    if target.exists():
        raise RuntimeError('Test already opened; retain its result rather than retune.')
    chosen = selection['selected']
    configurations = {
        'round1-original-threshold':(OLD/'electra-small-finetuned-int8.onnx',json.loads((OLD/'native-runtime-check.json').read_text())['nativeThreshold']),
        'round1-recalibrated':(OLD/'electra-small-finetuned-int8.onnx',None),
        'round2-three-way':(WORK/chosen['artifact'],chosen['cal']['threshold']),
    }
    result = {'selection':selection,'configurations':{},'label_caveat':'Silver public normal text plus assistant-authored stress cases; no independent human adjudication.'}
    for key,(model_file,cutoff) in configurations.items():
        if cutoff is None:
            values,_,_=node_scores(model_file,data['cal'],key+'-cal')
            cutoff=operating_point(data['cal'],values)
        output={'threshold':cutoff}
        for split in ['test','regression']:
            scores,native,truncated=node_scores(model_file,data[split],key+'-'+split)
            output[split]=metrics(data[split],scores,cutoff)
            output[split+'_truncated']=truncated
            output[split+'_predictions']=[{'index':i,'label':r['label'],'margin':float(s),'warning':bool(s>cutoff)} for i,(r,s) in enumerate(zip(data[split],scores))]
            output['latency_p50_ms']=native['latency_p50_ms']
            output['latency_p95_ms']=native['latency_p95_ms']
        result['configurations'][key]=output
        print(json.dumps({key:{k:v for k,v in output.items() if not k.endswith('predictions')}}),flush=True)
    save(target,result)


if __name__=='__main__':
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('command',choices=['prepare','train','evaluate'])
    command=p.parse_args().command
    {'prepare':prepare,'train':train,'evaluate':evaluate}[command]()
