"""Summarize the frozen R4 trial, including preset gates and regressions."""
import hashlib
import argparse
import json
import math
from datetime import datetime,timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--workdir',type=Path,default=ROOT/'.research/semantic-round4')
parser.add_argument('--output',type=Path,default=ROOT/'data/semantic-round4-results.json')
parser.add_argument('--report',type=Path,default=ROOT/'REPORT-SEMANTIC-ROUND4.md')
args=parser.parse_args();WORK=args.workdir.resolve()
data=json.loads((WORK/'prepared.json').read_bytes())
result=json.loads((WORK/'results.json').read_bytes())
alternative=json.loads((WORK/'calibrated-results.json').read_bytes())
result['configurations']['round4-language-calibrated']=alternative
gradient_bug_path=WORK/'device-gradient-check.json'
if gradient_bug_path.exists():
    result['training_validity']={'valid':False,'reason':'DirectML stock CE(reduction=none) ignores per-row backward weights/masks.',
        'gradient_check':json.loads(gradient_bug_path.read_bytes()),'minimal_reproducer':'data/semantic-directml-loss-check.json'}
elif result['selection'].get('loss_implementation')=='manual':
    result['training_validity']={'valid':True,'loss':'log_softmax + one-hot NLL',
                                'gradient_preflight':result['selection']['gradient_preflight']}
result['training_provenance']=json.loads((WORK/'training-started.json').read_bytes())
selection=result['selection'];manifest=result['manifest']
for split,rows in data.items():
    assert hashlib.sha256(json.dumps(rows,ensure_ascii=False,sort_keys=True).encode()).hexdigest()==manifest['split_hashes'][split]
assert hashlib.sha256((WORK/selection['selected']['artifact']).read_bytes()).hexdigest()==selection['checkpoint_sha256']
assert hashlib.sha256((WORK/selection['selected']['torch_checkpoint']).read_bytes()).hexdigest()==selection['torch_checkpoint_sha256']
current=result['configurations']['round4-public-aux']['splits']
original='女哦就是的感受a到啊删掉asd苏打粉二十个s收到'
original_predictions=[p for split,value in current.items() for r,p in zip(data[split],value['predictions']) if r['text']==original]
assert len(original_predictions)==1
challenge=current['new_challenge']['metrics'];ime=current['known_ime']['metrics'];known=current['known_round2']['metrics']
criteria=manifest['protocol']['provisional_gates']
gates={
 'original_detected':original_predictions[0]['warning'],
 'known_normal_zero_fp':sum(current[s]['metrics']['normal_false_positives'][0] for s in ['known_round2','known_legacy'])<=criteria['known_normal_max_fp'],
 'fresh_challenge_normal':challenge['normal_false_positives'][0]<=criteria['fresh_challenge_normal_max_fp'],
 'fresh_challenge_context':challenge['context_warnings'][0]<=criteria['fresh_challenge_context_max_warnings'],
 'fresh_en_noise':challenge['noise_languages']['en'][0]/challenge['noise_languages']['en'][1]>=criteria['fresh_en_and_mixed_noise_min_recall'],
 'fresh_mixed_noise':challenge['noise_languages']['mixed'][0]/challenge['noise_languages']['mixed'][1]>=criteria['fresh_en_and_mixed_noise_min_recall'],
 'known_ime_noise':ime['noise_detected'][0]>=criteria['known_ime_min_noise_detected'],
 'known_ime_context':ime['context_warnings'][0]<=criteria['known_ime_max_context_warnings'],
 'known_round2_noise':known['noise_detected'][0]>=criteria['known_round2_min_noise_detected'],
 'size':selection['selected']['artifact_bytes']<=criteria['max_int8_bytes'],
 'latency':current['known_round2']['latency_p95_ms']<=criteria['max_native_p95_ms'],
}
alt=alternative['splits'];ac=alt['new_challenge']['metrics'];ai=alt['known_ime']['metrics'];ak=alt['known_round2']['metrics']
alt_original=[p for split,value in alt.items() for row,p in zip(data[split],value['predictions']) if row['text']==original]
alternative_gates={
 'original_detected':alt_original[0]['warning'],
 'known_normal_zero_fp':sum(alt[s]['metrics']['normal_false_positives'][0] for s in ['known_round2','known_legacy'])==0,
 'fresh_challenge_normal':ac['normal_false_positives'][0]<=criteria['fresh_challenge_normal_max_fp'],
 'fresh_challenge_context':ac['context_warnings'][0]<=criteria['fresh_challenge_context_max_warnings'],
 'fresh_en_noise':ac['noise_languages']['en'][0]/ac['noise_languages']['en'][1]>=criteria['fresh_en_and_mixed_noise_min_recall'],
 'fresh_mixed_noise':ac['noise_languages']['mixed'][0]/ac['noise_languages']['mixed'][1]>=criteria['fresh_en_and_mixed_noise_min_recall'],
 'known_ime_noise':ai['noise_detected'][0]>=criteria['known_ime_min_noise_detected'],
 'known_ime_context':ai['context_warnings'][0]<=criteria['known_ime_max_context_warnings'],
 'known_round2_noise':ak['noise_detected'][0]>=criteria['known_round2_min_noise_detected'],
 'size':(WORK/alternative['selection']['selected']['artifact']).stat().st_size<=criteria['max_int8_bytes'],
 'latency':alt['known_round2']['latency_p95_ms']<=criteria['max_native_p95_ms'],
}
first_test_time=min(p.stat().st_mtime for p in WORK.glob('*new_challenge-scores.json'))
assert datetime.fromisoformat(alternative['selection']['selected_at_utc']).timestamp()<first_test_time


