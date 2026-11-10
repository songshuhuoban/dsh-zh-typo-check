# 真实样本补训与独立留出：第九轮

2026-11-10，SIM-1044。目标是在50 MB模型/词表预算内降低正常和上下文误报，同时保持中英文异常检出。

**误报有所改善，但两套补训方案均未通过全部验收条件，尚不替换插件。**

## 数据与隔离

第二批40条实际IME输出明确转入TRAIN（重复4次），第三批40条转入CAL；不能再拿它们报告独立测试成绩。001批沿用原划分。
从已缓存ASCEND新增500条短口语：200TRAIN、100CAL、200TEST，沿用说话人隔离，排除所有旧文本及新样本之间的精确重复。助手逐条读文本后标为可理解0或上下文2，没有把所有公开话轮自动当完整句子。
另手工编写300条正常/上下文反例：180TRAIN、60CAL、60TEST，覆盖名称、口语、搜索、代码和技术混排；它们是人工构造，不是真实IME输出。
新TRAIN共420条唯一文本，正常212/异常25/上下文183；保留原8297条采样并加入新数据后，共7949条唯一文本、9217条采样。重复采样不计作新样本。
CAL共1670条：正常1472/异常89/上下文109；新短句TEST共260条：正常123/上下文137，其中200条为公开真实口语、60条人工构造。
新短句标签在拟合前冻结；新60条实际IME输出在两种模型选择均封存后采集，标签先于分数保存。全部标签为助手初标，未经独立人工复核。

## 模型与校准

从R6双模型第10轮MLP热启动，两个原始ELECTRA编码器及逐词判别头冻结，仅微调134659参数分类头。保留原TRAIN标准化参数，新增原TRAIN教师保留项，正常/上下文损失权重2，异常1。
固定6轮、学习率0.0002，比较第1/3/6轮；CAL先最大化三个语言桶中最低异常检出率，再比较宏平均、正常提示数和较早轮次。
严格方案选第6轮；保留每来源99%分位、语言总体99%、上下文最大值及最低0的原规则。

CAL读数发现：对不超过100条正常样本的小来源组，99%分位的higher取法就是最大值。一个可理解但口语不流畅的句子“是天生的还是后他有锻炼”把中文阈值显著抬高。
因此在任何TEST评分前，另封存校准对照：每来源正常样本至少101条时才独立约束；小组仍受语言总体99%与上下文最大值约束。原方案完整保留，没有看测试后改规则或标签。
该对照选第1轮。两种候选均为27,430,037字节（含词表，约27.43 MB）；一次部署选择一套，非把两套相加。

## 新短句TEST：误报

| 方案 | 正常提示 | 上下文提示 |
|---|---:|---:|
| R6原阈值 | 2/123 | 3/137 |
| R6扩充CAL严格阈值 | 0/123 | 1/137 |
| R6合并小来源校准 | 0/123 | 1/137 |
| R9补训/严格阈值 | 0/123 | 0/137 |
| R9补训/合并小来源校准 | 0/123 | 1/137 |

## 新实际IME TEST

新60条字母串使用原始物理熵未用区间[98304,110754)，同一用户键频加权；逐字扫描码输入记事本，每条仅一次空格。60条均已提交，没有未完成候选或精确重叠排除。
助手先标注正常2/异常37/上下文21。比喻、昵称、重复、代码和罕见词本身不作为乱码证据。

| 方案 | 正常提示 | 异常检出 | 上下文提示 |
|---|---:|---:|---:|
| R3中文基线 | 0/2 | 30/37 | 8/21 |
| R6原阈值 | 2/2 | 23/37 | 11/21 |
| R6扩充CAL严格阈值 | 1/2 | 13/37 | 3/21 |
| R6合并小来源校准 | 1/2 | 15/37 | 3/21 |
| R9补训/严格阈值 | 0/2 | 14/37 | 1/21 |
| R9补训/合并小来源校准 | 1/2 | 23/37 | 5/21 |

严格补训方案减少误报，但召回仅14/37；较宽校准恢复到23/37，却仍有1条正常和5条上下文被提示。与相同新校准规则的旧模型比较，补训改善部分中文检出，但尚不能同时达到低误报和高召回。
本批正常仅2条，不能据此推断总体误报率；公开/人工短句TEST与实际IME分布也不同。这里报告观察计数，不作总体风险保证。

## 已知回归

