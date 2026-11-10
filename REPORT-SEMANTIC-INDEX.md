# 整句异常检查研究归档

2026-11-09 至 2026-11-10。用户最终采用 **R13 本地整句告警 + 既有中文错字纠错**，产品入口见 README，固定模型合同与局限见 MODEL-R13.md。

按问题顺序阅读：

- [初筛与 benchmark](REPORT-SEMANTIC-SCREEN.md)、[困难正常例](REPORT-SEMANTIC-ROUND2.md)、[真实 IME 补充](REPORT-SEMANTIC-ROUND3.md)。
- [公开数据来源](REPORT-SEMANTIC-DATASETS.md)、[AMD 核显训练验证](REPORT-AMD-TRAINING.md)。
- 第四至第十二轮报告记录失败试验、回退与修正；[R13 选择与新留出复验](REPORT-SEMANTIC-ROUND13.md) 保留未通过的前瞻门槛。
- [Qwen 量化对照](REPORT-SEMANTIC-QWEN35.md)、[Jev 最后一轮与最终选型](REPORT-SEMANTIC-JEV.md)。
- `data/semantic-final-selection.json` 与 `semantic-final-approval.json` 是当时的选型/确认快照；其“待接入”状态描述记录当时，不代表最新产品发布状态。

报告与实验工具保留原来的历史语境。大量原始按键、物理熵、输入法输出、逐条公开数据文本、训练权重、评测明细与个人路径仅留本地档案，不随 Git/npm 发布；报告中这些路径是档案入口，公开 checkout 不含对应文件。原始研究没有因产品接入被重写成一次新的盲测。

因此公开工具并非一键重现全部私人研究数据。产品回归 `npm run semantic:test` 使用公开固定权重与少量明确的测试句，无需原始档案。原始档案的哈希、数据角色与选择过程见各轮报告；模型发布附独立 SHA-256。

`tools/semantic-jev-run.py` 公开版本已移除账户专属 Secret 引用，支持环境变量 `TYPESAFE_API_KEY` 或 `TYPESAFE_NUTO_SECRET_REF`。原版本留本地封存，已有实验使用的请求/代码哈希不因此改写。云端试验要求单独授权文件；产品不调用 Jev。

最终同一批 675 条既有回归：R13 异常 89/104、正常提示 4/301、上下文提示 14/270；Jev 折中阈值分别为 78/104、2/301、7/270。标注由助手完成，不能当作独立人工金标或总体准确率。完整权衡见最终选型报告。
