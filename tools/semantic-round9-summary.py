"""Summarize reviewed target supplementation, calibration ablation and fresh tests."""
from datetime import datetime,timezone
import importlib.util
import json
import math
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('r9',ROOT/'tools/semantic-round9.py')
r9=importlib.util.module_from_spec(spec);spec.loader.exec_module(r9)
WORK=r9.WORK;data,manifest=r9.frozen();result=r9.read(WORK/'results.json');pooled=r9.read(WORK/'pooled-results.json')
future=r9.read(WORK/'prospective-ime-results.json');config=result['configurations']|pooled['configurations']
source='女哦就是的感受a到啊删掉asd苏打粉二十个s收到'
original={name:next(p for r,p in zip(data['known_legacy'],c['splits']['known_legacy']['predictions']) if r['text']==source) for name,c in config.items()}
gates={}
for name in ['round9','round9_pooled']:
    splits=config[name]['splits'];old=splits['fresh_challenge']['metrics'];short=splits['new_short_test']['metrics'];actual=future['configurations'][name]['metrics']
    selection=result['selection']['selected'] if name=='round9' else pooled['selection']['selected']
    retained={'original':original[name]['warning'],'old_normals':sum(splits[k]['metrics']['normal_false_positives'][0] for k in ['known_round2','known_legacy'])==0,
        'old_challenge_normal':old['normal_false_positives'][0]<=1,'old_challenge_context':old['context_warnings'][0]<=1,
        'old_en_noise':old['noise_languages']['en'][0]>=9,'old_mixed_noise':old['noise_languages']['mixed'][0]>=9,
        'old_ime':splits['known_ime']['metrics']['noise_detected'][0]>=12,'old_noise':splits['known_round2']['metrics']['noise_detected'][0]>=19,
        'public_normal':splits['new_public_test']['metrics']['normal_false_positives'][0]<=5}
    fresh={'short_normal':short['normal_false_positives'][0]<=math.ceil(.01*short['normal_false_positives'][1]),
        'short_context':short['context_warnings'][0]<=math.ceil(.02*short['context_warnings'][1]),
        'actual_noise':actual['noise_detected'][0]>=math.ceil(.8*actual['noise_detected'][1]),
        'actual_normal':actual['normal_false_positives'][0]==0,'actual_context':actual['context_warnings'][0]<=1,
        'size':selection['artifact_and_vocab_bytes']<=50_000_000,'latency':splits['known_round2']['p95_ms']<=15}
    gates[name]={'retained':retained,'fresh_targets':fresh,'all_passed':all(retained.values()) and all(fresh.values())}
out={'generated_at_utc':datetime.now(timezone.utc).isoformat(),'issue':'SIM-1044','manifest':manifest,
    'primary_selection':result['selection'],'supplementary_calibration_plan':r9.read(WORK/'calibration-plan.json'),
    'pooled_selection':pooled['selection'],'training':result['training'],'configurations':config,'prospective_ime':future,
    'original':original,'gates':gates,'new_test_gate_plan':r9.read(WORK/'new-test-gate-plan.json'),
    'data_roles':{'batch002':'TRAIN','batch003':'CAL','batch004':'freshTEST at initial scoring; now opened'},
    'labels':'Assistant text labels, not independent human gold','prior_test_role':'known regression',
    'source_code_sha256':{p.name:r9.sha(p) for p in [ROOT/'tools/semantic-round9.py',ROOT/'tools/semantic-round9-calibration.py',ROOT/'tools/semantic-round9-data.py',ROOT/'tools/semantic-round9-ime.py',ROOT/'tools/ime-notepad-batch.py']}}
