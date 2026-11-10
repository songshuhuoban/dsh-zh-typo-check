"""Report whole-input RTD probes and prospective actual-IME evidence."""
from datetime import datetime,timezone
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('r6',ROOT/'tools/semantic-round6.py')
r6=importlib.util.module_from_spec(spec);spec.loader.exec_module(r6)
WORK=r6.WORK;data,manifest=r6.frozen();result=r6.read(WORK/'results.json')
future=r6.read(WORK/'prospective-ime-results.json');selection=result['selection'];chosen=selection['selected']
selected=chosen['mode'];current=result['configurations'][selected]['splits']
baseline=r6.read(ROOT/'.research/semantic-round5/results.json')['configurations']
source='女哦就是的感受a到啊删掉asd苏打粉二十个s收到'
original={mode:next(p for row,p in zip(data['known_legacy'],c['splits']['known_legacy']['predictions']) if row['text']==source)
          for mode,c in result['configurations'].items()}
assert r6.sha(WORK/chosen['artifact'])==chosen['artifact_sha256']
fresh=current['fresh_challenge']['metrics'];prospective=future['configurations'][selected]['metrics']
gates={'original':original[selected]['warning'],
    'old_normals':sum(current[k]['metrics']['normal_false_positives'][0] for k in ['known_round2','known_legacy'])==0,
    'r5_challenge_normal':fresh['normal_false_positives'][0]<=1,'r5_challenge_context':fresh['context_warnings'][0]<=1,
    'r5_challenge_en_noise':fresh['noise_languages']['en'][0]>=9,'r5_challenge_mixed_noise':fresh['noise_languages']['mixed'][0]>=9,
    'old_ime':current['known_ime']['metrics']['noise_detected'][0]>=12,
    'old_noise':current['known_round2']['metrics']['noise_detected'][0]>=19,
    'public_normal':current['new_public_test']['metrics']['normal_false_positives'][0]<=5,
    'size':chosen['artifact_and_vocab_bytes']<=50_000_000,
    'latency':current['known_round2']['p95_ms']<=15}
# Retained R5 acceptance checks; the small prospective cohort is descriptive,
# rather than adding an after-the-fact selection/threshold rule.
result.update(generated_at_utc=datetime.now(timezone.utc).isoformat(),issue='SIM-1041',original=original,
    gates=gates,all_gates_passed=all(gates.values()),prospective_ime=future,
    user_budget={'confirmed_bytes':50_000_000,'scope':'model plus vocabularies','source':'User selected 50 MB maximum on 2026-11-10'},
    prior_test_role='All R3/R4/R5 evaluation cohorts are known regressions; not fresh generalization evidence.')
r6.save(ROOT/'data/semantic-round6-results.json',result)
fmt=lambda v:f'{v[0]}/{v[1]}'
lines=['# 预训练逐词判别头：第六轮整句实验','',
    '2026-11-10，SIM-1041。用户确认离线模型加词表不超过50 MB（按50,000,000字节验收）。','',
    '**整体门槛通过。**' if all(gates.values()) else '**整体门槛未通过，保留研究对照，尚不能替换插件。**','',
    '## 方法与隔离','',
    '保留原始ELECTRA的编码器及逐词替换判别头，全部冻结。每个编码器都读取整段输入，不截取中文段。',
    '把CLS、正文平均向量和12个逐词统计量合为524维特征；双模型拼接1048维。仅训练128维MLP三分类头。',
    '标准化仅拟合TRAIN；训练10轮，事先固定比较第1/3/10轮。校准集按英语/中文/混排分别约束正常99%分位、各正常类别99%分位及上下文最大值，零为最低阈值，严格大于才提示。',
    '与R5相同的7529条唯一TRAIN文本、8297个采样条目，CAL1470条；不加入新训练样本。双模型和单模型分别按CAL语言宏平均检出率选轮次，再在体积预算内选方案。',
    '此前R3/R4/R5测试全部只作已知回归。新真实IME输出在模型和阈值封存之后采集，助手先逐条标注，再计算分数；没有按新测试结果调整阈值或标签。','',
    f"校准集选择：{selected}，第{chosen['epoch']}轮，模型{chosen['artifact_bytes']:,}字节，加词表{chosen['artifact_and_vocab_bytes']:,}字节。",
    f"封存UTC：{selection['sealed_at_utc']}；INT8 SHA256：`{chosen['artifact_sha256']}`。",'',
    '## 已知回归结果','',
    '分子/分母；正常栏表示被提示数，异常栏表示被检出数。公开正常是银标，其他多为助手标签。','',
    '| 方案 | R5英文异常 | R5混排异常 | 公开正常误报 | 英文word soup | 旧425异常 | 旧IME异常 | 原输入 |',
    '|---|---:|---:|---:|---:|---:|---:|---|']
