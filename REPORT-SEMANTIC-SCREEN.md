# 中英混排异常检测：轻量模型初筛

日期：2026-11-09。跟踪：SIM-1034，承接 SIM-1033。

本轮是本地研究试验，没有修改插件运行逻辑、用户配置或发布版本。
“具体错字”“语法可接受性”“明显误输入”是三个任务，以下指标分别报告。

**结论：有约 3–13 MB 的可运行候选，无须先引入 0.8B 生成模型；本轮没有达到产品要求的配置。**
初筛 13 个 HF 候选，实测 4 个编码器、字符 ngram、现有插件，并完整微调 ELECTRA-small。
后者量化后仅 12.78 MB，能命中原文，检出手写异常 14/17，却误报正常产品样例 7/45。
保留 ELECTRA-small 作为下一轮底座候选；下一步重点应是目标分布的真实标注，而非继续扩大模型或追逐合成测试分数。

## Hugging Face 初筛

检索词包括 `gibberish`、`acceptability`、`CoLAC`、`grammar + zh`、`cola + multilingual`；
逐项读取模型卡、语言、任务、固定 revision 和文件体积。检索结果不是模型全集，也不能由标签缺失推断模型绝对不支持某语言。

| 模型 | 实际可下载权重 | 本轮处理 |
| --- | ---: | --- |
| UER Chinese RoBERTa L2/H128 | FP32 12.84 MB | 本地试验；HF 卡未标许可证，暂不作分发结论 |
| MiniRBT-H256 | FP32 41.51 MB | 本地试验，中文底座，英文混排能力靠实测 |
| ELECTRA-small discriminator | FP32 49.44 MB | 本地试验，另测试原始替换检测头 |
| RBT3 | FP32 156.38 MB | 后续容量对照，未下载、未实测 |
| ALBERT-tiny-Chinese | FP32 16.19 MB | 候补；GPL-3.0，未纳入本轮四个编码器试验 |
| Microsoft Multilingual MiniLM | FP32 470.66 MB | 不下载该浮点底座，改测下一行的现成量化编码器 |
| Xenova/paraphrase-multilingual-MiniLM-L12-v2 | INT8 118.05 MB + tokenizer 17.08 MB | 本地试验；是句向量编码器，并非乱句检测成品 |
| pszemraj/gibberish_detector_onnx-quant-avx2 | INT8 67.61 MB | 源模型用于英文，缺中英混排证据，未下载 |
| flowxai/gibberish | INT8 535.31 MB | 26 种语言的公布评测不含中文，且体积不合本轮目标 |
| Qwen3.5-0.8B | 原始权重 1746.94 MB；Q4_0 约 563 MB | 未下载；不作为本轮插件常驻候选 |
| EstherT/sentence-acceptability | FP32 438.01 MB | 英语 CoLA 分类器，不是中文或混排验证结果 |
| CodeTed/Chinese_Grammarly | FP32 1039.04 MB | 中文生成式纠错，体积和任务均不匹配 |
| kotoshu/grammar-cjk | INT8 220.74 MB | 作者已注明该版本训练/评分存在问题，不采用 |

上述单位均为十进制 MB，按文件 bytes/1e6；不把多个框架的权重文件重复计入下载。
元数据脚本：`node tools/semantic-model-survey.mjs`；固定 revision 和模型卡快照位于 `.research/semantic-screen/`。

