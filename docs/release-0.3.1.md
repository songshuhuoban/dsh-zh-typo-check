# 0.3.1 发布与升级

2026-11-10，SIM-1053。用户已批准合并 PR #3、正式发布 0.3.1 并完成本机升级。

## 修复

Windows 上，旧版在 DSH Host 内导入的原生推理库会持续占用 DLL，停止插件后 `pnpm remove` 仍可能超时。0.3.1 把原有模型服务放进按需启动的私有 IPC 子进程，卸载等待它真正退出后再由 DSH 移除依赖；模型文件继续由 Host 流式分发。

原句检出、正常中英混排和英文不提示、旧“还→话”建议均保持一致。模型、词表和阈值不变，输入继续在本机处理。新增一个推理进程；首轮单机双模型工作集合计约增加 71 MiB，实际延迟有波动。

## 升级步骤

从 0.3.0 或更早版本首次切换时，保存草稿并完全退出 DSH（含托盘），再运行 `tools/repair-upgrade.ps1`。脚本默认安装精确 0.3.1，保留并校验模型和检查配置，安装后恢复启用记录。只禁用旧插件不能保证解除旧 Host 中的文件占用。

## 发布前验证

- [PR #3](https://github.com/songshuhuoban/dsh-zh-typo-check/pull/3) 已合并，合并提交 `1f3fc0630be92eeefff4e9240798319739a71fcb`。
- 候选源码已通过完整真实 DSH registry 更新，以及最终 tarball 冷安装、两套真实模型加载和实际卸载；配置、模型哈希和 Range 流保留。
- `npm test`、原生进程崩溃恢复/超时/重复释放/父进程退出、真实模型路由与损坏降级、Host correctness lint 均通过。详见 [根因验证](../data/upgrade-native-verification.json)。

## 正式发布完成

官方 registry 于 `2026-11-10T10:26:28Z` 确认 **latest=0.3.1**。发布源码为 `8716cfd23f9dcd4b0846b5b683ab2f48d118765a`，registry `gitHead` 与其一致。压缩包 1,233,038 字节、28 个文件，逐文件及 SHA-1/SHA-512 均与发布预检一致；SHA-256 为 `e55f5a84f3c57fd85752699667bbecbc433992c5487344a839220368f5e0cfa6`。

[GitHub v0.3.1](https://github.com/songshuhuoban/dsh-zh-typo-check/releases/tag/v0.3.1) 已公开，包含 npm 压缩包、默认安装 0.3.1 的 `repair-upgrade.ps1` 和 `upgrade-recovery.md`。`next` 仍指向历史 0.3.0；常规安装的默认渠道 `latest` 已更新。

全新无账号 profile 从公开 registry 安装后，28 个安装文件与发布包逐字节相同。两套真实模型、原句提示、正常混排与英文对照、旧错字建议及 Range 流验证通过。本机 registry 验收入口为 `http://127.0.0.1:65055/`，属于独立测试环境。

## 实际桌面升级完成

首次从旧版 0.3.0 点击热更新再次卡在旧版移除，0.3.1 尚未装入。用户保存草稿并完全退出 DSH 后，官方 CLI 于 `2026-11-10T10:31:49Z` 恢复实际 desktop 为 **0.3.1、已启用**；配置备份及 receipt 保留，检查配置与已有 3 个模型/分词文件哈希不变。

正常重启后，原生界面确认 0.3.1、组件运行中、已是最新版本、两套模型就绪。`10:37:52Z` 的真实桌面 Host 冒烟中，原句 R13 warning=true、score=13.770684242248535，正常 gRPC 混排与英文 warning=false，旧“还→话”仍可检出。实际 Host 未映射本插件的原生库；`onnxruntime.dll` 与原生绑定位于单独模型子进程，隔离已生效。未发送聊天消息。

可机读证据见 [data/release-0.3.1-verification.json](../data/release-0.3.1-verification.json)，本地界面证据为 `.research/release-031/live-desktop.png`。工程交付完成，SIM-1053 进入产品待验收；未修改已发布制品或 DSH 的签名运行时。
