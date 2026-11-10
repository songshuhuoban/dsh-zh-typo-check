# 中英文整句检查：公开数据初筛

核对日期：2026-11-09。结合已经完成的 R1–R3 试验，优先补中文语义错误、英文错误、真实正常混排。
本轮核对作者仓库、论文、许可与实际文件；没有用这些新数据训练或报告模型准确率。

## 推荐组合

| 数据 | 内容与用途 | 已核对的规模、许可 | 采用方式 |
| --- | --- | --- | --- |
| [CSED-R](https://github.com/wyxstriker/CSED) | 中文句子是否存在语义错误，最贴近整句诊断 | train 45,248 / dev 2,160 / test 2,000，均有标签；作者仓库 Apache-2.0 | 中文语义辅助任务，先清理重复和标签冲突 |
| [ASCEND](https://huggingface.co/datasets/CAiRE/ASCEND) | 自然中英混合对话的文字转录 | 训练集约 9.87k 条；CC-BY-SA-4.0 | 筛选正常混排、口语保护例；按说话人/会话隔离划分 |
| [C4_200M](https://github.com/google-research-datasets/C4_200M-synthetic-dataset-for-grammatical-error-correction) | 英文正确句与合成语法错误 | 2 亿句；作者发布标 CC-BY-4.0 | 仅取小子集；原发布是编辑操作，须结合 C4 v2.2.1 还原句对，并核对底层数据条款 |
| [CSW-GEC](https://aclanthology.org/2024.lrec-main.698/) | 英语学习者真实英中混排错误 | EN-ZH 人工重标后 192 条；[项目](https://github.com/kelvinchanwh/csw-gector)新增部分 CC-BY-NC-4.0 | 仅作研究验收候选；规模小，主要纠正英文部分，需遵守 Lang-8 原数据条件 |

这些数据各自覆盖一部分需求。本轮核对的候选中，没有一套大规模、现成标注的数据直接覆盖
“中文、英文、正常混排、输入法乱敲、代码引用和需要上下文”全部情形。

**语法/语义错误不能全部当成乱码。** CSED 的搭配、歧义和逻辑病句，以及英文 GEC 的时态、冠词错误，
常常仍能理解。直接把所有错误句贴成当前三分类的“明显异常”，会改变产品任务并增加误报。
适合先作为独立辅助任务，或者人工筛选与任务一致的严重异常；当前 IME 样本继续作为目标领域补充。
ASCEND 也没有“正常/乱码”金标，口语转录有片段和停顿，不能整库无审查地标成正常。

## CSED-R 实际文件审计

固定作者提交：`58ffd848a37de7c13dca57190961e5eb3ff403e1`。
已缓存原始 TSV；字节哈希、标签数和行号保存在 [data/semantic-dataset-audit.json](data/semantic-dataset-audit.json)。
以 `0=无语义错误，1=有语义错误` 解读，未映射成我们的 noise 标签。

| 划分 | 总行数 | 0 / 1 | 空白归一化后唯一句数 | 额外重复行 | 同句异标签组 |
| --- | ---: | ---: | ---: | ---: | ---: |
| train | 45,248 | 11,488 / 33,760 | 45,205 | 43 | 0 |
| dev | 2,160 | 1,080 / 1,080 | 2,124 | 36 | 9 |
| test | 2,000 | 1,000 / 1,000 | 2,000 | 0 | 0 |

三组之间没有发现空白归一化后的相同句子；这只排除该匹配条件下的重复，不证明没有近重复。
正式引入前还须与现有各轮 TRAIN/CAL/TEST 做跨来源去重，不能据此认定新数据与旧验收集独立。
dev 第 72 行文本内含额外 Tab，解析须只在首个 Tab 切开。原文也有 Unicode 分隔符，
按物理换行 `\n` 读取，不能用会拆开这些字符的 `str.splitlines()` 误计行数。
后续应保留原始文件，建立单独的清理清单：同标签重复合并，9 组矛盾 dev 样本排除或复核，不能择优保留标签。

复查命令（读取已缓存文件，重新核对哈希）：

```powershell
& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-dataset-audit.py
```

原始文件 SHA-256：

- train: `7b01f26bd25d527f25afa964958814b1f191cf3baaa8326a946993b98e6db256`
- dev: `acb2132b9ff5c4d63d7fe306d84b68efc35fb648fc2960a26acaa29d97f12099`
- test: `0d7e9031c782dcbd78fa4c2fd8f2497e177d7c08f303c2ad6c64601e461fc192`

## 其他候选与采用顺序

[NaSGEC](https://github.com/HillZhang1999/NaSGEC) 有 12,500 条中文原生语法样本，包含媒体、论文和考试。
但 [CGECData 当前发布说明](https://github.com/SUDA-LA/CGECData) 对 Media/Thesis 要求签署数据共享协议；
代码 MIT 不等于全部数据无限制开放。先用其明确开放部分，也要选清理过来源泄漏的版本。
[FCGEC](https://github.com/xlxwalex/FCGEC) 明确限制非商业学术研究，故不作为默认产品训练来源。
CoLA/CoLAC 已在早期试验使用；CoLAC 公开 test 没有标签，不能报告它的 test 准确率。

建议下一次试验先用 CSED-R 清理版建立中文语义辅助基线，再补 ASCEND 筛选后的正常混排，
最后加入适量英文 GEC 子集。各来源分开抽样、分别报告，不让数量巨大的英文合成数据淹没目标 IME 分布。
先冻结划分和阈值选择规则；新的人工复核正常混排、英文异常、真实 IME 验收集按来源/说话人隔离。
当前 120 条里正常样本仅 5 条，仍不足以可靠估计误报率。

本次仅交付数据来源初筛和审计，没有下载 C4 全库、音频或 Lang-8，也没有发布新插件。