def rate(values):
    k,n=values
    if not n:return {'count':k,'total':n,'rate':None,'wilson_95':None}
    p=k/n;z=1.959963984540054;den=1+z*z/n
    center=(p+z*z/(2*n))/den;radius=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return {'count':k,'total':n,'rate':p,'wilson_95':[max(0.,center-radius),min(1.,center+radius)]}


summary=result|{'generated_at_utc':datetime.now(timezone.utc).isoformat(),'issue':'SIM-1039',
 'provisional_gates':gates,'all_provisional_gates_passed':all(gates.values()),
 'alternative_provisional_gates':alternative_gates,'alternative_all_provisional_gates_passed':all(alternative_gates.values()),
 'calibration_plan':json.loads((WORK/'calibration-plan.json').read_bytes()),
 'code_hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in
   [ROOT/'tools/semantic-round4-data.py',ROOT/'tools/semantic-round4.py',ROOT/'tools/semantic-round4-language.py',ROOT/'tools/semantic_device_optim.py',ROOT/'tools/semantic-round2-native.mjs']},
 'original_prediction':original_predictions[0]}
for name,config in summary['configurations'].items():
    for split,item in config['splits'].items():
        item['rates']={key:rate(item['metrics'][key]) for key in ['normal_false_positives','noise_detected','context_warnings']}
