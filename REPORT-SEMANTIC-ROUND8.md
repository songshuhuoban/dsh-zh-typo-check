# 50 MB内的整句分数融合：第八轮初筛

2026-11-10，SIM-1043。用户确认模型及词表合计不超过50,000,000字节。

**既定回归门槛未通过，本候选不接入插件。**

## 方法

冻结R3中文整句分类器与R6原始逐词判别双模型，总计三个小编码器；每个编码器均读取整段输入。没有分割中文段，也不跳过混排。
分别取异常相对正常/上下文的原始边际分数，除以各自唯一TRAIN样本上的总体标准差；不减均值。
融合分数为(1-alpha)*R3/scale3 + alpha*R6/scale6。预先固定alpha=[0,0.25,0.5,0.75,1]，按英语/中文/混排在CAL内独立选择。
阈值沿用R6正常及每正常来源99%分位、上下文最大值、最低0，严格大于才提示；同检出率优先更少正常误报，再优先alpha接近0.5、较小alpha。
没有新编码器训练、增添训练样本或使用TEST分数选择权重。CAL选择封存后，才读取各已知回归的原始分数。
**包括002/003真实IME在内，本轮所有结果均为已知回归，不是新的盲测。**
事先设置了继续条件：只有全部既定回归检查通过，才另采40条新真实IME；本次未通过，因此未消耗新随机数或采集新留出。

模型加共享词表共40,211,081字节（约40.21 MB）。中文词表共用一份。
TRAIN分数标准差：R3=5.3468418，R6=12.533431；封存UTC：2026-11-09T17:12:48.736675+00:00。

| 语言 | R6权重alpha | 融合阈值 |
|---|---:|---:|
| en | 1.0 | 0 |
| zh | 0.75 | 0.36203951 |
| mixed | 0.75 | 0.36491737 |

## 已知回归

| 集合 | 正常误报 | 异常检出 | 上下文提示 |
|---|---:|---:|---:|
| fresh_challenge | 1/50 | 28/30 | 0/15 |
| new_challenge | 0/40 | 20/30 | 0/15 |
| new_public_test | 7/506 | 28/28 | 0/0 |
| known_ime | 0/1 | 11/13 | 0/6 |
| known_round2 | 2/365 | 34/40 | 0/20 |
| known_legacy | 1/45 | 12/17 | 0/8 |
| known_round6_ime | 2/3 | 20/25 | 5/12 |
| known_round7_ime | 0/2 | 20/23 | 6/15 |

两批真实IME合并：异常40/48、正常误报2/5、上下文提示11/27。原始问题句仍命中。
融合改善异常召回，却放大了部分上下文提示，不能只凭召回或体积符合预算决定接入。正常样本合计仅5条，不能推算真实用户总体误报率。
公开正常为银标，其他多为助手标签；两批实际输出标签均先于对应首次评分保存，未经独立人工复核。

## 实际运行检查

在同一Node进程顺序执行两个ONNX会话，旧425条batch1实测p50 10.050 ms、p95 15.269 ms；不含分词、载入和UI。
组合会话分数与此前归档独立会话分数最大差0，通过1e-5核对。
这里测量实际连续执行耗时，没有把两个分别测得的p95相加。英文alpha=1时仍按完整双会话测量，本初筛未优化零权重分支。

## 保留的验收条件

- original: 通过
- old_normals: 未通过
- r5_challenge_normal: 通过
- r5_challenge_context: 通过
- r5_en_noise: 通过
- r5_mixed_noise: 通过
- old_ime: 未通过
- old_noise: 通过
- public_normal: 未通过
- new_ime_noise: 通过
- new_ime_normal: 未通过
- new_ime_context: 未通过
- size: 通过
- latency: 未通过

下一项技术工作是补充目标分布的真实正常口语、名称、检索片段及对应异常训练，重新分组并建立新留出；不能把已看过的200条实际输出再次称作新测试。
本轮没有修改插件运行时、UI、部署或输入拦截行为，研究制品没有staging验收URL。

## 本地试用与证据

在本机CPU研究环境运行：

```powershell
.research/semantic-screen-venv/Scripts/python.exe tools/semantic-predict.py --model round8 --text "女哦就是的感受a到啊删掉asd苏打粉二十个s收到"
```

也可选择round3、round6或round7；依赖本机.research内封存制品和本地词表，不发送网络请求。结果为研究边际分数，不是校准概率，也不是已发布插件。
完整选择、权重、模型哈希、所有回归结果、来源哈希：data/semantic-round8-results.json。
脚本：tools/semantic-round8.py prepare/calibrate/evaluate，tools/semantic-fusion-native.mjs，tools/semantic-round8-summary.py。
002/003实际键串、输出及逐条标签：data/ime-keyboard/。原始熵及先前版本来源见[第六轮](REPORT-SEMANTIC-ROUND6.md)、[第七轮](REPORT-SEMANTIC-ROUND7.md)。
