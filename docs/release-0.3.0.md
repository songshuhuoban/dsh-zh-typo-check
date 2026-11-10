# 0.3.0 安装配置验收

2026-11-10，SIM-1051。交付为 R13 本地中英文混排整句异常提示，保留可选中文错字模型。研究选择与模型哈希冻结，不增加云端调用。

## 用户故事与修正

| 用户目标 | 发现的缺口 | 本次处理与验证 |
| --- | --- | --- |
| 装好并启用 | pnpm 会拦截原生运行时脚本，CLI 安装不会自动启用插件 | 明确放行 onnxruntime-node、重试、立即启用和重启；冷安装与实际插件开关已验证 |
| 知道该下载什么 | 旧说明只有 104 MB 错字模型，整句开关写成实验且跳过混排 | 独立 27 MB 整句卡片；可单独安装，标题与中英文说明同步 |
| 判断是否真的检查 | 0 个具体错字会掩盖整句告警或模型未就绪 | 分开显示两种模型状态与结果；无模型、超长、失败不等于正常 |
| 下载失败后恢复 | 下一次轮询把失败状态覆盖成未安装 | 保留失败原因与重试；损坏校验、取消和临时文件清理已验证 |
| 使用自己的 profile | 旧代码可能从默认 desktop 路径读模型 | 优先宿主 profileContext.dir；故意设置错误环境路径的隔离测试通过；实际新 profile 两模型均 absent 后单独下载 R13 |
| 重启后继续用 | 浏览器端缓存不能证明配置持久化 | 关闭整句开关写入 cordis.patch.yml，重启换端口后仍关闭，模型仍保留 |
| 检查原始输入 | 旧模型的混排保护导致整句跳过 | 实际输入原句显示蓝色虚线和“整句意思可能不连贯”；仅忽略、没有整句替换；gRPC 正常混排无此标记 |
| 删除或卸载 | 两种模型容易混淆，原生会话可能残留 | 独立删除，等候在途推理结束再释放；删除与卸载回归通过 |

## 首轮实际 staging 记录

- DSH Desktop 提供的 web profile 运行时：0.2.2-rc.1；Windows x64，独立 DSH_HOME，无用户账号或真实 API Key；未发送聊天消息。
- 候选 npm 包：0.3.0。冷安装本地压缩包后启用，停止宿主再重装修正版，未向运行中的用户桌面热装。
- 最后一次首轮启动：2026-11-10，`http://127.0.0.1:51974/`，仅本机且需宿主认证。端口是本次运行值，非长期公开服务地址。
- 模型通过公开 GitHub Release 实际下载；匿名下载复核 27,092,583 字节与固定 SHA-256 一致。
- 新 profile 文件总量约 332 MB（含原生运行时、多平台随附文件、包管理数据及 R13；不含 DSH 本体和共享包缓存），低于 600 MB；模型及词表约 27.44 MB。
- 原问题句提示、正常混排无标记、实际设置页及重启持久化证据保存在本地 `.research/r13-product/`。认证 URL、日志中的 nonce、原始训练数据不进入公开报告。

本轮实际 UI 验收沿用现有视觉样式；用户明确调整为本任务无需 OpenPencil。公开 registry 安装、最终发布版本与入口将追加在本文件，首轮本地包验收不冒充 registry 安装。

## 公开 registry 安装与重启

2026-11-10 完成：npm CLI 经用户浏览器双重验证发布 `dsh-zh-typo-check@0.3.0` 到 `next`，在官方 registry 可查询后，从全新 profile 的插件页输入精确版本安装。默认安装源下实际经历“需要允许安装脚本 → 允许 onnxruntime-node@1.30.0 并重试 → 已安装 → 立即启用”，整个流程通过。

registry 压缩包 1,232,132 字节，SHA-1 `3a15b47cabf51547aa11cb99d130e87dbf101db9`；SHA-512 integrity 与 registry 元数据一致，25 个文件逐字节匹配发布候选。registry `gitHead` 为 `58664c60c6695ceb59bd66745ef4b2f5fa97e3ac`；安装后再逐文件核对，完全一致。

通过设置卡片从默认公开 Release 下载 R13，未安装可选错字模型。重启宿主、换端口后再次验证：

- 验证时间：`2026-11-10T08:34:04.567254+00:00`；本机验收入口 `http://127.0.0.1:63801/`，需要当前浏览器认证。
- 0.3.0 与 Native ORT 1.30.0；整句模型 27,092,583 字节、SHA-256 与冻结值一致；可选错字模型保持 absent。
- 原始问题句 warning=true、margin=13.770684242248535；正常 gRPC 混排及英文对照 warning=false；超长输入 warning=null，无截断判断。
- 实际输入框再次显示蓝色虚线与“整句意思可能不连贯”气泡，仅有忽略；未发送聊天消息。
- 实际 screenshot 与接口核对记录分别为本地 `.research/r13-product/registry-original-warning.png`、`registry-smoke.json`、`registry-verification.json`。

正式默认标签的提升属于 npm 单独的双重验证操作；最终标签与源码合并记录随发布完成追加。已结束首轮本地压缩包宿主，保留此 registry 版本验收环境。

## 初始发布检查点

PR [#1](https://github.com/songshuhuoban/dsh-zh-typo-check/pull/1) 已合并，main 合并提交 `8d833cf53d45c6c14066fa6a0aea7dd173c7efc4`；[GitHub v0.3.0](https://github.com/songshuhuoban/dsh-zh-typo-check/releases/tag/v0.3.0) 已公开发布。

此检查点 **next=0.3.0、latest=0.2.3**。0.3.0 上传已完成，但提升默认标签时 npm 再次要求独立浏览器 2FA；该次链接已过期，操作未完成。现在可直接安装 `dsh-zh-typo-check@0.3.0`。恢复时重新发起 `npm dist-tag add dsh-zh-typo-check@0.3.0 latest --registry=https://registry.npmjs.org --auth-type=web`，由用户在新页面完成验证，再查询标签并更新此检查点；不能重用过期链接或把 next 发布冒充默认版本已更新。

可机读核对入口：`data/release-0.3.0-verification.json`。工程交付进入待产品验收，尚不代表用户已完成产品验收。

## 正式发布完成

2026-11-10，用户在新页面完成 npm 双重验证，命令返回 `+latest: dsh-zh-typo-check@0.3.0`，随后官方 registry 确认 **latest=0.3.0、next=0.3.0**。默认安装已指向新版本，前述待提升状态为历史检查点，已解除。

提交、推送、主分支合并、模型与插件公开发布、registry 冷安装及重启冒烟均已完成。运行时代码仍是 npm gitHead `58664c60c6695ceb59bd66745ef4b2f5fa97e3ac`，后续提交仅补充交付记录；未修改已发布 npm 制品。SIM-1051 进入待产品验收，未将模型选型确认冒充完整产品验收。

## 自动验证

`npm test`、`npm run config:test`、`npm run model:test`、`npm run infer:test`、`npm run resilience`、`npm run semantic:test` 通过。整句测试使用真实固定权重，覆盖下载、错误、取消、删除、整句/错字独立路由、超长弃权与 profile 隔离。

产品分词器 4,700 次对齐零差异；675 条已知回归的 Native ORT 1.30.0 原始 margin 与决策零差异。此为接线一致性验证，模型效果仍受助手标签、已知集合和上下文误报限制，详见 MODEL-R13.md。Windows 之外未做本次真实 UI 验收。