for name in ['round3','round5','zh','dual']:
    c=(baseline[name]['splits'] if name in baseline else result['configurations'][name]['splits'])
    m=c['fresh_challenge']['metrics'];pub=c['new_public_test']['metrics']
    hit=next(p['warning'] for row,p in zip(data['known_legacy'],c['known_legacy']['predictions']) if row['text']==source)
    lines.append(f"| {name} | {fmt(m['noise_languages']['en'])} | {fmt(m['noise_languages']['mixed'])} | {fmt(pub['normal_false_positives'])} | {fmt(pub['noise_detected'])} | {fmt(c['known_round2']['metrics']['noise_detected'])} | {fmt(c['known_ime']['metrics']['noise_detected'])} | {'命中' if hit else '漏检'} |")
lines+=['','双模型明显改善英文及部分混排，但旧425正常误报3/365、旧70正常误报2/45、R5挑战正常误报2/50，旧IME正常1/1被误报，异常仅10/13。',
    '因此不能仅凭异常召回提升选为产品模型。完整正常、上下文及分语言计数见data/semantic-round6-results.json；R5挑战本轮属于已知回归，不能称新盲测。','',
    '## 新真实输入法盲测','',
    '40条键串沿用用户两段随机敲键的频率，未见字母权重为一次观测字母的1/10，每四条一条含原样例标点。',
    '使用同一归档RANDOM.ORG大气噪声响应中的未用比特[73728,82407)，无PRNG扩展；此前用到72280，中间1448位明确跳过。原始响应及SHA保留。',
    '原始物理性依据是服务方大气噪声来源声明，本机没有独立测量其硬件熵源。',
    '脚本用扫描码逐字输入专用记事本页，每条按一次空格、等待700ms读取可见编辑器；记录Escape前后并剔除未提交候选。',
    f"纳入{len(future['provenance']['rows'])}条；排除{len(future['provenance']['excluded'])}条，原因完整保存在JSON。随机来源不决定标签，标签由整句可理解性判定，未经独立人工复核。",'',
    '| 方案 | 正常误报 | 异常检出 | 上下文提示 |', '|---|---:|---:|---:|']
for name,c in future['configurations'].items():
    m=c['metrics'];lines.append(f"| {name} | {fmt(m['normal_false_positives'])} | {fmt(m['noise_detected'])} | {fmt(m['context_warnings'])} |")
lines+=['','同一敲键画像、同一IME且只有40条，不能据此推断真实用户总体误报率或泛化边界。',
    '原键串、一次空格实际输出：data/ime-keyboard/notepad-batch-002.jsonl；逐条标签及理由：data/ime-keyboard/assistant-labels-002.json。','',
    '## 核显、导出与体积','',
    f"Radeon 780M，torch-directml 0.2.5.dev240914。原始逐词特征CPU/核显最大差：{result['training']['original_rtd_feature_cpu_gpu_max_error']:.8g}。",
    '训练使用已通过CPU梯度核对的手写log-softmax/one-hot NLL，避开已确认错误的DirectML stock CE reduction=none反传。',
    '首次导出的字段位置映射错误被FP32一致性断言拦住，失败ONNX单独保留；显式按模型参数顺序导出后重新比较，没有放宽一致性阈值。',
    '最终每个候选的FP32导出差、INT8哈希、版本、截断计数、CAL选择及核显分类头梯度前置检查均已留存。',
    f"所选模型旧425集合Node ONNX batch1推理p95 {current['known_round2']['p95_ms']:.3f} ms，不含分词、模型载入和UI。",'',
    '## 验收检查','']
lines.extend(f"- {k}: {'通过' if v else '未通过'}" for k,v in gates.items())
lines+=['','本轮是研究制品，不含插件运行时代码、界面或发布，不存在staging验收URL。原插件的混排跳过问题仍待采用可靠整句策略后一并修复。','',
    '## 复现与来源','',
    '运行tools/semantic-round6.py prepare/train/export/evaluate及tools/semantic-round6-ime.py generate/assemble/evaluate；TRAIN用DirectML隔离环境，导出与评分用CPU环境，summary生成此报告。',
    '原始键串采集：tools/ime-notepad-batch.py --batch data/ime-keyboard/batch-002.json --output 新路径。已存在的原始采集和封存文件不得覆盖。',
    '[Transformers ELECTRA文档](https://huggingface.co/docs/transformers/v4.57.3/en/model_doc/electra)解释替换词判别任务；逐词替换分数不是整句语义错误概率。',
    '[HFL中文模型](https://huggingface.co/hfl/chinese-electra-180g-small-discriminator)，版本826a243f3f387450ef8d70de9c3d0706d8d8e924。',
    '[Google英文模型](https://huggingface.co/google/electra-small-discriminator)，版本fa8239aadc095e9164941d05878b98afe9b953c3。',
    '[DirectML相关公开梯度问题](https://github.com/microsoft/DirectML/issues/739)；本机同checkpoint完整梯度证据见data/semantic-directml-gradient-check.json。']
(ROOT/'REPORT-SEMANTIC-ROUND6.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
print(json.dumps({'selected_mode':selected,'bytes':chosen['artifact_and_vocab_bytes'],'gates':gates,
    'new_ime':prospective,'original':original[selected]},ensure_ascii=False))
