"""Frozen-backbone trial report, with all failures and physical-data provenance."""
from datetime import datetime,timezone
import json
from pathlib import Path
import hashlib

ROOT=Path(__file__).resolve().parents[1];WORK=ROOT/'.research/semantic-round5'
data=json.loads((WORK/'prepared.json').read_bytes());r=json.loads((WORK/'results.json').read_bytes())
s=r['selection'];m=r['manifest'];current=r['configurations']['round5']['splits']
for split,rows in data.items():assert hashlib.sha256(json.dumps(rows,ensure_ascii=False,sort_keys=True).encode()).hexdigest()==m['split_hashes'][split]
assert hashlib.sha256((WORK/s['selected']['artifact']).read_bytes()).hexdigest()==s['checkpoint_sha256']
source='女哦就是的感受a到啊删掉asd苏打粉二十个s收到'
original=next(p for row,p in zip(data['known_legacy'],current['known_legacy']['predictions']) if row['text']==source)
fresh=current['fresh_challenge']['metrics']
gates={'original':original['warning'],'old_normals':sum(current[k]['metrics']['normal_false_positives'][0] for k in ['known_round2','known_legacy'])==0,
       'fresh_normal':fresh['normal_false_positives'][0]<=1,'fresh_context':fresh['context_warnings'][0]<=1,
       'fresh_en_noise':fresh['noise_languages']['en'][0]>=9,'fresh_mixed_noise':fresh['noise_languages']['mixed'][0]>=9,
       'old_ime':current['known_ime']['metrics']['noise_detected'][0]>=12,'old_noise':current['known_round2']['metrics']['noise_detected'][0]>=19,
       'public_normal':current['new_public_test']['metrics']['normal_false_positives'][0]<=5,
       'size':s['selected']['artifact_bytes']<=15000000,'latency':current['known_round2']['p95_ms']<=15}
aug=json.loads((ROOT/'data/semantic-round5-augmentation.json').read_bytes())
r.update(generated_at_utc=datetime.now(timezone.utc).isoformat(),issue='SIM-1040',gates=gates,all_gates_passed=all(gates.values()),original=original,
         physical_augmentation={'entropy_start':aug['entropy_bit_start'],'entropy_end':aug['entropy_bit_end'],'rows':80,
         'source_sha256':aug['raw_entropy_sha256'],'labels':'assistant high-confidence, not independently reviewed','not_real_ime_capture':True})
