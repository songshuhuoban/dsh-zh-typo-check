# 第四轮：修正DirectML损失后的同数据复验

**本次使用与原R4完全相同的数据、起点和超参数，仅修正损失的反向传播。原R4验收集已经打开，本次全部作为已知回归，不称新独立测试。**
训练前通过真实多任务批次的CPU/DirectML完整梯度对照；原始错误路径及模型完整保留，未覆盖。
[数值验收证据](data/semantic-directml-gradient-check.json)；[最小复现](data/semantic-directml-loss-check.json)。

目标：改善明显英文/中英混排乱句检出，同时保护正常混排、代码、引用和需要上下文的短语。
SIM-1039。固定划分及三轮训练均已完成；以下结果来自最终 Node INT8 运行时。

## 方法与数据

从 R3 自有权重继续训练，15379 条唯一文本、15907 个采样条目。
其中主任务 7,907 个条目，另有独立 CSED 语义辅助任务 8,000 条；辅助病句标签没有并入乱码类别。

- [CSED-R](https://github.com/wyxstriker/CSED)：固定58ffd848，train各取4,000正常/病句；dev去重并排除9组矛盾标签。
- [ASCEND](https://huggingface.co/datasets/CAiRE/ASCEND)：固定737e9800，12,314条原始转录，仅读取文字列；按23位说话人隔离所有本地session，筛选自然混排。CC-BY-SA-4.0。
- [Incoherent Text Dataset](https://huggingface.co/datasets/SuccubusBot/incoherent-text-dataset)：固定7f1159d，共37,652条算法生成数据；本轮只取英文coherent与word_soup，训练异常重复4次，仍计唯一文本。作者卡标CC-BY-SA-4.0。
- 没有把random_words、random_tokens、random_bytes、run_on或普通语法错直接标成乱句；C4原发布需还原大语料，本轮改用可直接读取的小型公开英文增量。
- 保护R3全部划分的文本，跨来源精确去重；英文以词集相似度合并近源家族后划分。R4挑战回归与旧任意划分精确重叠为0。

| 集合 | 正常 | 异常 | 上下文 |
| --- | ---: | ---: | ---: |
| cal | 1375 | 66 | 29 |
| new_challenge | 40 | 30 | 15 |
| new_public_test | 506 | 28 | 0 |
| known_ime | 1 | 13 | 6 |
| known_round2 | 365 | 40 | 20 |
| known_legacy | 45 | 17 | 8 |

R4挑战回归为助手在预测前编写/冻结的85例；公开正常是银标，公开异常是算法生成，均不能称为独立人工金标。
CSED辅助测试另保留2,000条，与乱句测试分开报告。

训练：Ryzen7 8745H + Radeon780M，DirectML0.2.5.dev240914 / torch2.4.1，FP32全量反向。
3epoch、3e-5、batch32、按长度分桶、最大128token，辅助损失权重0.25；主任务类别权重1.5/1/1.5。
固定dense FP32等价AdamW已通过10步原版数值对照。每个epoch保存safetensors，再用原CPU环境导出和量化。
CAL阈值沿用正常总体99%分位、各来源97.5%分位、上下文最大值及非负下限，严格大于才提示。
选模依据CAL的英文/中文/混排异常宏平均召回，其次正常误报、更早epoch。选定及保存哈希后才打开新TEST。
首轮CAL诊断发现少量中文/混排上下文抬高英文全局阈值，因此在TEST打开前另行封存分语言校准计划。
该对照仍使用相同正常分位数与上下文零提示约束，只在en/zh/mixed各自CAL内计算；按相同CAL目标选epoch。原全局方案完整保留。

选中epoch **2**，阈值 **5.254773**，训练/导出/CAL共 **502.3秒**。
INT8模型 **12,781,044 bytes**，SHA-256 `5c3b322b8aacc8edbd9b9ac71534c086f6d7d1c40cf01c04113e264c03d33820`。
分语言对照选中epoch1，阈值{"en": 0.0, "zh": 3.223041355609894, "mixed": 2.076963633298874}。

## 实测对照

各项均为“提示数/该标签总数”；正常与上下文越低越好，异常越高越好。

| 模型 | R4挑战回归正常 | R4挑战回归英文异常 | R4挑战回归混排异常 | R4挑战回归上下文 | 公开正常 | 公开英文乱序 |
| --- | --- | --- | --- | --- | --- | --- |
| round2-original | 0/40 | 0/15 | 2/15 | 2/15 | 70/506 | 4/28 |
| round3-original | 0/40 | 0/15 | 2/15 | 0/15 | 76/506 | 2/28 |
| round3-recalibrated | 0/40 | 0/15 | 0/15 | 0/15 | 9/506 | 0/28 |
| round4-public-aux | 0/40 | 0/15 | 0/15 | 0/15 | 0/506 | 21/28 |
| round4-language-calibrated | 0/40 | 1/15 | 2/15 | 0/15 | 1/506 | 21/28 |

| 模型 | 已知R2正常 | 已知R2异常 | 已知R2英文异常 | 已知早期异常 | IME异常 | IME上下文 |
| --- | --- | --- | --- | --- | --- | --- |
| round2-original | 0/365 | 19/40 | 2/10 | 7/17 | 12/13 | 2/6 |
| round3-original | 0/365 | 19/40 | 1/10 | 7/17 | 12/13 | 1/6 |
| round3-recalibrated | 0/365 | 3/40 | 0/10 | 2/17 | 6/13 | 0/6 |
| round4-public-aux | 0/365 | 7/40 | 1/10 | 6/17 | 7/13 | 0/6 |
| round4-language-calibrated | 0/365 | 12/40 | 6/10 | 4/17 | 9/13 | 0/6 |

## 门槛与边界

本次仍未通过整体接入门槛。公开英文乱序有改善，但R4手写挑战检出不足，原有混排/IME检出也出现退化。
独立CSED辅助测试为50%、MCC为0，这个固定训练配方尚未学到有效的辅助判别；不据此认定整套语料无用。
保留R3基线，下一单元检验冻结骨干、只学习小型残差分类头能否减少回退，并补充功能词密集乱句的训练覆盖。

训练前设定的暂定门槛：原用户样例命中；已知正常零误报；R4挑战回归正常/上下文各至多1次提示；
R4挑战回归英文、混排异常各召回≥60%；IME异常≥12/13且上下文≤1/6；已知R2异常≥19/40；
INT8≤15MB、已知R2输入上Node p95≤15ms。不能把这些助手/银标样本上的门槛视为生产质量保证。

| 检查 | 原全局校准 | 分语言校准 |
| --- | --- | --- |
| original_detected | 通过 | 通过 |
| known_normal_zero_fp | 通过 | 通过 |
| fresh_challenge_normal | 通过 | 通过 |
| fresh_challenge_context | 通过 | 通过 |
| fresh_en_noise | 未通过 | 未通过 |
| fresh_mixed_noise | 未通过 | 未通过 |
| known_ime_noise | 未通过 | 未通过 |
| known_ime_context | 通过 | 通过 |
| known_round2_noise | 未通过 | 未通过 |
| size | 通过 | 通过 |
| latency | 通过 | 通过 |

暂定门槛整体：原全局 **未通过**，分语言 **未通过**。

用户原文提示：True，分数7.0616。
Node p95：5.08ms（仅Tensor构造和推理，不含分词/加载）。

独立CSED辅助任务（有无语义病句，不是乱码检出率）：

| 集合 | n | Accuracy | Balanced accuracy | MCC |
| --- | ---: | ---: | ---: | ---: |
| aux_cal | 2114 | 0.4976 | 0.5000 | 0.0000 |
| aux_test | 2000 | 0.5000 | 0.5000 | 0.0000 |

实际GPU训练/导出信息：

- epoch1：GPU训练136.3秒，最终参数有限；编码器权重变化0.00250138；FP32导出最大差8.08e-06；CAL异常21/66，正常0/1375。
- epoch2：GPU训练126.7秒，最终参数有限；编码器权重变化0.00298402；FP32导出最大差3.93e-06；CAL异常36/66，正常2/1375。
- epoch3：GPU训练131.6秒，最终参数有限；编码器权重变化0.00296872；FP32导出最大差4.53e-06；CAL异常24/66，正常0/1375。

捕获警告：[]。

公开算法数据不能证明真实输入泛化；说话人隔离不等于已知跨说话人的对话关系完全独立，近源词集分组也不是完整来源追踪。
统计置信区间见结果JSON，且不能补救银标或助手标签偏差。旧425/70/IME20已经打开，本轮均只称已知回归。
本次修复复验交付研究权重、数据清单、完整测量；插件运行代码没有变更。是否进入接入单元需结合全部退化和误报判断。

## 复现

```powershell
& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-round4-data.py fetch
& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-round4-data.py prepare
& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-round4-language.py plan
& .research/semantic-directml-venv/Scripts/python.exe tools/semantic-round4.py train --workdir .research/semantic-round4-fixed --loss manual
& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-round4-language.py calibrate
& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-round4.py evaluate
& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-round4-language.py evaluate
& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-round4-summary.py
```

数据/训练/测试步骤有覆盖保护，应使用保留的固定缓存；改变输入需新实验目录。
结果：[data/semantic-round4-fixed-results.json](data/semantic-round4-fixed-results.json)；
助手挑战原文与标签：[data/mixed-semantic-round4-seeds.json](data/mixed-semantic-round4-seeds.json)。
公共原文和逐epoch权重保存在gitignored `.research/semantic-round4/`，结果JSON只保存预测、行号与来源，不重新分发公共原文。