| 方案 | 既有挑战英文 | 既有挑战混排 | 旧425异常 | 旧425正常提示 | 旧IME异常 | 公开正常提示 |
|---|---:|---:|---:|---:|---:|---:|
| R6原阈值 | 15/15 | 13/15 | 33/40 | 3/365 | 10/13 | 4/506 |
| R6扩充CAL严格阈值 | 15/15 | 13/15 | 33/40 | 2/365 | 6/13 | 3/506 |
| R6合并小来源校准 | 15/15 | 13/15 | 35/40 | 3/365 | 7/13 | 4/506 |
| R9补训/严格阈值 | 15/15 | 12/15 | 24/40 | 2/365 | 8/13 | 1/506 |
| R9补训/合并小来源校准 | 15/15 | 13/15 | 31/40 | 2/365 | 10/13 | 6/506 |

这些旧测试均已打开，只能称已知回归。原始问题句在全部候选配置中都命中。

## 核显与数值核对

Radeon 780M执行特征和分类头训练；torch-directml0.2.5.dev240914/torch2.4.1，损失使用已校验的手写NLL。实际目标CPU/DirectML最大梯度差1.0728836e-06、相对L2差2.4143282e-07，特征最大差1.4305115e-05。
GPU输入校验包含单字和短词；FP32 ONNX导出对照包含短句、代码、单字等，最大误差均小于0.001。CAL和TEST都由Node ONNX INT8实际运行。
严格候选旧425推理p95 10.141 ms；合并小来源候选10.336 ms，均不含分词、模型载入和UI。

## 原始随机数与采集

字母键串及公开样本选择分别使用物理熵[98304,110754)和[114688,121976)，未重用旧片段。原始RANDOM.ORG uint16响应、来源声明、哈希及范围保留；没有PRNG扩展。数据抽样已逐条精确回放核对。物理性来自服务方大气噪声声明，本机没有独立测量其硬件。
首次启动遇到Windows后台前台激活限制，尚未发键即停止。采集器新增一次启动阶段输入线程关联，激活专用页后立即解除；每次发键前的前台/标题/编辑器/逃逸键检查保留，中途丢失焦点仍中止。锁屏不作强制恢复。
该处理依据[AttachThreadInput文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-attachthreadinput)和[SetForegroundWindow限制](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)。本次原始采集记录了激活方式及采集器代码哈希。

## 验收与复现

### R9补训/严格阈值

- retained.original: 通过
- retained.old_normals: 未通过
- retained.old_challenge_normal: 通过
- retained.old_challenge_context: 通过
- retained.old_en_noise: 通过
- retained.old_mixed_noise: 通过
- retained.old_ime: 未通过
- retained.old_noise: 通过
- retained.public_normal: 通过
- fresh_targets.short_normal: 通过
- fresh_targets.short_context: 通过
- fresh_targets.actual_noise: 未通过
- fresh_targets.actual_normal: 通过
- fresh_targets.actual_context: 通过
- fresh_targets.size: 通过
- fresh_targets.latency: 通过

### R9补训/合并小来源校准

- retained.original: 通过
- retained.old_normals: 未通过
- retained.old_challenge_normal: 未通过
- retained.old_challenge_context: 通过
- retained.old_en_noise: 通过
- retained.old_mixed_noise: 通过
- retained.old_ime: 未通过
- retained.old_noise: 通过
- retained.public_normal: 未通过
- fresh_targets.short_normal: 通过
- fresh_targets.short_context: 通过
- fresh_targets.actual_noise: 未通过
- fresh_targets.actual_normal: 未通过
- fresh_targets.actual_context: 未通过
- fresh_targets.size: 通过
- fresh_targets.latency: 通过

本轮不修改插件UI、运行时或部署；研究制品没有staging验收URL。全部新测试此后均已打开，后续使用要标明已知回归或显式转移角色。
本地试句：`python tools/semantic-predict.py --model round9 --text "整句话"`，或选择`round9-pooled`；需CPU研究环境和本机.research模型，分数不是校准概率。每个编码器上限128 tokens，本次集合没有截断。
完整结果：data/semantic-round9-results.json；500条公开样本及理由：data/semantic-round9-public-candidates.json、data/semantic-round9-public-labels.json；人工反例：data/mixed-semantic-round9-seeds.json。
实际原键串及输出：data/ime-keyboard/batch-004.json、notepad-batch-004.jsonl；标签与理由：assistant-labels-004.json。
复现脚本：semantic-round9-data.py select/prepare；semantic-round9.py train/evaluate；semantic-round9-calibration.py plan/calibrate/evaluate；semantic-round9-ime.py assemble/evaluate；本summary脚本。
公开来源：[ASCEND固定版本](https://huggingface.co/datasets/CAiRE/ASCEND/tree/737e9800ae31be9932ba8464c80366559bd28424)，CC-BY-SA4.0；文本抽取方式和模型来源沿用前轮报告。
