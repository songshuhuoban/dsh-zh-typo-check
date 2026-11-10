# 预训练逐词判别头：第六轮整句实验

2026-11-10，SIM-1041。用户确认离线模型加词表不超过50 MB（按50,000,000字节验收）。

**整体门槛未通过，保留研究对照，尚不能替换插件。**

## 方法与隔离

保留原始ELECTRA的编码器及逐词替换判别头，全部冻结。每个编码器都读取整段输入，不截取中文段。
把CLS、正文平均向量和12个逐词统计量合为524维特征；双模型拼接1048维。仅训练128维MLP三分类头。
标准化仅拟合TRAIN；训练10轮，事先固定比较第1/3/10轮。校准集按英语/中文/混排分别约束正常99%分位、各正常类别99%分位及上下文最大值，零为最低阈值，严格大于才提示。
与R5相同的7529条唯一TRAIN文本、8297个采样条目，CAL1470条；不加入新训练样本。双模型和单模型分别按CAL语言宏平均检出率选轮次，再在体积预算内选方案。
此前R3/R4/R5测试全部只作已知回归。新真实IME输出在模型和阈值封存之后采集，助手先逐条标注，再计算分数；没有按新测试结果调整阈值或标签。

校准集选择：dual，第10轮，模型27,088,989字节，加词表27,430,037字节。
封存UTC：2026-11-09T16:49:33.527213+00:00；INT8 SHA256：`a4d139cb8af1e9c336dbc748e14813e42d0377b7875284a2d0ffbc7eba83c4b2`。

## 已知回归结果

分子/分母；正常栏表示被提示数，异常栏表示被检出数。公开正常是银标，其他多为助手标签。

| 方案 | R5英文异常 | R5混排异常 | 公开正常误报 | 英文word soup | 旧425异常 | 旧IME异常 | 原输入 |
|---|---:|---:|---:|---:|---:|---:|---|
| round3 | 1/15 | 6/15 | 76/506 | 2/28 | 19/40 | 12/13 | 命中 |
| round5 | 5/15 | 7/15 | 15/506 | 12/28 | 15/40 | 9/13 | 命中 |
| zh | 6/15 | 13/15 | 0/506 | 17/28 | 11/40 | 12/13 | 命中 |
| dual | 15/15 | 13/15 | 4/506 | 28/28 | 33/40 | 10/13 | 命中 |

双模型明显改善英文及部分混排，但旧425正常误报3/365、旧70正常误报2/45、R5挑战正常误报2/50，旧IME正常1/1被误报，异常仅10/13。
因此不能仅凭异常召回提升选为产品模型。完整正常、上下文及分语言计数见data/semantic-round6-results.json；R5挑战本轮属于已知回归，不能称新盲测。

## 新真实输入法盲测

40条键串沿用用户两段随机敲键的频率，未见字母权重为一次观测字母的1/10，每四条一条含原样例标点。
使用同一归档RANDOM.ORG大气噪声响应中的未用比特[73728,82407)，无PRNG扩展；此前用到72280，中间1448位明确跳过。原始响应及SHA保留。
原始物理性依据是服务方大气噪声来源声明，本机没有独立测量其硬件熵源。
脚本用扫描码逐字输入专用记事本页，每条按一次空格、等待700ms读取可见编辑器；记录Escape前后并剔除未提交候选。
纳入40条；排除0条，原因完整保存在JSON。随机来源不决定标签，标签由整句可理解性判定，未经独立人工复核。

| 方案 | 正常误报 | 异常检出 | 上下文提示 |
|---|---:|---:|---:|
| round3 | 1/3 | 20/25 | 4/12 |
| round5 | 0/3 | 15/25 | 3/12 |
| zh | 1/3 | 14/25 | 4/12 |
| dual | 1/3 | 15/25 | 5/12 |

同一敲键画像、同一IME且只有40条，不能据此推断真实用户总体误报率或泛化边界。
原键串、一次空格实际输出：data/ime-keyboard/notepad-batch-002.jsonl；逐条标签及理由：data/ime-keyboard/assistant-labels-002.json。

## 核显、导出与体积

Radeon 780M，torch-directml 0.2.5.dev240914。原始逐词特征CPU/核显最大差：5.9604645e-06。
训练使用已通过CPU梯度核对的手写log-softmax/one-hot NLL，避开已确认错误的DirectML stock CE reduction=none反传。
首次导出的字段位置映射错误被FP32一致性断言拦住，失败ONNX单独保留；显式按模型参数顺序导出后重新比较，没有放宽一致性阈值。
最终每个候选的FP32导出差、INT8哈希、版本、截断计数、CAL选择及核显分类头梯度前置检查均已留存。
所选模型旧425集合Node ONNX batch1推理p95 10.087 ms，不含分词、模型载入和UI。

## 验收检查

- original: 通过
- old_normals: 未通过
- r5_challenge_normal: 未通过
- r5_challenge_context: 通过
- r5_challenge_en_noise: 通过
- r5_challenge_mixed_noise: 通过
- old_ime: 未通过
- old_noise: 通过
- public_normal: 通过
- size: 通过
- latency: 通过

本轮是研究制品，不含插件运行时代码、界面或发布，不存在staging验收URL。原插件的混排跳过问题仍待采用可靠整句策略后一并修复。

## 复现与来源

运行tools/semantic-round6.py prepare/train/export/evaluate及tools/semantic-round6-ime.py generate/assemble/evaluate；TRAIN用DirectML隔离环境，导出与评分用CPU环境，summary生成此报告。
原始键串采集：tools/ime-notepad-batch.py --batch data/ime-keyboard/batch-002.json --output 新路径。已存在的原始采集和封存文件不得覆盖。
[Transformers ELECTRA文档](https://huggingface.co/docs/transformers/v4.57.3/en/model_doc/electra)解释替换词判别任务；逐词替换分数不是整句语义错误概率。
[HFL中文模型](https://huggingface.co/hfl/chinese-electra-180g-small-discriminator)，版本826a243f3f387450ef8d70de9c3d0706d8d8e924。
[Google英文模型](https://huggingface.co/google/electra-small-discriminator)，版本fa8239aadc095e9164941d05878b98afe9b953c3。
[DirectML相关公开梯度问题](https://github.com/microsoft/DirectML/issues/739)；本机同checkpoint完整梯度证据见data/semantic-directml-gradient-check.json。
