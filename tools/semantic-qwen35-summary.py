"""Summarize frozen Qwen known-regression runs without changing their raw artifacts."""
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.research/semantic-qwen35'
EXTRA = ROOT / '.research/semantic-qwen35-dash'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def aggregate(splits):
    result = {}
    for key in ['normal_false_positives', 'noise_detected', 'context_warnings']:
        result[key] = [sum(split['metrics'][key][i] for split in splits.values()) for i in [0, 1]]
    result['noise_languages'] = {lang: [sum(split['metrics']['noise_languages'][lang][i]
        for split in splits.values()) for i in [0, 1]] for lang in ['zh', 'en', 'mixed']}
    return result


def ratio(pair):
    return f'{pair[0]}/{pair[1]}（{pair[0] / pair[1] * 100:.1f}%）' if pair[1] else '0/0'


def main():
    base = read(WORK / 'results.json')
    extra = read(EXTRA / 'results.json')
    rows = read(WORK / 'prepared.json')
    package = read(WORK / 'package-result.json')
    configurations = dict(base['configurations'], **extra['configurations'])
    assert len(configurations) == 8
    summary = {}
    for name, run in configurations.items():
        records = [pred for split in run['splits'].values() for pred in split['predictions']]
        assert len(records) == 675 and all(pred['code'] in [0, 1, 2] for pred in records)
        confusion = [[0] * 3 for _ in range(3)]
        for split, data in rows.items():
            for row, pred in zip(data, run['splits'][split]['predictions']):
                confusion[row['label']][pred['code']] += 1
        summary[name] = {
            'aggregate': aggregate(run['splits']), 'splits': {s: v['metrics'] for s, v in run['splits'].items()},
            'latency_wall_ms': run['latency_wall_ms'], 'memory_peak_observed': run['memory_peak_observed'],
            'load_to_health_seconds': [s['load_to_health_seconds'] for s in run['server_runs']],
            'original_code': run['original']['code'], 'model_sha256': run['model_sha256'],
            'model_bytes': next(f['bytes'] for f in (base if run['tag'] != 'q2dash' else extra)['downloads']['files']
                                if f['name'] == run['tag']),
            'ternary_confusion_true_rows_pred_cols': confusion,
            'ternary_accuracy': sum(confusion[i][i] for i in range(3)) / 675,
            'decisions': dict(Counter(p['code'] for p in records)),
            'multi_token_label_count': sum(p['timings']['predicted_n'] > 1 for p in records),
        }
    reference = base['r13_reference']
    summary['r13-cpu'] = {'aggregate': aggregate(reference['splits']),
        'splits': {s: v['metrics'] for s, v in reference['splits'].items()},
        'latency_wall_ms': reference['latency_wall_ms'], 'model_and_vocab_bytes': 27_433_631,
        'native_version': reference['native_version'],
        'memory_caveat': 'Excluded: recorded parent PID was the Volta launcher, not actual Node worker.',
        'warning_parity_all675': reference['warning_parity_all675']}
    provenance = {str(path.relative_to(ROOT)).replace('\\', '/'): sha(path) for path in [
        WORK / 'results.json', EXTRA / 'results.json', WORK / 'prepared.json',
        WORK / 'calibration-selection.json', WORK / 'completion-policy.json',
        WORK / 'completion-v2-validation.json', WORK / 'package-result.json', WORK / 'package-smoke.json',
        WORK / 'r13-python-ort123-diagnostics.json', ROOT / 'tools/semantic-qwen35-reference.mjs']}
    result = {'completed_at_utc': datetime.now(timezone.utc).isoformat(), 'issue': 'SIM-1049',
        'data_role': 'All675 known regression; assistant labels, not independent human gold or new holdout.',
        'dataset_counts': dict(Counter(row['label'] for data in rows.values() for row in data)),
        'configurations': summary, 'package': package, 'package_smoke': read(WORK / 'package-smoke.json'),
        'source_sha256': provenance,
        'comparison_caveat': 'R13 is task-finetuned; Qwen uses frozen3-shot prompting without finetuning. No unquantized Qwen control.'}
    (ROOT / 'data/semantic-qwen35-comparison.json').write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    ref = summary['r13-cpu']['aggregate']
    best_noise = max(run['aggregate']['noise_detected'][0] for name, run in summary.items() if name != 'r13-cpu')
    conclusion = (f'本轮 Qwen 最高检出 {best_noise}/104，低于现有 R13 的 {ref["noise_detected"][0]}/104。'
                  if best_noise < ref['noise_detected'][0] else
                  'Qwen 与 R13 有检出和误报方面的取舍，应依据下表逐项比较。')
    lines = [
        '# Qwen3.5-0.8B：600 MB 内直接分类实测', '',
        f'2026-11-10，SIM-1049。{conclusion}这轮结果不支持直接替换插件的检查模型。', '',
        '已实测 4 种量化文件、每种 CPU/Vulkan 两个后端，共 8×675 条完整输出。'
        '4bit CPU 可运行包包含模型、必要原生运行库、配置和入口，解包后 '
        f'{package["unpacked_bytes"]:,} 字节（{package["unpacked_bytes"] / 1e6:.2f} MB），小于 '
        '600,000,000 字节。现有 Node.js 是宿主前提，不在包内；600 MB 是磁盘预算，运行内存另算。', '',
        '## 同一批输入的结果', '',
        '只将“异常”作为提示；“正常”和“待定”均不提示。上下文样本不应强行判异常，单独列出。'
        '分母分别为 104 条异常、301 条正常、270 条上下文不足。', '',
        '| 模型 / 后端 | 权重或模型+词表 MB | 异常检出 | 正常误报 | 上下文提示 | 延迟 p50 / p95 ms | 原问题 |',
        '|---|---:|---:|---:|---:|---:|---|',
    ]
    order = ['r13-cpu'] + list(configurations)
    for name in order:
        run = summary[name]; m = run['aggregate']; latency = run['latency_wall_ms']
        size = run.get('model_bytes', run.get('model_and_vocab_bytes')) / 1e6
        original = '检出' if name == 'r13-cpu' else ['正常 / 漏检', '异常 / 检出', '待定 / 未提示'][run['original_code']]
        lines.append(f'| {name} | {size:.2f} | {ratio(m["noise_detected"])} | '
                     f'{ratio(m["normal_false_positives"])} | {ratio(m["context_warnings"])} | '
                     f'{latency["p50"]:.1f} / {latency["p95"]:.1f} | {original} |')
    lines += ['', '原问题：`女哦就是的感受a到啊删掉asd苏打粉二十个s收到`。', '',
        '延迟为常驻单槽服务、显式热身后的逐条墙钟时间，不含模型加载。Qwen 包含本机 HTTP、'
        '模板应用和推理，R13 包含两套分词、Python/Node 管道、原生 ONNX Runtime 和决策，二者框架开销不同。'
        'R13 与既有原生预测的 675 条提示结果完全一致。所有计时任务串行运行。', '',
        '更低位数在这轮也没有带来更低的单条延迟。Q2 等配置会把完整标签拆成多个 token，'
        '增加解码步骤；汇总 JSON 记录每个配置的多 token 标签数量，不能把全部延迟差异归因于量化算子的速度。', '',
        'R13 的 Python ONNX Runtime 1.23.2 复跑最初出现 3/675 条提示差异，'
        '最大原始分数差约 2.81，已保留完整诊断；最终对照沿用档案对应的 '
        f'onnxruntime-node {reference["native_version"]}，通过全部提示一致性检查，未拿不同版本的分数替换旧结果。'
        '差异的具体计算实现原因没有定论。', '',
        '## 分批与语言', '',
        '| 配置 | 批次 | 异常检出 | 正常误报 | 上下文提示 |',
        '|---|---|---:|---:|---:|']
    for name in order:
        for split, metrics in summary[name]['splits'].items():
            lines.append(f'| {name} | {split} | {ratio(metrics["noise_detected"])} | '
                         f'{ratio(metrics["normal_false_positives"])} | {ratio(metrics["context_warnings"])} |')
    lines += ['', '| 配置 | 中文异常检出 | 英文异常检出 | 中英混合异常检出 |', '|---|---:|---:|---:|']
    for name in order:
        m = summary[name]['aggregate']['noise_languages']
        lines.append(f'| {name} | {ratio(m["zh"])} | {ratio(m["en"])} | {ratio(m["mixed"])} |')
    lines += ['', '## 加载与内存', '',
        '机器为 Ryzen 7 8745H / Radeon 780M / 约 21.27 GB 系统内存，原有 AMD 驱动 '
        '32.0.13032.11，未改动驱动。Vulkan 显示的约 14 GB 是共享地址空间，不能当作独立显存。', '',
        '| 配置 | 加载至健康状态秒 | 观察到的峰值 RSS MB | 私有提交 MB | 进程峰值工作集 MB | 最大单条 ms |',
        '|---|---:|---:|---:|---:|---:|']
    for name in configurations:
        run = summary[name]; mem = run['memory_peak_observed']
        loads = ', '.join(f'{t:.2f}' for t in run['load_to_health_seconds'])
        lines.append(f'| {name} | {loads} | {mem["rss"] / 1e6:.1f} | {mem["private"] / 1e6:.1f} | '
                     f'{mem["peak_wset"] / 1e6:.1f} | {run["latency_wall_ms"]["max"]:.1f} |')
    lines += ['', '加载测试已经下载并访问过文件，受操作系统文件缓存影响，不是冷开机时间。'
        'RSS、私有提交和 Vulkan/UMA 分配不是同一种内存指标，不能相加当成总占用；'
        '本表是进程测量，不声称完整核显物理内存峰值。', '',
        'R13 对照通过 Volta 的 Node 启动器运行；原始记录的父 PID 内存属于启动器，'
        '未作为 Node/ONNX 实际占用用于比较，本表仅列直接启动的 Qwen 原生进程。', '',
        '## 固定协议与限制', '',
        '- 主评测 675 条全是已知回归：实际输入法批次 006 的 50 条、公开 200 条；'
        '批次 005 的 60 条、另一公开 200 条；挑战 95 条和 legacy 70 条。'
        '标签沿用助手初标，没有改旧标签，也不是独立人工金标。没有生成新的物理随机数或新盲测。',
        '- 在主评测前只用既有 CAL 的 90 条（语言×类别各 10 条）比较预先列出的三种提示。'
        '选定中文短标签加三个 TRAIN 对话示例；CAL 检出 21/30、正常误报 2/30、上下文提示 5/30。'
        '选择代价 FN+3×(正常误报+上下文提示) 是工程筛选规则，不是用户约定的产品验收标准。',
        '- 主评测不再调提示、标签、阈值或温度。temperature=0、seed=0、关闭思考，'
        '语法约束正常/异常/待定；1024 token 上下文、单槽、4 CPU 线程。输入始终作为待分类文本。',
        '- Q4/Q3 的最初完整评测使用 1 token；Q2 预检出现合法标签片段“正”，当即停止，'
        '没有将截断算作语义错误。传输规则改为最多 8 token、首个完整标签即停止，'
        '解析原生 stopping_word。Q4/Q3 两后端各 20 条新旧规则核对共 80/80 一致，'
        '因此保留其原始完整输出；Q2/DASH 使用修正规则。原始诊断均留档。',
        '- CPU 和 Vulkan 在部分探针上分类不同；使用官方控制项禁用 F16 的复核也没有消除差异。'
        '因此两个后端分别计分，不能预设等价，也不能据此认定驱动或 GPU 存在缺陷。',
        '- DASH-Q 是看到 Q3 回归后追加的探索候选，沿用封存的提示、数据和运行时。'
        '它不是新盲测；原始六个配置结果未修改。',
        '- R13 已针对本任务训练，Qwen 只做三个示例提示。没有未量化 Qwen 控制组，'
        '不能把全部差异归因于量化，也不能据此推断所有提示或任务微调后的 Qwen 表现。', '',
        'Q4 Vulkan 也把正常句 `That is not what I was asking for.` 和 `这是我写的，你那份在另一边。` 判为异常；'
        '其误报并非只发生在无法理解的输入法片段上。', '',
        '本轮表明“只输出三个类别”仍需要可靠的语义表征，减少输出长度不能保证极低位量化保住分类能力。'
        '后续若继续投入 Qwen，值得验证的是任务三分类微调后再做 Q4 量化，并用独立新标注集验证；'
        '当前证据支持保留 R13 研究候选，继续处理误报样本。', '',
        '## 复现与试验包', '',
        '下载文件逐一锁定发布修订、长度与 SHA256，运行库为官方 llama.cpp b12110 '
        '（cd959bae9），保存在 `.research/semantic-qwen35/downloads.json`。'
        '量化权重来自 [Unsloth 发布页](https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF)，'
        '追加候选来自 [DASH-Q 发布页](https://huggingface.co/jkim96/Qwen3.5-0.8B-DASHQ-Q2-GGUF)，'
        '运行库来自 [官方 b12110 发布](https://github.com/ggml-org/llama.cpp/releases/tag/b12110)。', '',
        '封存脚本、下载清单、CAL 选择和全部逐条预测均留档。已完成的研究目录应保留原件；'
        'DASH 引用了主结果哈希，不能重新 download、prepare 或 combine 覆盖已有工件。'
        '日常复核单条输入可直接运行：', '', '```powershell',
        'node .research/semantic-qwen35/package/check.mjs --text "女哦就是的感受a到啊删掉asd苏打粉二十个s收到"',
        '```', '',
        f'试验 ZIP：`.research/semantic-qwen35/qwen35-q4-cpu-research.zip`，{package["archive_bytes"]:,} 字节；'
        f'SHA256 `{package["archive_sha256"]}`。包含 Apache-2.0、MIT 和 OpenMP 许可文本。'
        '入口检查模型 SHA，仅绑定 127.0.0.1，进程退出时关闭自己的 helper；不落盘保存输入。', '',
        '试验包选 Q4 CPU 作为便携复现基准，不表示它通过替换验收；为了满足完整包体预算，'
        '包内不含 Vulkan DLL。核显成绩来自上述完整研究运行库。'
        '`.research/semantic-qwen35/package-smoke.json` 记录入口实跑结果。', '',
        '主原始预测：`data/semantic-qwen35-results.json`；追加预测：`data/semantic-qwen35-dash-results.json`；'
        '汇总、三分类混淆矩阵、溯源哈希：`data/semantic-qwen35-comparison.json`。', '',
        '本单元是离线研究交付。`bundle/index.js` 未更改，没有部署或切换默认插件。SIM-1049 留在 in_review 等待产品评估。', '',
    ]
    (ROOT / 'REPORT-SEMANTIC-QWEN35.md').write_text('\n'.join(lines), encoding='utf-8')
    print(json.dumps({'jobs': len(configurations), 'report': 'REPORT-SEMANTIC-QWEN35.md',
                      'qwen_max_noise_detected': best_noise, 'r13_noise_detected': ref['noise_detected'][0]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