来源：[MiniRBT 作者仓库](https://github.com/iflytek/MiniRBT)、
[ELECTRA-small 模型卡](https://huggingface.co/hfl/chinese-electra-180g-small-discriminator)、
[多语言 MiniLM 原模型](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2)、
[现成 INT8 文件](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/tree/main)、
[Qwen 的 GGUF 文件](https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/tree/main)、
[英文 Gibberish Detector 原模型](https://huggingface.co/madhurjindal/autonlp-Gibberish-Detector-492513457)、
[flowxai 模型卡](https://huggingface.co/flowxai/gibberish)、
[kotoshu 的状态更正](https://huggingface.co/kotoshu/grammar-cjk)。

## Benchmark 的适用范围

| 数据 | 用途与本轮用法 | 不能证明的能力 |
| --- | --- | --- |
| [CoLAC](https://github.com/huhailinguist/CoLAC) | 中文可接受性；train 6072、dev 492，使用作者的 crowd label1 | 不能直接代表混排乱句检测；公开 test 931 条没有标签，未计算 test 分数 |
| [CoLA](https://nyu-mll.github.io/CoLA/) | 英文可接受性；来自作者仓库，精确去重并移除 train/dev 重叠后 train 8532、dev 1023 | 不能直接代表中文或中英混排 |
| [SLING](https://github.com/Yixiao-Song/SLING_Data_Code) | 中文最小对；本轮固定种子按 54 个 paradigm 各取 2 对，共 108 对 | 本轮用线性 probe 对好/坏句排序，**不是**论文的 MLM/PLL 正式评测，不与论文排行榜比较 |
| [自然中英混排语料](https://github.com/lfang1/CodeSwitchingResearch) | EMNLP 2020 作者公开的自然混排文本，去重、过滤后 1435 条；按来源 university/sent_id 分组为 train 864 / cal 281 / test 290 | 只有正常混排，适合估计该分布上的误报，不能计算真实异常召回 |
| [CSW GEC](https://aclanthology.org/2024.lrec-main.698/) | 调研其混排语法纠错设置及数据生成方法，未在本轮跑其训练或测试 | 任务是编辑纠错，不是对随机词语组合做独立三分类 |
| 本地产品样例 | 45 条应放行、17 条明显异常、8 条依赖上下文；覆盖技术混排、代码、引用、口语、纯英文和用户原文 | 手写的小样本探索集，已经包含本次报告的已知失败例；不冒充独立公开 benchmark |

公共数据只下载到 gitignored `.research/`，仓库只保留准备脚本、来源、哈希和本地手写样例。
`prepared.json` 与 `manifest.json` 保留实际划分、下载文件 SHA-256 和固定来源 revision。

## 试验方法

- 固定种子 20261109、CPU 4 线程、最大长度 96；本轮输入未发生截断。
- 四个编码器提取 `[CLS] + attention-mask mean` 特征，编码器冻结；分别训练语法和异常两个线性头。
  语法头使用 CoLAC + CoLA train，StandardScaler + LogisticRegression，C=1。下表是该 **probe** 的表现，不是模型完整微调后的能力上限。
- 异常头训练集 5321 条：2664 条正常文本及其 2657 条合成扰动。正常文本来自自然混排 train、
  CoLAC/CoLA train 中的可接受句；扰动含块打乱、随机字母插入、片段置换。剔除了 7 条与正常文本相同的
  冲突负例，并重跑所有头；准备脚本现在校验标签冲突和划分泄漏。合成标签仍属于弱监督。
- 阈值只从 681 条正常 CAL（281 自然混排 + 400 条单语正常句）的分数 99% 分位确定，使用严格 `>`。
  产品样例不用于训练、选阈值或微调 checkpoint 选择。
- 小编码器的头在 FP32 特征上训练，再导出/量化完整图；量化后在 **量化模型的 CAL 分数** 上重新设阈值。
  多语言 MiniLM 直接使用现成 INT8 编码器，拟合和评估都用 batch=1，避免额外下载约 470 MB 浮点模型。
- 对照：字符 2–4 gram + TF-IDF + LogisticRegression；以及独立 profile 中运行真实 0.2.3 `/check` 路由，
  按客户端“没有具体错字才显示整句提示”的优先级计算蓝线结果。
- 环境：Windows，AMD Ryzen 7 8745H，Python 3.12.10，PyTorch 2.9.1+cpu，Transformers 4.57.3，
  sklearn 1.7.2，ONNX Runtime 1.23.2。延迟是温热 batch=1 的组件耗时，不是实际 DSH 页面端到端耗时。

### 公开语法数据：冻结编码器线性 probe

| 编码器 / 对照 | CoLAC dev MCC | CoLA dev MCC | SLING 小样本配对准确率 |
| --- | ---: | ---: | ---: |
| UER Tiny | 0.003 | -0.037 | 46.3% |
| MiniRBT-H256 | 0.075 | -0.011 | 49.1% |
| ELECTRA-small | **0.389** | 0.049 | **63.9%** |
| 多语言 MiniLM INT8 | 0.105 | **0.154** | 53.7% |
| 字符 ngram | 0.084 | 0.005 | 39.8% |

多数行的 accuracy 高于 MCC 所暗示的能力，是因为可接受句占多数；不把“约 68% accuracy”误认为有效英文语法识别。

### 实际量化产物：异常检测

| 版本 | 模型 / 头体积 MB | 自然混排误报 / 290 | 合成扰动检出 / 290 | 手写异常检出 / 17 | 正常产品样例误报 / 45 | 原文命中 | 温热 P95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| UER Tiny + 线性头 | 3.26 | 2 | 133 | 3 | 0 | 否 | 0.59 |
| MiniRBT + 线性头 | 10.55 | 1 | 160 | 3 | 2 | 是 | 2.84 |
| ELECTRA-small + 线性头 | 12.79 | 1 | 190 | 6 | 1 | 是 | 4.03 |
| ELECTRA-small 完整微调 | 12.78 | 7 | 276 | 14 | 7 | 是 | 4.48 |
| 多语言 MiniLM + 线性头 | 118.05 + 0.05 | 0 | 179 | 3 | 0 | 否 | 5.82 |
| 字符 ngram，两套头合计 | 0.87 | 4 | 265 | 0 | 8 | 否 | 未测 |
| 现有插件 0.2.3 整句蓝线 | 约 104，已有模型 | 未跑 | 未跑 | 1 | 3 | 否 | 未作同路径对比 |

多语言 MiniLM 还需 17.08 MB tokenizer；三个中文底座的词表约 0.11 MB。
8 条依赖上下文的样例单独记录：UER 和多语言 MiniLM 各提示 1 条，其他两个冻结量化编码器为 0 条；
完整微调 ELECTRA 提示 3 条；现有蓝线提示 4 条。
本轮没有把“不提示”宣称为语义正常，也没有实现产品级的三分类或自动改写。

## 已验证的失败模式

1. **能抓原文不代表能上线。** MiniRBT 仍有正常产品样例误报。
   ELECTRA 冻结版的量化产物仅误报一条代码，但仍漏掉 11/17 条手写异常。
2. **合成扰动分数很好也可能完全不泛化。** 字符 ngram 在合成测试上检出 265/290，
   却在 17 条手写异常中零检出，且正常产品样例误报 8/45。不能靠同一种人工扰动的好成绩决定发布。
3. **量化精度必须重新验证。** MiniRBT/ELECTRA 的 FP32 ONNX 与 PyTorch 在产品样例上的最大分数差都小于 1e-5，
   浮点导出正确；INT8 与 FP32 却分别有 8/6 条样例在原阈值下发生判断变化。
   即使对 INT8 单独校准，ELECTRA 手写异常检出也从浮点 11/17 降为 6/17。
4. **ELECTRA 的预训练头不是现成语义检测器。** 直接用原始 replaced-token 检测头，
   在相同正常 CAL 的 1% 工作点，合成测试只检出 7/290、手写异常 0/17。需要针对目标任务训练。
5. **HF 卡片的高分需核对任务和后续更正。** kotoshu 卡片曾列出很高的中文合成纠错分数，
   随后的状态说明已撤回该版本的有效性；本轮没有依据旧分数选择它。

## 完整微调对照

冻结 probe 中 ELECTRA-small 的中文 MCC 最好，因此额外执行一次固定 3 epoch 全参数微调。
训练仍只用清理后的 5321 条弱监督样本，AdamW 8e-5、按长度分桶的 batch 32、warmup 10%、最大长度 96；
用正常 CAL 及其另行生成的合成扰动（清理未变化负例后共 1360 条）选择 AUROC 最高的 epoch。
产品样例不参与选择，量化后同样单独校准阈值。

三个 epoch 的合成 CAL AUROC 分别为 0.9906、0.9915、0.9926，选择第三个；CPU 训练约 288 秒。

| 产物 | 体积 MB | 自然混排误报 / 290 | 合成扰动检出 / 290 | 手写异常检出 / 17 | 正常产品样例误报 / 45 |
| --- | ---: | ---: | ---: | ---: | ---: |
| FP32 ONNX | 49.32 | 5 | 273 | 12 | 7 |
| INT8 ONNX | 12.78 | 7 | 276 | 14 | 7 |

微调后的量化模型确实能检测用户原文，但仍误报合法 IP、版本号、`收到，thanks！`、引用原文、
两条代码和一句正常英文。它漏掉 3 条手写异常，并在 8 条不确定短语上提示 3 条。
因此“抓到原文”和“合成检出率 95.2%”都不足以支持产品接入。
该配置对目标产品样例的 AUROC 也从冻结版的 0.942 降到 0.842，显示本轮弱监督训练没有解决领域泛化问题。

另用与插件依赖相同版本的 **onnxruntime-node 1.30.0** 验证了该 INT8 产物：
70 条样例与 Python ORT 1.23.2 的提示判断一致，最大 logit 差为 0.5634，不能称为逐数值一致。
在 Node 上用同一 681 条正常 CAL 重新校准后，产品样例仍为检出 14/17、误报 7/45、不确定提示 3/8。
保留 `.research/semantic-screen/native-runtime-check.json` 和 tokenized 输入用于复核。

结果汇总：`data/semantic-screen-results.json`，包含固定来源、数据哈希、各配置指标及按 fixture 下标索引的逐条判断。
完整微调权重及 FP32/INT8 ONNX 留在 gitignored `.research/semantic-screen/`，没有装入用户插件。

## 复现

```powershell
python -m venv .research/semantic-screen-venv
& .research/semantic-screen-venv/Scripts/python.exe -m pip install torch==2.9.1 --index-url https://download.pytorch.org/whl/cpu
& .research/semantic-screen-venv/Scripts/python.exe -m pip install -r tools/semantic-screen-requirements.txt
node tools/semantic-model-survey.mjs
& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-screen.py prepare
foreach ($candidateKey in @('minirbt', 'uer-tiny', 'electra-small', 'mminilm', 'char-ngram')) {
  & .research/semantic-screen-venv/Scripts/python.exe tools/semantic-screen.py run --model $candidateKey
}
& .research/semantic-screen-venv/Scripts/python.exe tools/semantic-screen-finetune.py --model electra-small
node tools/semantic-screen-baseline.mjs
node tools/semantic-screen-native.mjs
python tools/semantic-screen-summary.py
```

最后一条命令使用开发工作区已缓存的 MacBERT 模型，在独立 profile 调用打包路由，不修改真实 DSH。
其余模型和公共数据自动下载到 `.research/semantic-screen/`。运行时不发送草稿给远程模型。
完整研究环境的 transitive 版本保存在该目录的 `environment.txt`。

## 交付边界

本轮只做初筛、原型训练与量化验证。公开的单语语法集、自然混排语料与小批手写样例，
还不能证明产品误报率小于 1% 或覆盖真实用户全部异常输入。
当前比较也包含不同量化路径，且没有对各架构分别做超参搜索、完整微调或正式全量 SLING 评测。
任何后续产品接入都须先补真实技术混排/代码/引用/口语及真实异常的独立标注集，再经 OpenPencil 验收交互。

## 检查记录

- 数据准备的 train/evaluation 重叠、来源分组、产品 holdout 泄漏和冲突标签断言通过。
- Python 编译、Node 脚本语法检查通过；全部研究命令实际运行完成。
- 三个小编码器完成 FP32 导出核对、INT8 校准与评估；多语言对照直接使用固定版本 INT8。
- 完整微调完成三个 epoch、FP32/INT8 测试及 Node 原生运行时核对。
- 未改生产运行逻辑，因此没有执行 npm 发布、插件安装或 staging 部署，也未把研究原型宣称为产品修复。
