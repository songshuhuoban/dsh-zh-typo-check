"""R3-preserving initialization experiment, including separate new IME cohort."""
from datetime import datetime,timezone
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('r7',ROOT/'tools/semantic-round7.py')
r7=importlib.util.module_from_spec(spec);spec.loader.exec_module(r7)
WORK=r7.WORK;data,manifest=r7.frozen();result=r7.read(WORK/'results.json')
future=r7.read(WORK/'prospective-ime-results.json');sel=result['selection'];chosen=sel['selected'];current=result['splits']
r5=r7.read(ROOT/'.research/semantic-round5/results.json')['configurations']
r6=r7.read(ROOT/'.research/semantic-round6/results.json')['configurations']['dual']['splits']
source='女哦就是的感受a到啊删掉asd苏打粉二十个s收到'
original=next(p for row,p in zip(data['known_legacy'],current['known_legacy']['predictions']) if row['text']==source)
fresh=current['fresh_challenge']['metrics']
gates={'original':original['warning'],'old_normals':sum(current[k]['metrics']['normal_false_positives'][0] for k in ['known_round2','known_legacy'])==0,
    'r5_challenge_normal':fresh['normal_false_positives'][0]<=1,'r5_challenge_context':fresh['context_warnings'][0]<=1,
    'r5_challenge_en_noise':fresh['noise_languages']['en'][0]>=9,'r5_challenge_mixed_noise':fresh['noise_languages']['mixed'][0]>=9,
    'old_ime':current['known_ime']['metrics']['noise_detected'][0]>=12,
    'old_noise':current['known_round2']['metrics']['noise_detected'][0]>=19,
    'public_normal':current['new_public_test']['metrics']['normal_false_positives'][0]<=5,
    'size':chosen['artifact_and_vocab_bytes']<=50_000_000,'latency':current['known_round2']['p95_ms']<=15}
result.update(generated_at_utc=datetime.now(timezone.utc).isoformat(),issue='SIM-1042',gates=gates,
    all_gates_passed=all(gates.values()),original=original,prospective_ime=future,
    prior_test_role='All preceding evaluation cohorts including batch002 are known regressions; not fresh holdouts.')
r7.save(ROOT/'data/semantic-round7-results.json',result)
fmt=lambda v:f'{v[0]}/{v[1]}'
lines=['# 保留中文基座并加入英文特征：第七轮','',
    '2026-11-10，SIM-1042。模型加词表预算50,000,000字节。','',
    '**整体门槛未通过，本轮候选淘汰，不替换插件。**' if not all(gates.values()) else '**全部既定门槛通过。**','',
    '## 方案','',
    '冻结R3中文编码器和原分类头；加入原始英文ELECTRA的整句向量和逐词替换统计。两个编码器都读取整段输入。',
    '1036维特征接128维残差MLP，最后一层零初始化，初始输出逐位等于R3原始PyTorch输出。只优化残差参数。',
    '知识保留损失仅用于原R3正常/上下文TRAIN，强度0.5和2.0；异常训练不受原模型教师约束。10轮固定比较第1/3/10轮。',
    '复用R5的7529条唯一TRAIN/8297采样条目、CAL1470；不把第二批40条IME加入训练。缓存按相同文本顺序和来源哈希核对。',
    'CAL阈值和选择规则沿用R6，按语言计算正常及每来源99%分位、上下文最大值，最低0，严格大于提示；按CAL语言宏平均检出率选候选。',
    'R3/R4/R5/R6所有已打开集合只作已知回归。第三批真实IME输出在本轮模型封存后采集，先标注、后评分。','',
    f"选择{chosen['tag']}，第{chosen['epoch']}轮；模型{chosen['artifact_bytes']:,}字节，含词表{chosen['artifact_and_vocab_bytes']:,}字节。",
    f"封存UTC：{sel['sealed_at_utc']}；SHA256：`{chosen['artifact_sha256']}`。",'',
    '## 已知回归','',
    '| 方案 | R5英文异常 | R5混排异常 | R5正常误报 | 公开正常误报 | 旧425异常 | 旧425正常误报 | 旧IME异常 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|']
