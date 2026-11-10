"""Write the recorded R11 experiment outcome without choosing from TEST."""
import importlib.util
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('r11',ROOT/'tools/semantic-round11.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
d=r.read(r.WORK/'results.json');s=d['selection']['selected'];current=d['configurations'][s['arm']]['splits']
lines=['# 整句模型末层微调：第十一轮对照','',
    '2026-11-10，SIM-1046。预设初筛未通过，保留研究结果，候选不接入插件。','',
    '## 方法与数据','',
    '从R7已选的R3中文编码器/分类头加英文RTD残差模型热启动，比较只训残差头与同时解冻中文最后两层。',
    '两组均固定英文编码器、原中文分类头、归一化参数，关闭编码器及特征dropout，只在残差头使用0.1 dropout。',
    '只训头133,123参数；末层组1,712,643参数，其中编码器1,579,520。头学习率0.0002、编码器0.00002，3轮比较1/3。',
    '复用R9 TRAIN9217采样/7949唯一、CAL1670，不向训练或校准加入旧测试。正常与上下文使用R9严格epoch6教师保留损失；教师从源头重新计算，未误用R9缓存中的旧R6教师。',
    '阈值使用语言总体正常99%、来源正常至少101时独立99%、上下文最大值、最低0。按CAL最低语言召回、宏平均、少正常提示选模型，测试不参与选择。',
    f"整体选{s['arm']} epoch{s['epoch']}，含共享词表{s['artifact_and_vocab_bytes']:,}字节。只训头独立选epoch3。所有本轮TEST均为已知回归。",'',
    '## 已知回归','',
    '| 集合 | 正常提示 | 异常检出 | 上下文提示 |',
    '|---|---:|---:|---:|']
for name,v in current.items():
    m=v['metrics'];fmt=lambda k:'/'.join(map(str,m[k]))
    lines.append(f"| {name} | {fmt('normal_false_positives')} | {fmt('noise_detected')} | {fmt('context_warnings')} |")
g=d['training']['gradient_preflight']['last2']['groups']
lines+=['',
    '已知004实际乱敲：只训头9/37异常、正常0/2、上下文1/21；末层组17/37、0/2、2/21。',
    '同批R9严格原方案14/37、0/2、1/21，R9合并小来源方案23/37、1/2、5/21；不能只挑一个指标称为整体提高。',
    '正常样本数很少，标签仍为助手初标，0/2不代表总体零误报。原始问题句命中。',
    '本轮结果只支持这一热启动和训练配方的结论，不支持“所有末层微调无效”。','',
    '## 数值与交付边界','',
    f"实际CPU/DirectML反向核对通过：编码器梯度相对L2误差{g['encoder']['relative_l2_error']:.8g}，残差{g['residual']['relative_l2_error']:.8g}。",
    f"选定模型FP32导出最大差{s['fp32_export_max_drift']:.8g}。每轮冻结参数逐位不变断言均通过。",
    f"Node原生旧425条batch1 p95 {current['known_round2']['p95_ms']:.3f}ms；不包含分词、载入及UI。公开长文本组p95 {current['new_public_test']['p95_ms']:.3f}ms，保留该范围差异。",
    '实用门槛失败包括真实异常召回、真实上下文、旧425异常召回、混排挑战召回。按预先守卫没有追加005或使用新物理熵，最后已用位置仍121976/160000。',
    '未修改插件运行时、UI、驱动，未部署，无staging验收URL。','',
    f"模型SHA256：`{s['artifact_sha256']}`。",
    '完整阈值、各组预测、梯度和数据哈希见data/semantic-round11-results.json。',
    '本地复核：研究CPU环境执行tools/semantic-predict.py --model round11 --text "整句话"。','']
(ROOT/'REPORT-SEMANTIC-ROUND11.md').write_text('\n'.join(lines),encoding='utf-8')
notes=ROOT/'NOTES.md'
with notes.open('a',encoding='utf-8') as f:
    f.write('\n## 五十一、末层微调与只训头对照（2026-11-10）\n\n'
        'SIM-1046：R7热启动，固定英文与原中文分类头，对照只训133123参数残差与解冻中文末两层共1712643参数。\n'
        '同R9 TRAIN/CAL，3轮比较1/3，CAL选末层epoch1，含词表27338940bytes。实际CPU/核显梯度及冻结参数检查通过。\n'
        '全部是已知回归：004异常17/37、正常0/2、上下文2/21；短句正常0/123、上下文0/137；\n'
        '旧425异常21/40、正常2/365，公开正常1/506；英文15/15、混排7/15、正常1/50。\n'
        '原问题句命中，旧425原生p95约10.59ms。预设初筛失败，未采005、未消耗新物理熵、未接入插件。\n'
        'REPORT-SEMANTIC-ROUND11.md与data/semantic-round11-results.json保留全量；本地predict支持round11。\n')
print({'report':'REPORT-SEMANTIC-ROUND11.md','all_gates_passed':d['all_gates_passed']})