r9.save(ROOT/'data/semantic-round9-results.json',out)
fmt=lambda v:f'{v[0]}/{v[1]}'
names={'r6_original':'R6原阈值','r6_recalibrated':'R6扩充CAL严格阈值','r6_pooled':'R6合并小来源校准','round9':'R9补训/严格阈值','round9_pooled':'R9补训/合并小来源校准','r3_original':'R3中文基线'}
lines=['# 真实样本补训与独立留出：第九轮','',
    '2026-11-10，SIM-1044。目标是在50 MB模型/词表预算内降低正常和上下文误报，同时保持中英文异常检出。','',
    '**误报有所改善，但两套补训方案均未通过全部验收条件，尚不替换插件。**','',
    '## 数据与隔离','',
    '第二批40条实际IME输出明确转入TRAIN（重复4次），第三批40条转入CAL；不能再拿它们报告独立测试成绩。001批沿用原划分。',
    '从已缓存ASCEND新增500条短口语：200TRAIN、100CAL、200TEST，沿用说话人隔离，排除所有旧文本及新样本之间的精确重复。助手逐条读文本后标为可理解0或上下文2，没有把所有公开话轮自动当完整句子。',
    '另手工编写300条正常/上下文反例：180TRAIN、60CAL、60TEST，覆盖名称、口语、搜索、代码和技术混排；它们是人工构造，不是真实IME输出。',
    f"新TRAIN共420条唯一文本，正常212/异常25/上下文183；保留原8297条采样并加入新数据后，共{manifest['unique_train']}条唯一文本、{len(data['train'])}条采样。重复采样不计作新样本。",
    'CAL共1670条：正常1472/异常89/上下文109；新短句TEST共260条：正常123/上下文137，其中200条为公开真实口语、60条人工构造。',
    '新短句标签在拟合前冻结；新60条实际IME输出在两种模型选择均封存后采集，标签先于分数保存。全部标签为助手初标，未经独立人工复核。','',
    '## 模型与校准','',
    '从R6双模型第10轮MLP热启动，两个原始ELECTRA编码器及逐词判别头冻结，仅微调134659参数分类头。保留原TRAIN标准化参数，新增原TRAIN教师保留项，正常/上下文损失权重2，异常1。',
    '固定6轮、学习率0.0002，比较第1/3/6轮；CAL先最大化三个语言桶中最低异常检出率，再比较宏平均、正常提示数和较早轮次。',
    f"严格方案选第{result['selection']['selected']['epoch']}轮；保留每来源99%分位、语言总体99%、上下文最大值及最低0的原规则。",'',
    'CAL读数发现：对不超过100条正常样本的小来源组，99%分位的higher取法就是最大值。一个可理解但口语不流畅的句子“是天生的还是后他有锻炼”把中文阈值显著抬高。',
    '因此在任何TEST评分前，另封存校准对照：每来源正常样本至少101条时才独立约束；小组仍受语言总体99%与上下文最大值约束。原方案完整保留，没有看测试后改规则或标签。',
    f"该对照选第{pooled['selection']['selected']['epoch']}轮。两种候选均为{result['selection']['selected']['artifact_and_vocab_bytes']:,}字节（含词表，约27.43 MB）；一次部署选择一套，非把两套相加。",'',
    '## 新短句TEST：误报','',
    '| 方案 | 正常提示 | 上下文提示 |','|---|---:|---:|']
for name in ['r6_original','r6_recalibrated','r6_pooled','round9','round9_pooled']:
    m=config[name]['splits']['new_short_test']['metrics'];lines.append(f"| {names[name]} | {fmt(m['normal_false_positives'])} | {fmt(m['context_warnings'])} |")
lines+=['','## 新实际IME TEST','',
    '新60条字母串使用原始物理熵未用区间[98304,110754)，同一用户键频加权；逐字扫描码输入记事本，每条仅一次空格。60条均已提交，没有未完成候选或精确重叠排除。',
    '助手先标注正常2/异常37/上下文21。比喻、昵称、重复、代码和罕见词本身不作为乱码证据。','',
    '| 方案 | 正常提示 | 异常检出 | 上下文提示 |','|---|---:|---:|---:|']
for name in ['r3_original','r6_original','r6_recalibrated','r6_pooled','round9','round9_pooled']:
    m=future['configurations'][name]['metrics'];lines.append(f"| {names[name]} | {fmt(m['normal_false_positives'])} | {fmt(m['noise_detected'])} | {fmt(m['context_warnings'])} |")
lines+=['','严格补训方案减少误报，但召回仅14/37；较宽校准恢复到23/37，却仍有1条正常和5条上下文被提示。与相同新校准规则的旧模型比较，补训改善部分中文检出，但尚不能同时达到低误报和高召回。',
    '本批正常仅2条，不能据此推断总体误报率；公开/人工短句TEST与实际IME分布也不同。这里报告观察计数，不作总体风险保证。','',
    '## 已知回归','',
    '| 方案 | 既有挑战英文 | 既有挑战混排 | 旧425异常 | 旧425正常提示 | 旧IME异常 | 公开正常提示 |',
    '|---|---:|---:|---:|---:|---:|---:|']
