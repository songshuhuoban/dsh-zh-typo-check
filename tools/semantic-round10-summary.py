"""Known-regression feasibility report for the tiny learned whole-input gate."""
from datetime import datetime,timezone
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('r10',ROOT/'tools/semantic-round10.py')
r10=importlib.util.module_from_spec(spec);spec.loader.exec_module(r10)
WORK=r10.WORK;data,manifest=r10.frozen();result=r10.read(WORK/'results.json');selection=result['selection'];chosen=selection['selected']
r9result=r10.read(r10.r9.WORK/'results.json');future9=r10.read(r10.r9.WORK/'prospective-ime-results.json')
baseline={};thresholds=selection['baseline']['thresholds']
import numpy as np
for split,rows in data.items():
    if split in ['train','cal']:continue
    source=future9['configurations']['round9'] if split=='known_r9_ime' else r9result['configurations']['round9']['splits'][split]
    assert len(source['predictions'])==len(rows)
    scores=np.array([p['raw_score'] for p in source['predictions']]);adjusted=scores-np.array([thresholds[r10.r4.language(r['text'])] for r in rows])
    baseline[split]=r10.r4.measured(rows,adjusted,0.)
text='女哦就是的感受a到啊删掉asd苏打粉二十个s收到'
original=next(p for r,p in zip(data['known_legacy'],result['splits']['known_legacy']['predictions']) if r['text']==text)
retained={'original':original['warning'],'old_normal_zero':sum(result['splits'][s]['metrics']['normal_false_positives'][0] for s in ['known_round2','known_legacy'])==0,
    'old_ime_12':result['splits']['known_ime']['metrics']['noise_detected'][0]>=12,'old_noise_19':result['splits']['known_round2']['metrics']['noise_detected'][0]>=19,
    'old_latency_15':result['splits']['known_round2']['p95_ms']<=15}
result.update(generated_at_utc=datetime.now(timezone.utc).isoformat(),issue='SIM-1045',baseline_r9_recalibrated=baseline,
    retained_old_checks=retained,original=original,native_helper_sha256=r10.sha(ROOT/'tools/semantic-gate-native.mjs'),
    local_probe_sha256=r10.sha(ROOT/'tools/semantic-predict.py'))
r10.save(ROOT/'data/semantic-round10-results.json',result)
fmt=lambda v:f'{v[0]}/{v[1]}'
lines=['# 50 MB内的学习型整句融合：第十轮初筛','',
    '2026-11-10，SIM-1045。使用第九轮已冻结数据，不加入已知测试到训练。','',
    '**实用初筛未通过，本候选不接入插件，不再追加新盲测。**' if not result['all_gates_passed'] else '**已通过初筛，仍须另采新盲测。**','',
    '## 方案与隔离','',
    '固定R3中文分类器与R9严格方案第6轮模型，均读取整段输入。两套模型共三个编码器；取六个原始分类logits，训练一个6→16ReLU→3残差头，最后一层零初始化，初始输出逐位等于R9。',
    '新头仅163参数。TRAIN唯一文本上拟合六维均值/标准差，残差输入限制[-10,10]；对原R9正常/上下文输出做保留损失，异常类别允许直接学习。',
    '沿用R9 TRAIN9217条采样/7949唯一、CAL1670；30轮固定比较3/10/30。阈值沿用已封存的小来源合并规则：语言总体正常99%、来源正常至少101才单独约束、上下文最大值、最低0。',
    '按CAL最低语言召回、宏平均、正常提示数、较早轮次选择；本轮全部测试都是已知回归，包括第九轮新短句260条和004实际输出60条。没有再次称作独立盲测。',
    f"选第{chosen['epoch']}轮；163参数FP32 ONNX仅{chosen['gate_bytes']:,}字节，加两套INT8基础模型和共享词表共{chosen['artifact_and_vocab_bytes']:,}字节（约40.21 MB）。",'',
    '## 已知回归结果','',
    '| 集合 | 正常提示 | 异常检出 | 上下文提示 |','|---|---:|---:|---:|']
for split,c in result['splits'].items():
    m=c['metrics'];lines.append(f"| {split} | {fmt(m['normal_false_positives'])} | {fmt(m['noise_detected'])} | {fmt(m['context_warnings'])} |")
lines+=['','### 同批004对照（均为本轮已知回归）','',
    '| 方案 | 正常提示 | 异常检出 | 上下文提示 |','|---|---:|---:|---:|']
for label,m in [('R9原严格阈值',future9['configurations']['round9']['metrics']),('R9第6轮按本轮同规则校准',baseline['known_r9_ime']),('R10学习型融合',result['splits']['known_r9_ime']['metrics'])]:
    lines.append(f"| {label} | {fmt(m['normal_false_positives'])} | {fmt(m['noise_detected'])} | {fmt(m['context_warnings'])} |")
lines+=['','这些结果不能当成新的泛化证据。实际正常只有2条、标签为助手初标，不能用0/2宣称总体0误报。',
    '学习型小头在本次数据/配方下没有同时达到规定的异常检出与上下文约束；这不证明所有融合方法都无效。','',
    '## 数值、延迟与验收','',
    f"Radeon780M训练163参数头，CPU/DirectML梯度相对L2误差{result['training']['gradient_preflight']['relative_l2_error']:.8g}、最大差{result['training']['gradient_preflight']['max_abs_error']:.8g}。",
    f"选定小头FP32导出最大差{chosen['fp32_export_max_drift']:.8g}；完整原生组合管线与缓存CAL部件分数最大差{result['native_composition_max_drift']:.8g}。",
    f"Node三会话顺序执行旧425条batch1实测p95 {result['splits']['known_round2']['p95_ms']:.3f} ms；不含分词、载入和UI。",'',
    '本轮预先设实用初筛20ms并单独保留旧15ms检查；没有将新标准冒充旧标准。初筛仅用于决定是否值得另采新盲测，不能等同发布验收。','']
lines.extend(f"- practical.{key}: {'通过' if value else '未通过'}" for key,value in result['gates'].items())
lines.extend(f"- retained.{key}: {'通过' if value else '未通过'}" for key,value in retained.items())
lines+=['','既定继续条件为全部实用初筛通过；本次未通过，因此没有采第五批，没有消耗额外物理熵。004和公开抽样之后最后使用位置仍为121976/160000。',
    '本轮没有修改插件UI、运行时、驱动或部署，研究制品没有staging验收URL。','',
    '## 本地复核','',
    '`python tools/semantic-predict.py --model round10 --text "整句话"`，使用本机CPU研究环境和封存模型，不发网络请求。',
    '原始问题句是否命中、完整模型哈希/阈值/数据角色及结果：data/semantic-round10-results.json；第九轮真实补训和独立测试见REPORT-SEMANTIC-ROUND9.md。',
    '脚本：tools/semantic-round10.py prepare/train/evaluate、tools/semantic-gate-native.mjs、tools/semantic-round10-summary.py。',
    '所有数据JSON及原始IME档案禁用Git自动换行转换，避免在提交/检出时改变已记录的字节哈希。']
(ROOT/'REPORT-SEMANTIC-ROUND10.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
print(json.dumps({'gates_passed':result['all_gates_passed'],'bytes':chosen['artifact_and_vocab_bytes'],
    'original':original['warning'],'known_actual':result['splits']['known_r9_ime']['metrics'],'new_entropy':0},ensure_ascii=False))
