# 50 MB内的学习型整句融合：第十轮初筛

2026-11-10，SIM-1045。使用第九轮已冻结数据，不加入已知测试到训练。

**实用初筛未通过，本候选不接入插件，不再追加新盲测。**

## 方案与隔离

固定R3中文分类器与R9严格方案第6轮模型，均读取整段输入。两套模型共三个编码器；取六个原始分类logits，训练一个6→16ReLU→3残差头，最后一层零初始化，初始输出逐位等于R9。
新头仅163参数。TRAIN唯一文本上拟合六维均值/标准差，残差输入限制[-10,10]；对原R9正常/上下文输出做保留损失，异常类别允许直接学习。
沿用R9 TRAIN9217条采样/7949唯一、CAL1670；30轮固定比较3/10/30。阈值沿用已封存的小来源合并规则：语言总体正常99%、来源正常至少101才单独约束、上下文最大值、最低0。
按CAL最低语言召回、宏平均、正常提示数、较早轮次选择；本轮全部测试都是已知回归，包括第九轮新短句260条和004实际输出60条。没有再次称作独立盲测。
选第3轮；163参数FP32 ONNX仅2,119字节，加两套INT8基础模型和共享词表共40,213,200字节（约40.21 MB）。

## 已知回归结果

| 集合 | 正常提示 | 异常检出 | 上下文提示 |
|---|---:|---:|---:|
| fresh_challenge | 2/50 | 29/30 | 0/15 |
| new_challenge | 0/40 | 23/30 | 0/15 |
| new_public_test | 5/506 | 28/28 | 0/0 |
| known_ime | 0/1 | 8/13 | 0/6 |
| known_round2 | 3/365 | 32/40 | 0/20 |
| known_legacy | 1/45 | 12/17 | 0/8 |
| new_short_test | 0/123 | 0/0 | 1/137 |
| known_r9_ime | 0/2 | 19/37 | 2/21 |

### 同批004对照（均为本轮已知回归）

| 方案 | 正常提示 | 异常检出 | 上下文提示 |
|---|---:|---:|---:|
| R9原严格阈值 | 0/2 | 14/37 | 1/21 |
| R9第6轮按本轮同规则校准 | 0/2 | 19/37 | 2/21 |
| R10学习型融合 | 0/2 | 19/37 | 2/21 |

这些结果不能当成新的泛化证据。实际正常只有2条、标签为助手初标，不能用0/2宣称总体0误报。
学习型小头在本次数据/配方下没有同时达到规定的异常检出与上下文约束；这不证明所有融合方法都无效。

## 数值、延迟与验收

Radeon780M训练163参数头，CPU/DirectML梯度相对L2误差2.2297288e-07、最大差4.0978193e-08。
选定小头FP32导出最大差9.5367432e-07；完整原生组合管线与缓存CAL部件分数最大差0。
Node三会话顺序执行旧425条batch1实测p95 18.646 ms；不含分词、载入和UI。

本轮预先设实用初筛20ms并单独保留旧15ms检查；没有将新标准冒充旧标准。初筛仅用于决定是否值得另采新盲测，不能等同发布验收。

- practical.known_actual_noise: 未通过
- practical.known_actual_normal: 通过
- practical.known_actual_context: 未通过
- practical.short_normal: 通过
- practical.short_context: 通过
- practical.public_normal: 通过
- practical.old425_normal: 通过
- practical.old425_noise: 通过
- practical.en_noise: 通过
- practical.mixed_noise: 通过
- practical.challenge_normal: 未通过
- practical.size: 通过
- practical.latency: 通过
- retained.original: 通过
- retained.old_normal_zero: 未通过
- retained.old_ime_12: 未通过
- retained.old_noise_19: 通过
- retained.old_latency_15: 未通过

既定继续条件为全部实用初筛通过；本次未通过，因此没有采第五批，没有消耗额外物理熵。004和公开抽样之后最后使用位置仍为121976/160000。
本轮没有修改插件UI、运行时、驱动或部署，研究制品没有staging验收URL。

## 本地复核

`python tools/semantic-predict.py --model round10 --text "整句话"`，使用本机CPU研究环境和封存模型，不发网络请求。
原始问题句是否命中、完整模型哈希/阈值/数据角色及结果：data/semantic-round10-results.json；第九轮真实补训和独立测试见REPORT-SEMANTIC-ROUND9.md。
脚本：tools/semantic-round10.py prepare/train/evaluate、tools/semantic-gate-native.mjs、tools/semantic-round10-summary.py。
所有数据JSON及原始IME档案禁用Git自动换行转换，避免在提交/检出时改变已记录的字节哈希。
