# 中文校对模型调研

> 结论：**换成 CSC 微调过的模型，留出集直接满分。**
> `macbert4csc-base-chinese`（ONNX 现成）：**精确率 100% / 召回率 85.0% / F1 91.9%**，
> 对比通用 `bert-base-chinese` 的 94.4 / 85.0 / 89.5，对比纯规则的 100 / 60.0 / 75.0。
> 体积仍是 78–98 MB 这一档——**小模型目前没有可用的现成 ONNX，这是唯一没解决的点。**

## 一、怎么查的

- Hugging Face API：按 `fill-mask`、`onnx`、`csc`、`corrector`、`macbert` 等关键词各扫一轮，
  按下载量排序；再按"含 ONNX 的仓库里体积最小的"反查。
- 模型卡：读 benchmark 声明与许可证。
- 镜像：直接对 `hf-mirror.com` 发请求验证文件可得性。
- 实测：把最有希望的几个接到已有的 74 句语料上，用同一套 A/B 两路架构跑同一个指标。

## 二、候选清单

| 模型 | 参数 | ONNX | 最小体积 | 许可证 | 下载量 |
| --- | --- | --- | --- | --- | --- |
| **Xenova/macbert4csc-base-chinese** | 101 M | ✅ 8 种量化 | **78.2 MB**（q4f16）/ 98.3（int8） | Apache-2.0（父模型） | 160 |
| Xenova/bert-base-chinese | 101 M | ✅ 8 种 | 78.2 MB / 98.3 | Apache-2.0 | 317 |
| shibing624/macbert4csc-base-chinese | 101 M | ✅ 仅 fp32 | 452 MB | Apache-2.0 | **403,683** |
| onnx-community/bert-base-chinese-ONNX | 101 M | ✅ | 78.2 MB | Apache-2.0 | 38 |
| gandli/macbert4csc-q8-onnx | 101 M | ✅ | 114.4 MB | ? | 15 |
| Hosstia/bert-tiny-chinese-onnx | 11.3 M | ✅ | 11.1 MB | **GPL-3.0**（父模型） | 0 |
| uer/chinese_roberta_L-4_H-256 | 8.6 M | ❌ | 需自行转换 | ? | 1,829 |
| uer/chinese_roberta_L-2_H-128 | **3.1 M** | ❌ | 需自行转换 | ? | 1,793 |
| hfl/chinese-electra-small-generator | 1.9 M | ❌ | 需自行转换 | Apache-2.0 | 75 |
| ckiplab/albert-tiny-chinese | 11.3 M | ❌ | 需自行转换 | GPL-3.0 | 369 |
| iioSnail/ReaLiSe-for-csc | 101 M+ | ❌ | 1 GB 权重 | AFL-3.0 | 105 |

**关键结构性事实**：中文小模型（3–12 M 参数）基本**没有现成 ONNX**；
反过来，有现成 ONNX 的**清一色是 base 档 101 M**。

## 三、实测（同一套 74 句语料，同一套架构）

留出集 test（36 句，阈值只在 dev 上定）：

| 方案 | 精确率 | 召回率 | F1 | 正常句误报 |
| --- | --- | --- | --- | --- |
| L0 规则 | 100.0% | 60.0% | 75.0% | 0/15 |
| + 通用 BERT（98.8 MB） | 94.4% | 85.0% | 89.5% | 1/15 |
| **+ CSC 模型（98.8 MB）** | **100.0%** | **85.0%** | **91.9%** | **0/15** |

全集 74 句：

| 方案 | 精确率 | 召回率 | F1 | 正常句误报 |
| --- | --- | --- | --- | --- |
| L0 规则 | 96.3% | 61.9% | 75.4% | 0/30 |
| + 通用 BERT | 91.9% | 81.0% | 86.1% | 1/30 |
| **+ CSC 模型** | **97.2%** | **83.3%** | **89.7%** | **1/30** |

CSC 模型在**每个维度上都更好**：精确率比通用 BERT 高 5 个点（甚至高于纯规则），
召回只掉不到 2 个点。它唯一的那 1 条误报，是把一句话的错字改成了另一个错字——
方向对、字给错，不是"对正确文本报错"。

**原因**：`macbert4csc` 是拿 SIGHAN 错字语料微调过的 MLM，掩码预测本来就偏向
"这里被写错的字该是什么"，而通用 BERT 只是在做语言建模。我们要的正是前者的输出分布。

模型卡自报的 SIGHAN2015 成绩（供横向参考）：

| | 精确率 | 召回率 | F1 |
| --- | --- | --- | --- |
| 字级 | 93.72 | 86.40 | **89.91** |
| 句级 | 82.64 | 73.66 | **77.89** |

注意：该模型**训练时用了 SIGHAN2015 训练集**，所以这个数字偏乐观，不能当独立基准。

## 四、中国用户的下载

| 渠道 | 状态 |
| --- | --- |
| `huggingface.co` 直连 | 可用（本机实测 200） |
| `hf-mirror.com` | **实测 200**，两个模型的 ONNX 都能拉 |
| ModelScope | 按 `shibing624/macbert4csc-base-chinese` 查不到（可能命名不同），未验证到官方镜像 |

建议三级回退：

```
hf-mirror.com  →  huggingface.co  →  自建静态源（GitHub Release / 对象存储）
```

宿主侧下载服务已经把 URL 做成常量数组，加一个 `?source=` 参数就能让用户在设置页里
切换线路；校验用 SHA-256（HF 的 LFS ETag 就是它）。

## 五、体积与精度的取舍（唯一没解决的问题）

实测能把 98 MB 压到多少：

| 方案 | 体积 | 可行性 |
| --- | --- | --- |
| q4f16 量化（现成） | **78.2 MB** | 可用，但精度未实测 |
| 词表裁剪 | 省 ~15 MB | 杯水车薪，层参数才是大头（12 层 × 7 M） |
| 换 L4/H256（8.6 M 参数） | ~9 MB int8 | **需自行导出 ONNX**（torch + optimum） |
| 换 L2/H128（3.1 M 参数） | ~3 MB int8 | 同上，精度高度存疑 |
| ALBERT-tiny（11 M，现成 ONNX） | 11.1 MB | 父模型 **GPL-3.0**，license 不适合分发；精度未验证 |

要走小模型这条路，**当前环境缺 torch**（只有 numpy/pandas 那套），得先装
torch+optimum 才能导出。装完之后 L4/H256 那个 8.6 M 的最值得试——9 MB 对 98 MB
是数量级的改善，代价是精度未知。

## 六、建议

**当前版本用 `Xenova/macbert4csc-base-chinese`**（int8 98.3 MB）：

- 现成 ONNX，Apache-2.0，`hf-mirror` 可取
- 实测留出集满分精确率、F1 91.9%
- 单次推理 21 ms，单句均摊 132 ms → 停笔 300–500 ms 后跑
- 加载 0.8 s（热缓存）

**如果 98 MB 不可接受**，下一步是导出 L4/H256 小模型并重新跑这套评估——
但要先接受"精度可能明显下降"的风险，而且必须先解决 torch 环境。

## 七、复现

```bash
MODEL=Xenova/macbert4csc-base-chinese B_MARGIN=10 node tools/eval-final.mjs test
node tools/hf-detail.mjs          # 候选模型参数/许可证/ONNX 体积
node tools/hf-small-survey.mjs    # 反查"有 ONNX 且体积最小"的中文模型
```
