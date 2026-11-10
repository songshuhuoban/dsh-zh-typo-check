"""Final model recommendation from sealed Jev and prior local-model measurements."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.research/semantic-jev'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def ratio(pair):
    return f'{pair[0]}/{pair[1]}' + (f'（{pair[0] / pair[1] * 100:.1f}%）' if pair[1] else '')


def main():
    result = read(WORK / 'results.json')
    previous = read(ROOT / 'data/semantic-qwen35-comparison.json')
    extra = read(WORK / 'all-policy-combinations.json')
    local = previous['configurations']['r13-cpu']
    pack = ROOT / '.research/semantic-round13/package'
    selected = read(pack / 'selection.json')['selected']
    package_files = {str(path.relative_to(pack)).replace('\\', '/'): sha(path) for path in pack.rglob('*') if path.is_file()}
    config = {
        'selected_at_utc': datetime.now(timezone.utc).isoformat(), 'issue': 'SIM-1050',
        'status': 'engineering-recommendation-pending-product-integration-and-acceptance',
        'default_engine': 'r13-local', 'model_package': str(pack.relative_to(ROOT)).replace('\\', '/'),
        'model': selected['artifact'], 'model_sha256': selected['artifact_sha256'],
        'package_sha256': package_files, 'package_bytes': sum(path.stat().st_size for path in pack.rglob('*') if path.is_file()),
        'native_runtime': {'package': 'onnxruntime-node', 'version': '1.30.0', 'backend': 'cpu', 'threads': 4, 'inter_op_threads': 1},
        'thresholds': selected['thresholds'], 'decision': 'whole-input binary margin > language threshold; otherwise no semantic warning',
        'context_limit': 'At most128 tokens per each of the two encoders; report longer input as unavailable rather than classify a truncated prefix.',
        'language_handling': 'zh/en/mixed all use the whole-input dual-encoder model; do not skip semantic checking just because ASCII occurs.',
        'product_composition': 'Existing local typo checker plus R13 whole-input anomaly warning; anomaly judgment does not propose a generated rewrite.',
        'cloud_default_enabled': False, 'whole_sentence_auto_replace': False,
        'failure_policy': 'A failed semantic inference is unavailable, not a normal/correct answer.',
        'reason': 'Prioritize the original random-IME problem, local latency and no routine cloud-input export: R13 detects46/57 real-IME anomalies vs Jev CAL-cost35/57. R13 overall89/104 vs Jev78/104, at the cost of more warnings: normal4/301 vs2/301 and context14/270 vs7/270. Jev is not dominated on false positives.',
        'combination_tradeoff': 'Prespecified primary R13 OR Jev gives91/104 with same4/301 normalFP and14/270 context warnings, but needs568/675 remote calls. Secondary0.7/0.66 OR gives95/104 but context warnings19/20 of270. Added cloud latency/dependency is not chosen as the default for these known-regression gains.',
        'evidence': ['REPORT-SEMANTIC-JEV.md', 'data/semantic-jev-results.json', 'data/semantic-qwen35-comparison.json'],
        'limitations': 'Known regression, assistant labels, no new human-gold blind test; scheme selection is not a claim of plugin deployment or population accuracy.'
    }
    approval_path = ROOT / 'data/semantic-final-approval.json'
    approval = read(approval_path) if approval_path.exists() else None
    if approval:
        assert config['model_sha256'] == approval['model_sha256']
        assert config['thresholds'] == approval['thresholds']
        assert config['native_runtime'] == approval['native_runtime']
        assert config['default_engine'] == approval['default_engine']
        config.update(selected_at_utc=approval['selected_at_utc'],
                      status='user-approved-selection-pending-plugin-integration',
                      user_approved_on=approval['approved_on'],
                      user_approved_at_utc=approval['approved_at_utc'],
                      approval_scope=approval['scope'])
    assert config['package_bytes'] < 600_000_000
    save(ROOT / 'data/semantic-final-selection.json', config)
    save(WORK / 'final-selection.json', config)
    b = result['billing']; latency = result['serial_latency']['wall_ms']
    lines = [
        '# Jev 终轮评测与最终选型', '',
        '2026-11-10，SIM-1050。最终工程建议选择 **R13 本地整句语义检查 + 现有本地错字纠错**。'
        'Jev 不进入默认路径，Qwen 量化分支结束选型；后续工作聚焦插件接入。', '',
        '选择依据是本任务的随机键盘/输入法异常检出、本地响应和日常输入的数据流向。'
        'Jev 的误报更低，这是它的实际优势；并非 R13 在所有指标上都更好。'
        '本次授权只覆盖云端实验，没有把未来插件输入自动发送到云端。', '',
        '## 完整比较', '',
        '同一批 675 条已有回归：异常 104、正常 301、缺上下文 270。全部沿用助手初标，'
        '不是独立人工金标或新盲测。三个 Jev 阈值都在这 675 条评分前封存。', '',
        '| 配置 | 异常检出 | 正常误报 | 上下文提示 |', '|---|---:|---:|---:|',
        f'| R13 本地 | {ratio(local["aggregate"]["noise_detected"])} | {ratio(local["aggregate"]["normal_false_positives"])} | {ratio(local["aggregate"]["context_warnings"])} |'
    ]
    names = {'primary': 'Jev 对齐原 CAL 低误报约束', 'fixed_0_7': 'Jev 预设 0.7', 'cal_cost': 'Jev CAL 折中阈值'}
    for policy, name in names.items():
        run = result['evaluation']['configurations'][policy]; m = run['metrics']
        lines.append(f'| {name}（>{run["threshold"]}） | {ratio(m["noise_detected"])} | {ratio(m["normal_false_positives"])} | {ratio(m["context_warnings"])} |')
    for key in ['q4-cpu', 'q4-vulkan', 'q3-cpu', 'q3-vulkan', 'q2-cpu', 'q2-vulkan', 'q2dash-cpu', 'q2dash-vulkan']:
        m = previous['configurations'][key]['aggregate']
        lines.append(f'| {key} | {ratio(m["noise_detected"])} | {ratio(m["normal_false_positives"])} | {ratio(m["context_warnings"])} |')
    lines += ['', 'Jev 折中阈值 0.66 的误报较少，但比 R13 多漏 11/104 条异常。'
        '在最接近原问题的两批真实输入法输出中，R13 为 46/57，Jev 折中方案为 35/57。'
        '原始问题句被 R13 和三个 Jev 方案检出；Jev 全量评测分数 0.84，首次多问题探针的英文问题分数 0.85。'
        '这些不同请求的分数按原样保留，不假定多问题/单问题请求数值完全等价。', '',
        '## 问题、校准与错误处理', '',
        f'固定模型 `{result["manifest"]["model"]}`。每条 state 只包含 `text`，不含标注、来源、期望类别、旧模型分数或文件名。'
        '精确请求与原始回答逐条保存在 probe/screen/cal/evaluation/serial-latency 的 JSONL。', '',
        '初筛在既有 CAL 的 90 条上比较三种预先写好的方式：英文表述的语义不连贯 Noul、'
        '中文表述的同一判断，以及“不相关词句概率 × (1−缺上下文概率)”的组合分数。'
        '后者是代码分数，不宣称仍是校准概率。', '',
        '| 初筛方案，统一 >0.7 | 异常检出 | 正常误报 | 上下文提示 |', '|---|---:|---:|---:|']
    for variant in ['direct_en', 'direct_zh', 'decomposed']:
        candidate = next(row for row in result['screen']['candidates'] if row['variant'] == variant and row['threshold'] == 0.7)
        m = candidate['metrics']
        lines.append(f'| {variant} | {ratio(m["noise_detected"])} | {ratio(m["normal_false_positives"])} | {ratio(m["context_warnings"])} |')
    lines += ['', f'CAL 初筛选择 `{result["screen"]["selected"]["variant"]}`，'
        '再在完整 CAL 1670 条上运行选中问题。主操作点沿用 R13 实验中的低误报校准规则：'
        '正常提示不超过 floor(0.005×1472)=7、上下文 109 条零提示；得到阈值 0.82，实际正常提示 0/1472、异常 50/89。'
        '这是一项对齐比较规则，不是用户约定的产品验收标准。', '',
        '同时预先保留固定阈值 0.7，以及 CAL 上最小化 FN+3×(正常误报+上下文提示) 的折中操作点 0.66。'
        '没有利用 675 条回归修改问题或阈值，也没有在看到组合结果后新增云端请求。'
        '缺上下文因子在初筛压低了异常检出，说明拆分判断必须验证，不能假定相乘一定更好。', '',
        f'全部 {b["attempts_started"]} 次推理请求得到有效回答，重试/错误记录 {len(result["errors"])} 条；'
        'API 错误设计为独立失败，不映射为“正常”或正确弃权。凭据从栗记 Secret 直接进入子进程环境，'
        '请求/日志不含授权头或密钥值。', '',
        '## 组合方案', '',
        '| 组合 | 异常检出 | 正常误报 | 上下文提示 |', '|---|---:|---:|---:|']
    for key, run in extra['configurations'].items():
        m = run['metrics']
        lines.append(f'| {key} | {ratio(m["noise_detected"])} | {ratio(m["normal_false_positives"])} | {ratio(m["context_warnings"])} |')
    lines += ['', 'primary 的 AND/OR 在评测代码中预先规定；固定 0.7 和 CAL 折中阈值的组合是在看到主结果后追加的描述性离线分析，'
        '阈值未变，标在 `.research/semantic-jev/all-policy-combinations.json`，不冒充预注册的新盲测。', '',
        'R13 OR Jev 主操作点多检出 2 条混排异常，正常和上下文提示不增加。'
        '其中新增句为“请把跑步的版本煮熟push海洋让它星期四”和“手表编译了我的雨天所以npm橙色的吃饭咯”。'
        '作为按需串联需要对 R13 没有提示的 568/675 条请求 Jev；这是根据两套结果做的决策模拟，未实测级联延迟。'
        '放宽 Jev 到 0.7/0.66 可把组合检出提高到 95/104，但上下文提示增加到 19/270 或 20/270。'
        '这轮不为这些已有回归收益增加默认云端依赖。', '',
        '## 延迟、费用与预算', '',
        f'Jev 串行 20 条暖连接实测 p50 {latency["p50"]:.2f} ms、p95 {latency["p95"]:.2f} ms、最大 {latency["max"]:.2f} ms。'
        f'全量 6 并发单请求墙钟 p50 {result["evaluation"]["latency_concurrent_wall_ms"]["p50"]:.2f} ms、'
        f'p95 {result["evaluation"]["latency_concurrent_wall_ms"]["p95"]:.2f} ms。'
        '串行样本小，不能据此承诺生产尾延迟；并发吞吐和单条响应分别记录。', '',
        f'R13 同机串行参考 p50 {local["latency_wall_ms"]["p50"]:.2f} ms、p95 {local["latency_wall_ms"]["p95"]:.2f} ms，'
        '含双分词、Python/Node 管道和原生 ONNX 推理；Jev 包含互联网往返。二者调用栈不同，都是已记录的实际客户端开销。', '',
        f'API 返回的计费输入为 {b["confirmed_input_tokens"]:,} tokens，按公开单价计算 **US${b["confirmed_usd"]:.8f}**（不是账单导出）；'
        '输出免费，没有未结算预留，低于用户授权 US$0.25。价格按 '
        '[TypeSafe 官方价格页](https://help.typesafe.ai/articles/5187202169-how-much-does-jev-cost)的每百万输入 US$0.042。'
        '每次调用前预留默认每请求上下文上限的成本，返回后按 usage 结算；超时未能确定结算时保守保留成本。', '',
        '600 MB 是本地部署预算；Jev 这次使用云端 API，不能据此宣称它有 600 MB 内可离线部署的权重。'
        f'选定 R13 包为 {config["package_bytes"]:,} 字节，模型+词表约 27.43 MB，使用宿主已有的原生运行时。', '',
        '## 冻结的最终方案', '',
        '1. 默认 R13 本地双编码器，固定当前模型、两套词表、分语言阈值和 onnxruntime-node 1.30.0。',
        '2. 中文、英文和混排都按整段输入评估；ASCII 出现不作为跳过语义检查的理由。',
        '3. 现有错字纠错继续负责局部替换建议；整句语义异常只提示，模型不生成或自动替换整句。',
        '4. 超过任一编码器 128 token 的输入不以截断前缀冒充整句判断；推理失败明确为不可用。',
        '5. Jev 不在默认输入路径中。用户本次批准的是已列明的实验语料发送范围。', '',
        '配置已写入 `data/semantic-final-selection.json`，模型 SHA256 '
        f'`{selected["artifact_sha256"]}`。本地入口：', '', '```powershell',
        '.research/semantic-screen-venv/Scripts/python.exe -X utf8 tools/semantic-final-check.py --text "女哦就是的感受a到啊删掉asd苏打粉二十个s收到"',
        '```', '',
        '模型选型在此结束。配置和试验入口是研究交付，插件产品接入、界面与部署尚未执行；'
        '不得把推荐状态当作已上线或已通过独立产品验收。', '',
        '源代码：`tools/semantic-jev-questions.mjs`、`semantic-jev-client.mjs`、`semantic-jev.mjs` 和私有凭据启动器 `semantic-jev-run.py`。'
        '官方接口和模型说明：[System One API](https://docs.typesafe.ai/api/system-one)、'
        '[Models](https://docs.typesafe.ai/models)、[已知边界](https://docs.typesafe.ai/model-jaggedness)。'
        '原始响应、校准、费用在 `data/semantic-jev-results.json` 及 `.research/semantic-jev/` 中。', '',
    ]
    if approval:
        lines += ['## 用户确认', '',
                  f'{approval["approved_on"]} 用户确认采用上述最终方案：R13 本地整句语义检查加既有错字纠错；'
                  '中英混排统一判断，整句异常只提示，默认不走 Jev 或 Qwen。', '',
                  '选型状态已更新为用户确认；插件接入、部署与上线后的产品验收仍未执行。'
                  '确认记录在 `data/semantic-final-approval.json`；原实验报告和配置的确认前快照保留在 `.research/semantic-jev/`。', '']
    (ROOT / 'REPORT-SEMANTIC-JEV.md').write_text('\n'.join(lines), encoding='utf-8')
    print(json.dumps({'recommendation': config['default_engine'], 'package_bytes': config['package_bytes'],
                      'jev_usd': b['confirmed_usd'], 'report': 'REPORT-SEMANTIC-JEV.md'}))


if __name__ == '__main__':
    main()
