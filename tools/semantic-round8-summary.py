"""Report the predeclared CAL-only late-fusion screen, without relabelling tests."""
from datetime import datetime,timezone
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('r8',ROOT/'tools/semantic-round8.py')
r8=importlib.util.module_from_spec(spec);spec.loader.exec_module(r8)
WORK=r8.WORK;data,manifest=r8.frozen();result=r8.read(WORK/'results.json');s=result['selection'];current=result['splits']
result.update(generated_at_utc=datetime.now(timezone.utc).isoformat(),issue='SIM-1043',
    native_helper_sha256=r8.sha(ROOT/'tools/semantic-fusion-native.mjs'),
    local_probe_sha256=r8.sha(ROOT/'tools/semantic-predict.py'))
r8.save(ROOT/'data/semantic-round8-results.json',result)
fmt=lambda v:f'{v[0]}/{v[1]}'
lines=['# 50 MB内的整句分数融合：第八轮初筛','',
    '2026-11-10，SIM-1043。用户确认模型及词表合计不超过50,000,000字节。','',
    '**既定回归门槛未通过，本候选不接入插件。**' if not result['all_gates_passed'] else '**已通过初筛，仍须另采新留出集。**','',
    '## 方法','',
    '冻结R3中文整句分类器与R6原始逐词判别双模型，总计三个小编码器；每个编码器均读取整段输入。没有分割中文段，也不跳过混排。',
    '分别取异常相对正常/上下文的原始边际分数，除以各自唯一TRAIN样本上的总体标准差；不减均值。',
    '融合分数为(1-alpha)*R3/scale3 + alpha*R6/scale6。预先固定alpha=[0,0.25,0.5,0.75,1]，按英语/中文/混排在CAL内独立选择。',
    '阈值沿用R6正常及每正常来源99%分位、上下文最大值、最低0，严格大于才提示；同检出率优先更少正常误报，再优先alpha接近0.5、较小alpha。',
    '没有新编码器训练、增添训练样本或使用TEST分数选择权重。CAL选择封存后，才读取各已知回归的原始分数。',
    '**包括002/003真实IME在内，本轮所有结果均为已知回归，不是新的盲测。**',
    '事先设置了继续条件：只有全部既定回归检查通过，才另采40条新真实IME；本次未通过，因此未消耗新随机数或采集新留出。','',
    f"模型加共享词表共{manifest['artifact_and_shared_vocab_bytes']:,}字节（约{manifest['artifact_and_shared_vocab_bytes']/1e6:.2f} MB）。中文词表共用一份。",
    f"TRAIN分数标准差：R3={s['scales'][0]:.8g}，R6={s['scales'][1]:.8g}；封存UTC：{s['sealed_at_utc']}。",'',
    '| 语言 | R6权重alpha | 融合阈值 |', '|---|---:|---:|']
for lang,v in s['selected'].items():lines.append(f"| {lang} | {v['alpha']} | {v['threshold']:.8g} |")
lines+=['','## 已知回归','',
    '| 集合 | 正常误报 | 异常检出 | 上下文提示 |','|---|---:|---:|---:|']
for split,c in current.items():
    m=c['metrics'];lines.append(f"| {split} | {fmt(m['normal_false_positives'])} | {fmt(m['noise_detected'])} | {fmt(m['context_warnings'])} |")
new=[current[k]['metrics'] for k in ['known_round6_ime','known_round7_ime']]
noise=[sum(m['noise_detected'][i] for m in new) for i in [0,1]]
normal=[sum(m['normal_false_positives'][i] for m in new) for i in [0,1]]
context=[sum(m['context_warnings'][i] for m in new) for i in [0,1]]
lines+=['',f"两批真实IME合并：异常{fmt(noise)}、正常误报{fmt(normal)}、上下文提示{fmt(context)}。原始问题句仍命中。",
    '融合改善异常召回，却放大了部分上下文提示，不能只凭召回或体积符合预算决定接入。正常样本合计仅5条，不能推算真实用户总体误报率。',
    '公开正常为银标，其他多为助手标签；两批实际输出标签均先于对应首次评分保存，未经独立人工复核。','',
    '## 实际运行检查','',
    f"在同一Node进程顺序执行两个ONNX会话，旧425条batch1实测p50 {result['native_latency']['latency_p50_ms']:.3f} ms、p95 {result['native_latency']['latency_p95_ms']:.3f} ms；不含分词、载入和UI。",
    f"组合会话分数与此前归档独立会话分数最大差{result['cached_score_vs_combined_native_max_drift']:.8g}，通过1e-5核对。",
    '这里测量实际连续执行耗时，没有把两个分别测得的p95相加。英文alpha=1时仍按完整双会话测量，本初筛未优化零权重分支。','',
    '## 保留的验收条件','']
lines.extend(f"- {k}: {'通过' if v else '未通过'}" for k,v in result['gates'].items())
lines+=['','下一项技术工作是补充目标分布的真实正常口语、名称、检索片段及对应异常训练，重新分组并建立新留出；不能把已看过的200条实际输出再次称作新测试。',
    '本轮没有修改插件运行时、UI、部署或输入拦截行为，研究制品没有staging验收URL。','',
    '## 本地试用与证据','',
    '在本机CPU研究环境运行：', '', '```powershell',
    '.research/semantic-screen-venv/Scripts/python.exe tools/semantic-predict.py --model round8 --text "女哦就是的感受a到啊删掉asd苏打粉二十个s收到"',
    '```','',
    '也可选择round3、round6或round7；依赖本机.research内封存制品和本地词表，不发送网络请求。结果为研究边际分数，不是校准概率，也不是已发布插件。',
    '完整选择、权重、模型哈希、所有回归结果、来源哈希：data/semantic-round8-results.json。',
    '脚本：tools/semantic-round8.py prepare/calibrate/evaluate，tools/semantic-fusion-native.mjs，tools/semantic-round8-summary.py。',
    '002/003实际键串、输出及逐条标签：data/ime-keyboard/。原始熵及先前版本来源见[第六轮](REPORT-SEMANTIC-ROUND6.md)、[第七轮](REPORT-SEMANTIC-ROUND7.md)。']
(ROOT/'REPORT-SEMANTIC-ROUND8.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
print(json.dumps({'bytes':manifest['artifact_and_shared_vocab_bytes'],'gates_passed':result['all_gates_passed'],
    'real_ime_noise':noise,'real_ime_normal_fp':normal,'real_ime_context':context,'new_entropy_consumed':0}))
