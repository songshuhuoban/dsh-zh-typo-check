"""Summarize the sealed binary adaptation and prospective results."""
import importlib.util
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('r12',ROOT/'tools/semantic-round12.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
d=r.read(r.WORK/'results.json');s=d['selection']['selected'];current=d['configurations']['selected']['splits']
isolated=r.read(r.WORK/'isolated-latency.json')
original=r.read(r.WORK/'selected-known_round2-scores.json')
assert max(abs(a-b) for a,b in zip(isolated['margins'],original['margins']))<1e-5
d['isolated_native_check']={'p95_ms':isolated['latency_p95_ms'],'p50_ms':isolated['latency_p50_ms'],
    'scores_max_abs_difference':max(abs(a-b) for a,b in zip(isolated['margins'],original['margins'])),
    'note':'Separate repeat after evaluation and CLI smoke both ended; includes tensor construction/session.run, excludes tokenizer/model load/UI.'}
r.save(r.WORK/'results.json',d);r.save(ROOT/'data/semantic-round12-results.json',d)
fmt=lambda pair:'/'.join(map(str,pair))
lines=['# 二分类整句目标与真实样本补训：第十二轮','',
    '2026-11-10，SIM-1047。出现局部改善，预设全部门槛未通过，未接入插件。','',
    '## 方法与数据角色','',
    '从R9合并小来源校准方案epoch1热启动，原中英文ELECTRA及RTD均读取整段输入，不拆中文片段。',
    '把正常0和上下文2合并为不应提示；用logsumexp(raw0,raw2)合并负类，和异常raw1计算二分类手写NLL。',
    '保留原三通道权重以热启动，但不再强制区分正常与上下文。输出raw1-logsumexp(raw0,raw2)，并非概率。',
    '原RTD方差改为中心化平方差，sqrt前至少1e-12，避免单token或空正文的零方差反向问题；所有对照均使用相同稳定特征。',
    '对照不再训练的二分类种子、只训134659参数头、再解冻中文最后两层共1714179参数。固定英文、RTD和归一化；编码器eval、头dropout0.1。',
    '头学习率0.0002，编码器0.00002，3轮比较1/3；正常/上下文旧TRAIN保留蒸馏，不向新004数据蒸馏旧错误。',
    '已知004批60条明确转TRAIN采样4次并退出TEST；TRAIN9457采样/8009唯一。其余CAL1670和已知测试保持不变，公开说话人隔离未破坏。',
    '沿用语言总体正常99%、来源正常>=101时独立99%、上下文最大值、最低0。按CAL最低语言召回、宏平均、少正常提示选择。',
    f"选{s['arm']} epoch{s['epoch']}，含共享词表{s['artifact_and_vocab_bytes']:,}字节（约27.43 MB），没有按TEST换模型或阈值。",'',
    '## 封存后的新样本','',
    '005：物理熵[124928,136206)产生60键串，记事本扫描码逐字、一次Space，全部提交、无排除；助手先标正常3/异常31/上下文26，再评分。',
    '公开200短口语：物理熵[147456,149952)无放回抽样中文100/英文40/混排60，全部来自旧TEST说话人，排除所有旧文本。先初标正常103/上下文97，再评分。',
    '两个过程均按归档uint16 LE LSB-first拒绝采样，无PRNG扩展，逐项重放一致；不重叠。RANDOM.ORG声明的大气物理熵原始响应完整保留，原始160000比特。',
    '标签均为助手初标，未独立人工复核；来源随机不决定语义标签。允许方言、专名、检索片段、感叹和口语修正保留上下文不确定性。','',
    '| 方案 | 新IME异常 | 新IME正常提示 | 新IME上下文提示 | 新公开正常提示 | 新公开上下文提示 |',
    '|---|---:|---:|---:|---:|---:|']
for name in ['r9_strict','r9_pooled','binary_seed','selected']:
    v=d['configurations'][name]['splits'];a=v['prospective_ime']['metrics'];b=v['prospective_public']['metrics']
    lines.append(f"| {name} | {fmt(a['noise_detected'])} | {fmt(a['normal_false_positives'])} | {fmt(a['context_warnings'])} | {fmt(b['normal_false_positives'])} | {fmt(b['context_warnings'])} |")
lines+=['',
    '相对R9合并方案，异常21/31→24/31（67.7%→77.4%），新公开正常1/103→0/103；实际上下文仍6/26，新公开上下文1/97→2/97。',
    '这支持局部召回提升，不能称全面降低误报。真实正常仅3条，公开正常103条，0次观察误报不代表真实总体误报为零。',
    '与R9严格方案相比，召回提高伴随真实上下文提示3/26→6/26，不隐去这个代价。新批次此后也只能作为已知回归。','',
    '## 全部已知回归','',
    '| 集合 | R9合并：正常/异常/上下文 | R12：正常/异常/上下文 |',
    '|---|---|---|']
for split,v in current.items():
    if split.startswith('prospective_'):continue
    a=d['configurations']['r9_pooled']['splits'][split]['metrics'];b=v['metrics']
    def cell(m):return '，'.join(fmt(m[k]) for k in ['normal_false_positives','noise_detected','context_warnings'])
    lines.append(f'| {split} | {cell(a)} | {cell(b)} |')
g=d['training']['gradient_preflight']['last2']['groups']
lines+=['',
    '旧公开正常误报6/506→7/506，旧新挑战异常24/30→19/30，均为实质回退；同时旧425异常31/40→33/40、正常2/365→3/365。',
    '公开英文word_soup仍28/28，原始问题句命中；正常混排API句和“嗯”本地CLI未提示。','',
    '## 数值检查与结论','',
    f"CPU/DirectML实际梯度相对L2误差：编码器{g['encoder']['relative_l2_error']:.8g}，头{g['head']['relative_l2_error']:.8g}；包含单token与空正文测试。",
    f"每轮冻结权重逐位不变，选定模型FP32导出最大差{s['fp32_export_max_drift']:.8g}。",
    f"完整评估后另单独复测旧425条，Node原生batch1 p95 {isolated['latency_p95_ms']:.3f}ms；分数与首次测量一致。公开长文本组首次p95 {current['new_public_test']['p95_ms']:.3f}ms，保留范围差异。",
    '预设新IME异常>=80%、正常0提示、上下文<=5%；新公开正常<=1%、上下文<=3%；同时检查旧集合、预算和15ms。真实异常、真实上下文及旧公开误报门槛失败，未推广。',
    '没有运行时/UI/驱动更改，没有staging部署或验收URL；本单元是研究制品。',
    f"模型SHA256：`{s['artifact_sha256']}`。阈值：`{s['thresholds']}`。",'',
    '## 复核入口','',
    '研究CPU环境运行tools/semantic-predict.py --model round12 --text "整句话"，完全本地，不发网络请求。',
    'data/semantic-round12-results.json保存选择、来源、分数、梯度和验收结果；data/semantic-round12-public-labels.json与data/ime-keyboard/assistant-labels-005.json含逐条理由。',
    '原始键串与实际输出：data/ime-keyboard/batch-005.json、notepad-batch-005.jsonl。训练：tools/semantic-round12.py；抽样与评估：tools/semantic-round12-fresh.py。','']
(ROOT/'REPORT-SEMANTIC-ROUND12.md').write_text('\n'.join(lines),encoding='utf-8')
with (ROOT/'NOTES.md').open('a',encoding='utf-8') as f:
    f.write('\n## 五十二、二分类整句补训与新独立测试（2026-11-10）\n\n'
        'SIM-1047：R9原RTD双语epoch1热启动，合并正常/上下文的二分类NLL，固定英文、对照只训头和中文末两层。\n'
        '004转TRAIN并退出TEST，9457采样/8009唯一；CAL选末层epoch1，含词表27433631bytes。\n'
        '新005实际60先初标正常3/异常31/上下文26；R12异常24/31、正常0/3、上下文6/26，R9合并21/31、0/3、6/26。\n'
        '新公开200初标正常103/上下文97；R12正常0/103、上下文2/97，R9合并1/103、1/97。\n'
        '旧公开误报6/506→7/506、旧新挑战异常24/30→19/30，仍有回退；预设质量门槛未全过，不接入插件。\n'
        '新物理熵键串[124928,136206)、公开抽样[147456,149952)，均回放通过，实际IME累计320。\n'
        '完整来源及回归见REPORT-SEMANTIC-ROUND12.md与data/semantic-round12-results.json，predict支持round12。\n')
print({'report':'REPORT-SEMANTIC-ROUND12.md','isolated_p95_ms':isolated['latency_p95_ms'],'all_gates_passed':d['all_gates_passed']})