for name,c in [('R3',r5['round3']['splits']),('R5',r5['round5']['splits']),('R6双模型',r6),('R7',current)]:
    a=c['fresh_challenge']['metrics'];b=c['known_round2']['metrics']
    lines.append(f"| {name} | {fmt(a['noise_languages']['en'])} | {fmt(a['noise_languages']['mixed'])} | {fmt(a['normal_false_positives'])} | {fmt(c['new_public_test']['metrics']['normal_false_positives'])} | {fmt(b['noise_detected'])} | {fmt(b['normal_false_positives'])} | {fmt(c['known_ime']['metrics']['noise_detected'])} |")
m=current['known_round6_ime']['metrics']
lines+=['',f"R7在第二批已知IME上：异常{fmt(m['noise_detected'])}，正常误报{fmt(m['normal_false_positives'])}，上下文提示{fmt(m['context_warnings'])}。",
    '原始问题句仍命中。正常和上下文误报减少，但中文异常召回明显损失；零初始化只保证训练起点相同，不能保证训练后能力保留。','',
    '## 第三批真实IME盲测','',
    '40条新键串使用归档物理熵的未用区间[86016,94544)，不使用PRNG；第二批结束82407，中间3609位跳过。原始uint16响应、来源声明、哈希和键串逐行比特区间均保留。',
    '物理性依据RANDOM.ORG大气噪声来源声明，本机没有独立测量服务方硬件。',
    '同一键频分布及豆包输入法，记事本扫描码逐字输入、每条一次空格。初次采集遇到Windows默认锁屏界面，保护在发键前终止；用户解锁后从未完成项恢复，未覆盖旧输出。',
    f"实际纳入{len(future['provenance']['rows'])}条，排除{len(future['provenance']['excluded'])}条；助手先逐条标注并写出理由，再评分，未经独立人工复核。",'',
    '| 方案 | 正常误报 | 异常检出 | 上下文提示 |','|---|---:|---:|---:|']
for name,c in future['configurations'].items():
    m=c['metrics'];lines.append(f"| {name} | {fmt(m['normal_false_positives'])} | {fmt(m['noise_detected'])} | {fmt(m['context_warnings'])} |")
lines+=['','同一键频和输入法、每批40条、助手标签只能作为有限留出证据；不能推断真实用户总体误报率。高置信子集和全部逐条结果保存在JSON，未以测试结果调标签或阈值。','',
    '## 数值与运行核对','',
    f"AMD Radeon 780M，安全手写NLL，真实残差目标CPU/DirectML梯度核对通过。组合特征最大差{result['training']['cpu_gpu_features_max_error']:.8g}；缓存特征与当前CPU路径最大差{result['training']['cached_feature_error']:.8g}。",
    '所有候选FP32 ONNX导出误差小于0.001；实际值、INT8哈希、核显梯度误差、固定数据哈希和CAL选择均保留。',
    f"Node ONNX batch1旧425推理p95 {current['known_round2']['p95_ms']:.3f} ms，不含分词、模型载入及UI。",'',
    '## 既定验收','']
lines.extend(f"- {key}: {'通过' if value else '未通过'}" for key,value in gates.items())
lines+=['','新增本地研究试用入口tools/semantic-predict.py，校验选定模型哈希后使用本地分词器与Node ONNX评分，不发网络请求。',
    '用CPU研究环境运行：`python tools/semantic-predict.py --model round6 --text "要检查的整句话"`；也可选round3或round7。',
    '当前脚本依赖本机.research模型制品，不是可直接发布的插件运行时。模型分数不是校准的概率。',
    '运行时、UI、生产和staging均未修改；本轮是研究制品，没有staging验收URL。',
    '真实IME补充训练、正常及上下文覆盖仍是后续工作；现有模型尚不适合自动拦截用户输入。','',
    '原始输出：data/ime-keyboard/notepad-batch-003.jsonl；标签理由：data/ime-keyboard/assistant-labels-003.json；完整结果：data/semantic-round7-results.json。',
    '复现：tools/semantic-round7.py prepare/train/export/evaluate，tools/semantic-round7-ime.py assemble/evaluate，最后运行本summary脚本。',
    '来源与版本沿用[第六轮报告](REPORT-SEMANTIC-ROUND6.md)；英文[Google ELECTRA](https://huggingface.co/google/electra-small-discriminator)读取整句。']
(ROOT/'REPORT-SEMANTIC-ROUND7.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
print(json.dumps({'chosen':chosen['tag'],'bytes':chosen['artifact_and_vocab_bytes'],'gates':gates,
    'new_ime':future['configurations']['round7']['metrics'],'original':original},ensure_ascii=False))