output=args.output.resolve()
output.write_text(json.dumps(summary,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8')

lines=[
 '# 公开数据辅助与核显微调：第四轮',
 '',
 '目标：改善明显英文/中英混排乱句检出，同时保护正常混排、代码、引用和需要上下文的短语。',
 'SIM-1039。固定划分及三轮训练均已完成；以下结果来自最终 Node INT8 运行时。',
 '',
 '## 方法与数据',
 '',
 f"从 R3 自有权重继续训练，{manifest['unique_train_texts']} 条唯一文本、{len(data['train'])} 个采样条目。",
 '其中主任务 7,907 个条目，另有独立 CSED 语义辅助任务 8,000 条；辅助病句标签没有并入乱码类别。',
 '',
 '- [CSED-R](https://github.com/wyxstriker/CSED)：固定58ffd848，train各取4,000正常/病句；dev去重并排除9组矛盾标签。',
 '- [ASCEND](https://huggingface.co/datasets/CAiRE/ASCEND)：固定737e9800，12,314条原始转录，仅读取文字列；按23位说话人隔离所有本地session，筛选自然混排。CC-BY-SA-4.0。',
 '- [Incoherent Text Dataset](https://huggingface.co/datasets/SuccubusBot/incoherent-text-dataset)：固定7f1159d，共37,652条算法生成数据；本轮只取英文coherent与word_soup，训练异常重复4次，仍计唯一文本。作者卡标CC-BY-SA-4.0。',
 '- 没有把random_words、random_tokens、random_bytes、run_on或普通语法错直接标成乱句；C4原发布需还原大语料，本轮改用可直接读取的小型公开英文增量。',
 '- 保护R3全部划分的文本，跨来源精确去重；英文以词集相似度合并近源家族后划分。新挑战与旧任意划分精确重叠为0。',
 '',
 '| 集合 | 正常 | 异常 | 上下文 |',
 '| --- | ---: | ---: | ---: |',
]
if 'training_validity' in result and not result['training_validity']['valid']:
    lines[2:2]=[
        '**数值验收未通过：本原始训练使用的DirectML非归约交叉熵反向有缺陷。以下模型只保留作故障复现，不用于部署。**',
        '前向loss正确、权重变化和非零梯度不能证明更新方向正确；本机完整梯度对照失败，样本权重/任务掩码未正确生效。',
        '因此不能根据这轮结果判断CSED辅助任务或公开语料的实际价值。已修复损失并在相同数据和参数下另目录重训。',
        '[最小复现](data/semantic-directml-loss-check.json)；[上游同类报告](https://github.com/microsoft/DirectML/issues/739)。',
        '',
    ]
if result.get('test_role')=='previously_opened_R4_regression':
    lines[0]='# 第四轮：修正DirectML损失后的同数据复验'
    lines[2:2]=[
        '**本次使用与原R4完全相同的数据、起点和超参数，仅修正损失的反向传播。原R4验收集已经打开，本次全部作为已知回归，不称新独立测试。**',
        '训练前通过真实多任务批次的CPU/DirectML完整梯度对照；原始错误路径及模型完整保留，未覆盖。',
        '[数值验收证据](data/semantic-directml-gradient-check.json)；[最小复现](data/semantic-directml-loss-check.json)。',
        '',
    ]
for split in ['cal','new_challenge','new_public_test','known_ime','known_round2','known_legacy']:
    c=manifest['counts'][split]
    lines.append(f"| {split} | {c.get('main:0',0)} | {c.get('main:1',0)} | {c.get('main:2',0)} |")
lines += [
 '',
 '新挑战为助手在预测前编写/冻结的85例；公开正常是银标，公开异常是算法生成，均不能称为独立人工金标。',
 'CSED辅助测试另保留2,000条，与乱句测试分开报告。',
 '',
 '训练：Ryzen7 8745H + Radeon780M，DirectML0.2.5.dev240914 / torch2.4.1，FP32全量反向。',
 '3epoch、3e-5、batch32、按长度分桶、最大128token，辅助损失权重0.25；主任务类别权重1.5/1/1.5。',
 '固定dense FP32等价AdamW已通过10步原版数值对照。每个epoch保存safetensors，再用原CPU环境导出和量化。',
 'CAL阈值沿用正常总体99%分位、各来源97.5%分位、上下文最大值及非负下限，严格大于才提示。',
 '选模依据CAL的英文/中文/混排异常宏平均召回，其次正常误报、更早epoch。选定及保存哈希后才打开新TEST。',
 '首轮CAL诊断发现少量中文/混排上下文抬高英文全局阈值，因此在TEST打开前另行封存分语言校准计划。',
 '该对照仍使用相同正常分位数与上下文零提示约束，只在en/zh/mixed各自CAL内计算；按相同CAL目标选epoch。原全局方案完整保留。',
 '',
 f"选中epoch **{selection['selected']['epoch']}**，阈值 **{selection['selected']['cal']['threshold']:.6f}**，训练/导出/CAL共 **{selection['total_seconds']:.1f}秒**。",
 f"INT8模型 **{selection['selected']['artifact_bytes']:,} bytes**，SHA-256 `{selection['checkpoint_sha256']}`。",
 f"分语言对照选中epoch{alternative['selection']['selected']['epoch']}，阈值{json.dumps(alternative['thresholds'],ensure_ascii=False)}。",
 '',
 '## 实测对照',
 '',
 '各项均为“提示数/该标签总数”；正常与上下文越低越好，异常越高越好。',
 '',
 '| 模型 | 新挑战正常 | 新挑战英文异常 | 新挑战混排异常 | 新挑战上下文 | 公开正常 | 公开英文乱序 |',
 '| --- | --- | --- | --- | --- | --- | --- |',
]
fmt=lambda v:f'{v[0]}/{v[1]}'
for name,c in result['configurations'].items():
    a=c['splits']['new_challenge']['metrics'];b=c['splits']['new_public_test']['metrics']
    lines.append(f"| {name} | {fmt(a['normal_false_positives'])} | {fmt(a['noise_languages']['en'])} | {fmt(a['noise_languages']['mixed'])} | {fmt(a['context_warnings'])} | {fmt(b['normal_false_positives'])} | {fmt(b['noise_detected'])} |")
lines += ['', '| 模型 | 已知R2正常 | 已知R2异常 | 已知R2英文异常 | 已知早期异常 | IME异常 | IME上下文 |',
          '| --- | --- | --- | --- | --- | --- | --- |']
for name,c in result['configurations'].items():
    a=c['splits']['known_round2']['metrics'];b=c['splits']['known_legacy']['metrics'];d=c['splits']['known_ime']['metrics']
    lines.append(f"| {name} | {fmt(a['normal_false_positives'])} | {fmt(a['noise_detected'])} | {fmt(a['noise_languages']['en'])} | {fmt(b['noise_detected'])} | {fmt(d['noise_detected'])} | {fmt(d['context_warnings'])} |")
lines += ['', '## 门槛与边界', '',
          '训练前设定的暂定门槛：原用户样例命中；已知正常零误报；新挑战正常/上下文各至多1次提示；',
          '新挑战英文、混排异常各召回≥60%；IME异常≥12/13且上下文≤1/6；已知R2异常≥19/40；',
          'INT8≤15MB、已知R2输入上Node p95≤15ms。不能把这些助手/银标样本上的门槛视为生产质量保证。', '',
          '| 检查 | 原全局校准 | 分语言校准 |', '| --- | --- | --- |']
for name,passed in gates.items():lines.append(f"| {name} | {'通过' if passed else '未通过'} | {'通过' if alternative_gates[name] else '未通过'} |")
lines += ['', f"暂定门槛整体：原全局 **{'通过' if all(gates.values()) else '未通过'}**，分语言 **{'通过' if all(alternative_gates.values()) else '未通过'}**。", '',
          f"用户原文提示：{original_predictions[0]['warning']}，分数{original_predictions[0]['score']:.4f}。",
          f"Node p95：{current['known_round2']['latency_p95_ms']:.2f}ms（仅Tensor构造和推理，不含分词/加载）。", '',
          '独立CSED辅助任务（有无语义病句，不是乱码检出率）：', '',
          '| 集合 | n | Accuracy | Balanced accuracy | MCC |', '| --- | ---: | ---: | ---: | ---: |']
for name,m in result['auxiliary_csed'].items():lines.append(f"| {name} | {m['n']} | {m['accuracy']:.4f} | {m['balanced_accuracy']:.4f} | {m['mcc']:.4f} |")
lines += ['', '实际GPU训练/导出信息：', '']
for h in selection['history']:
    lines.append(f"- epoch{h['epoch']}：GPU训练{h['training_seconds']:.1f}秒，最终参数有限；编码器权重变化{h['backbone_weight_max_delta']:.6g}；FP32导出最大差{h['fp32_export_max_drift']:.3g}；CAL异常{fmt(h['cal']['noise_detected'])}，正常{fmt(h['cal']['normal_false_positives'])}。")
lines += ['', f"捕获警告：{json.dumps(selection['warnings'],ensure_ascii=False)}。", '',
          '公开算法数据不能证明真实输入泛化；说话人隔离不等于已知跨说话人的对话关系完全独立，近源词集分组也不是完整来源追踪。',
          '统计置信区间见结果JSON，且不能补救银标或助手标签偏差。旧425/70/IME20已经打开，本轮均只称已知回归。',
          '本轮交付研究权重、数据清单、完整测量；插件运行代码没有变更。是否进入接入单元需结合全部退化和误报判断。', '',
          '## 复现', '', '```powershell',
          '& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-round4-data.py fetch',
          '& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-round4-data.py prepare',
          '& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-round4-language.py plan',
          '& .research/semantic-directml-venv/Scripts/python.exe tools/semantic-round4.py train',
          '& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-round4-language.py calibrate',
          '& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-round4.py evaluate',
          '& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-round4-language.py evaluate',
          '& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-round4-summary.py',
          '```', '',
          '数据/训练/测试步骤有覆盖保护，应使用保留的固定缓存；改变输入需新实验目录。',
          '结果：[data/semantic-round4-results.json](data/semantic-round4-results.json)；',
          '助手挑战原文与标签：[data/mixed-semantic-round4-seeds.json](data/mixed-semantic-round4-seeds.json)。',
          '公共原文和逐epoch权重保存在gitignored `.research/semantic-round4/`，结果JSON只保存预测、行号与来源，不重新分发公共原文。', '']
report_text='\n'.join(lines)
if result.get('test_role')=='previously_opened_R4_regression':
    report_text=report_text.replace('新挑战','R4挑战回归').replace('公开新测试','R4公开回归')
    report_text=report_text.replace('本轮交付研究权重','本次修复复验交付研究权重')
    report_text=report_text.replace('tools/semantic-round4.py train','tools/semantic-round4.py train --workdir .research/semantic-round4-fixed --loss manual')
    report_text=report_text.replace('data/semantic-round4-results.json','data/semantic-round4-fixed-results.json')
args.report.resolve().write_text(report_text,encoding='utf-8')
print(json.dumps({'selected_epoch':selection['selected']['epoch'],'gates':gates,'alternative_gates':alternative_gates,'artifact_bytes':selection['selected']['artifact_bytes'],
                  'metric_summary':{name:{s:v['metrics'] for s,v in c['splits'].items()} for name,c in result['configurations'].items()}},ensure_ascii=False))
