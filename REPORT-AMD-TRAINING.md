# Radeon 780M 核显微调实测

**后续更正（SIM-1039）：原加权交叉熵路径的反向梯度有误。**
DirectML `cross_entropy(reduction='none')` 前向值正确，却不能正确传播每样本权重/任务掩码。
下表是该历史路径的运行时间，不再作为“正确微调加速比”的依据。此前仅验证了前向、参数变化和优化器，验证不充分。
现已改用等价的 `log_softmax + one-hot` NLL：真实多任务批次的完整编码器梯度相对L2误差 `6.13e-5`，
分类头 `5.57e-6`、辅助头 `3.07e-6`，均通过CPU对照；修正后的三轮训练已完成，共约502秒。
检测质量仍未达到接入门槛，见 [同数据复验报告](REPORT-SEMANTIC-ROUND4-FIXED.md)。
复现见 [data/semantic-directml-loss-check.json](data/semantic-directml-loss-check.json)、
[tools/semantic-device-gradcheck.py](tools/semantic-device-gradcheck.py)。
[上游已有同类问题报告](https://github.com/microsoft/DirectML/issues/739)，本机的加权/掩码行为由独立最小样例验证。

以下保留2026-11-09、SIM-1038的原始记录；正确训练须使用上面的损失修正和梯度验收。
已实际完成前向、损失、反向传播、梯度裁剪和 AdamW 参数更新，并比较 CPU。
这是短训练性能与兼容性验证；本轮没有用新增公开数据训练一个新质量候选。

## 环境与方法

- CPU：AMD Ryzen 7 8745H，8 核 16 线程；测试固定 4 个 CPU 计算线程、1 个 interop 线程。
- 核显：AMD Radeon 780M Graphics；驱动 `32.0.13032.11`，驱动日期 2025-02-13。
- Windows 11 25H2，`26200.9711`。系统报告物理内存 21,270,220,800 字节。
- 独立环境：`.research/semantic-directml-venv`，Python 3.12.10，torch-directml `0.2.5.dev240914`，
  PyTorch `2.4.1+cpu`，Transformers `4.57.3`，NumPy `1.26.4`。
- `torch_directml.device_count()` 返回 1；实际模型和输入放到 `privateuseone:0`，设备名为 780M。
  PyTorch 包的 `+cpu` 后缀不表示这个 DirectML 试验只使用 CPU；原研究环境 torch 2.9.1 未改动。
- 使用我们自己 R3 epoch-3 权重的 safetensors 导出及 TRAIN 内的真实分词输入；没有使用保留集。
  两种固定长度 64/128，每批 32 条，包含 11 正常、11 异常、10 上下文；padding 到固定长度。
- 每组预热 2 步、计时 5 步。计时包含 FP32 前向、加权 CE、反向、裁剪、AdamW、主机同步，
  不含加载和分词。每步读取更新后的参数，等待队列完成，避免只计入异步提交时间。

微软说明 [PyTorch with DirectML](https://learn.microsoft.com/en-us/windows/ai/directml/pytorch-windows)
支持 Windows 上 DirectX 12 GPU 的训练与推理，目前仍为 public preview。
实装依赖以 [torch-directml 的发布包](https://pypi.org/project/torch-directml/)为准；当前包固定依赖 torch 2.4.1。

## 实测结果

采用下述等价 AdamW 更新，CPU/GPU 使用相同 torch 2.4.1 和优化器实现：

| Batch / 长度 | CPU 平均秒/步 | 780M 平均秒/步 | 本次速度比 | 780M 条/秒 |
| --- | ---: | ---: | ---: | ---: |
| 32 / 64 | 1.0401 | 0.3229 | 3.22× | 99.10 |
| 32 / 128 | 2.1503 | 1.3971 | 1.54× | 22.90 |

原版 AdamW 的诊断对照：

| 长度 | CPU torch 2.4.1 秒/步 | DirectML 原版 AdamW 秒/步 | 原 CPU torch 2.9.1 秒/步 |
| --- | ---: | ---: | ---: |
| 64 | 1.0628 | 0.5894 | 1.3690 |
| 128 | 2.1718 | 1.7169 | 2.9391 |

后表跨版本数据只作本机诊断，不据此推断 PyTorch 版本的一般性能。运行按组串行执行。
这些是短固定批次测试，受温度、功耗、后台负载和序列组成影响，不是完整语料训练总耗时；
不能把 3.22× 外推到所有句长、batch 或模型。

## 兼容修正及正确性证据

1. `torch.inference_mode()` 下，DirectML 在索引 attention mask 时出现
   `Cannot set version_counter for inference tensor`。校验前向改用 `torch.no_grad()`，保留反向训练。
   原始失败记录也保留，未覆盖。
2. 标准 AdamW 使用 `aten::lerp.Scalar_out` 时明确警告退回 CPU。
   在本试验的固定 dense FP32、非 AMSGrad 配置中，把一阶动量更新改成等价的
   `mean.mul_(beta1).add_(gradient, alpha=1-beta1)`，其余保持解耦衰减和偏差修正。
   见 [tools/semantic_device_optim.py](tools/semantic_device_optim.py)。
3. 优化器先用同一组梯度连续更新 10 步，与 CPU 原版 AdamW 比较。
   CPU 和 DirectML 的参数最大绝对误差均为 `1.1921e-7`，通过 `1e-6` 容差。
   该实现只用于本固定配置，不声称覆盖混合精度、稀疏梯度等其他优化器选项。
4. 完整模型前向与同环境 CPU FP32 的 logits 最大误差：长度 64 为 `6.82e-5`，长度 128 为 `3.29e-5`。
   编码器第一层 query 参数有非零梯度且权重实际变化，训练损失有限，最终所有参数有限。
5. 改写后的两组 GPU 训练没有观察到不支持算子的 CPU 回退警告。
   这不是内核级利用率追踪；CPU 仍负责调度、数据准备和必要的同步。

CPU/GPU 的 dropout 随机流不同，短批次训练损失不用于比较最终检测质量。
正式训练仍需保存/重新导出权重，并在实际 Node INT8 运行时用 CAL 选阈值、用独立测试集验收。
本次没有覆盖现有 R2/R3 权重文件。

## 复现与下一步

已准备好的本机缓存下，可运行：

```powershell
& .research/semantic-directml-venv/Scripts/python.exe tools/semantic-device-benchmark.py --backend directml --optimizer portable-adamw --batch 32 --sequence 64 --warmup 2 --steps 5 --output .research/semantic-directml/my-new-probe.json
```

脚本要求输出路径不存在，避免覆盖旧实验。将 backend 换成 cpu 可做同环境对照。
复现依赖本轮保留的 `.research/semantic-directml/model.safetensors`、`inputs.json` 和原 HF 配置缓存。
完整环境清单、硬件、脚本哈希、源权重/输入哈希、逐步时间、数值检查及原始失败信息汇总于
[data/semantic-device-results.json](data/semantic-device-results.json)。

可以把此路径用于下一轮小模型训练；优先动态分桶、短序列，继续实测全程时间。
核显训练速度与训练后的模型下载体积是两件事：部署产物仍走现有 INT8 导出流程。

[AMD ROCm 7.14.1 官方矩阵](https://rocm.docs.amd.com/en/docs-7.14.1/compatibility/compatibility-matrix.html)
已经列出 Radeon 780M/gfx1103，不能沿用旧矩阵断言 780M 不支持。
但完整 8745H/OEM/驱动组合与 PyTorch 训练支持仍需进一步核对，不能仅凭显卡名保证可用。
本轮通过 DirectML 在现有驱动上验证，没有安装 ROCm 或改动驱动/系统。

公开训练数据初筛和 CSED-R 完整性检查见 [REPORT-SEMANTIC-DATASETS.md](REPORT-SEMANTIC-DATASETS.md)。