(ROOT/'data/semantic-round5-results.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
f=lambda v:f'{v[0]}/{v[1]}'
lines=['# 冻结骨干与小分类头：第五轮','',
'2026-11-10，SIM-1040。目标是在减少正常混排误报的同时保留旧检出，并补功能词密集乱句。',
'**固定三轮试验完成，整体门槛未通过，保留为研究对照。**','',
'## 方法','',
'R3编码器与原分类头完全冻结，零初始化残差MLP，只训练66,051个参数。每个epoch保存后逐张量核对原始参数，全部逐位不变。',
'训练复用R4主任务，移除本轮无效的CSED辅助任务；新增80条人工构造功能词/助词扰动及70条正常反例/上下文。',
'随机扰动使用归档RANDOM.ORG物理熵位区间[32768,72280)，此前仅用到27684，中间5084位明确跳过；没有PRNG扩展。',
'英文词/中文助词按原正常训练文本的频数加权抽样，另插入技术词；这是辅助人工分布，**不是新的键盘/输入法实测输出**。',
'助手逐条查看80条输出后初标为明显异常，每条有理由；原始输出、随机比特区间与标签分开保存，未经独立人工复核。',
f"共{m['unique_train']}条唯一训练文本、{len(data['train'])}个采样条目。新增随机样本重复4次，仍只计80条。",
'原R4全部集合只称已知回归，另在预测前冻结95条新助手挑战（正常50、英文异常15、混排异常15、上下文15）。',
'所有跨集合精确归一化文本去重，新挑战排除旧任意集合及旧训练文本；模型输入均≤128token，无截断。','',
'DirectML安全手工NLL；AdamW 0.001、batch128、3epoch、旧训练样本软目标权重0.5/温度2，残差L2权重0.001。',
'GPU缓存冻结特征，只对小头求导。新头的实际目标先做CPU/DirectML梯度对照；实际Node INT8 CAL分语言选阈值，按噪声宏召回、正常误报、较早epoch选模型。',
f"总耗时{s['total_seconds']:.2f}秒（含特征缓存、三轮导出和CAL），小头各轮训练秒数：{[round(h['head_training_seconds'],3) for h in s['history']]}。",
f"选epoch{s['selected']['epoch']}，模型{s['selected']['artifact_bytes']:,}bytes；SHA-256 `{s['checkpoint_sha256']}`。",
f"阈值：{s['selected']['thresholds']}；捕获警告：{s['warnings']}。",'',
'## 实测','',
'正常/上下文为提示数（越低越好）；异常为检出数（越高越好）。','',
'| 模型 | 新正常 | 新英文异常 | 新混排异常 | 新上下文 | 已知公开正常 | 已知公开英文乱序 |',
'| --- | --- | --- | --- | --- | --- | --- |']
for name,c in r['configurations'].items():
 a=c['splits']['fresh_challenge']['metrics'];b=c['splits']['new_public_test']['metrics']
 lines.append(f"| {name} | {f(a['normal_false_positives'])} | {f(a['noise_languages']['en'])} | {f(a['noise_languages']['mixed'])} | {f(a['context_warnings'])} | {f(b['normal_false_positives'])} | {f(b['noise_detected'])} |")
lines+=['','| 模型 | 旧R2正常 | 旧R2异常 | 旧R2混排异常 | IME异常 | 旧R4挑战 |','| --- | --- | --- | --- | --- | --- |']
for name,c in r['configurations'].items():
 a=c['splits']['known_round2']['metrics'];b=c['splits']['known_ime']['metrics'];d=c['splits']['new_challenge']['metrics']
 lines.append(f"| {name} | {f(a['normal_false_positives'])} | {f(a['noise_detected'])} | {f(a['noise_languages']['mixed'])} | {f(b['noise_detected'])} | {f(d['noise_detected'])} |")
lines+=['',f"原用户输入提示={original['warning']}，已知R2输入的Node p95={current['known_round2']['p95_ms']:.2f}ms，不含加载和分词。",'',
'冻结骨干没有保证旧留出集检出不退化：分类头与校准仍会改变边界。新挑战有改善，但英文/混排召回不足，公开正常误报仍偏高，IME和旧异常检出下降。',
'新数据全部是助手标签或公开银标；人工挑选的功能词池不代表真实键盘、用户口语或自然异常分布。不能把新增80条当作80条真实IME采集，也不能把重复采样计为新增样本。','',
'## 产物','',
'- [物理熵扰动与位区间](data/semantic-round5-augmentation.json)、[逐条初标](data/semantic-round5-labels.json)。',
'- [正常反例与挑战](data/mixed-semantic-round5-seeds.json)、[结果及预测](data/semantic-round5-results.json)。',
'- 权重、冻结特征、每轮模型和原始日志在`.research/semantic-round5/`，不覆盖旧产物。',
'- 脚本：tools/semantic-round5-data.py、tools/semantic-round5.py；先generate/标注/prepare，再train/evaluate/summary，各阶段有覆盖保护。','',
'本单元交付数据、模型和验证报告，没有修改运行插件、产品UI或发布部署。','']
(ROOT/'REPORT-SEMANTIC-ROUND5.md').write_text('\n'.join(lines),encoding='utf-8')
print(json.dumps({'gates':gates,'original':original,'bytes':s['selected']['artifact_bytes'],'p95_ms':current['known_round2']['p95_ms']}))