for name in ['r6_original','r6_recalibrated','r6_pooled','round9','round9_pooled']:
    c=config[name]['splits'];m=c['fresh_challenge']['metrics'];lines.append(f"| {names[name]} | {fmt(m['noise_languages']['en'])} | {fmt(m['noise_languages']['mixed'])} | {fmt(c['known_round2']['metrics']['noise_detected'])} | {fmt(c['known_round2']['metrics']['normal_false_positives'])} | {fmt(c['known_ime']['metrics']['noise_detected'])} | {fmt(c['new_public_test']['metrics']['normal_false_positives'])} |")
lines+=['','这些旧测试均已打开，只能称已知回归。原始问题句在全部候选配置中都命中。','',
    '## 核显与数值核对','',
    f"Radeon 780M执行特征和分类头训练；torch-directml0.2.5.dev240914/torch2.4.1，损失使用已校验的手写NLL。实际目标CPU/DirectML最大梯度差{result['training']['gradient_preflight']['max_abs_error']:.8g}、相对L2差{result['training']['gradient_preflight']['relative_l2_error']:.8g}，特征最大差{result['training']['cpu_gpu_features_max_error']:.8g}。",
    'GPU输入校验包含单字和短词；FP32 ONNX导出对照包含短句、代码、单字等，最大误差均小于0.001。CAL和TEST都由Node ONNX INT8实际运行。',
    f"严格候选旧425推理p95 {config['round9']['splits']['known_round2']['p95_ms']:.3f} ms；合并小来源候选{config['round9_pooled']['splits']['known_round2']['p95_ms']:.3f} ms，均不含分词、模型载入和UI。",'',
    '## 原始随机数与采集','',
    '字母键串及公开样本选择分别使用物理熵[98304,110754)和[114688,121976)，未重用旧片段。原始RANDOM.ORG uint16响应、来源声明、哈希及范围保留；没有PRNG扩展。数据抽样已逐条精确回放核对。物理性来自服务方大气噪声声明，本机没有独立测量其硬件。',
    '首次启动遇到Windows后台前台激活限制，尚未发键即停止。采集器新增一次启动阶段输入线程关联，激活专用页后立即解除；每次发键前的前台/标题/编辑器/逃逸键检查保留，中途丢失焦点仍中止。锁屏不作强制恢复。',
    '该处理依据[AttachThreadInput文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-attachthreadinput)和[SetForegroundWindow限制](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)。本次原始采集记录了激活方式及采集器代码哈希。','',
    '## 验收与复现','']
for name,check in gates.items():
    lines.extend([f"### {names[name]}",''])
    lines.extend(f"- {kind}.{k}: {'通过' if v else '未通过'}" for kind in ['retained','fresh_targets'] for k,v in check[kind].items())
    lines.append('')
lines+=['本轮不修改插件UI、运行时或部署；研究制品没有staging验收URL。全部新测试此后均已打开，后续使用要标明已知回归或显式转移角色。',
    '本地试句：`python tools/semantic-predict.py --model round9 --text "整句话"`，或选择`round9-pooled`；需CPU研究环境和本机.research模型，分数不是校准概率。每个编码器上限128 tokens，本次集合没有截断。',
    '完整结果：data/semantic-round9-results.json；500条公开样本及理由：data/semantic-round9-public-candidates.json、data/semantic-round9-public-labels.json；人工反例：data/mixed-semantic-round9-seeds.json。',
    '实际原键串及输出：data/ime-keyboard/batch-004.json、notepad-batch-004.jsonl；标签与理由：assistant-labels-004.json。',
    '复现脚本：semantic-round9-data.py select/prepare；semantic-round9.py train/evaluate；semantic-round9-calibration.py plan/calibrate/evaluate；semantic-round9-ime.py assemble/evaluate；本summary脚本。',
    '公开来源：[ASCEND固定版本](https://huggingface.co/datasets/CAiRE/ASCEND/tree/737e9800ae31be9932ba8464c80366559bd28424)，CC-BY-SA4.0；文本抽取方式和模型来源沿用前轮报告。']
(ROOT/'REPORT-SEMANTIC-ROUND9.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
print(json.dumps({'gates':gates,'fresh_actual':{n:c['metrics'] for n,c in future['configurations'].items() if n in ['round9','round9_pooled']},'bytes':27430037},ensure_ascii=False))
