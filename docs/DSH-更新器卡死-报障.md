# Windows 插件升级卡住：原生运行时文件占用

2026-11-10，在 Windows、DSH Desktop/Host **0.2.2-rc.1** 复现。DSH 的热更新路径会停止旧插件，再执行 `pnpm remove`。旧插件导入 `onnxruntime-node` 后，Windows 仍把原生 DLL 映射在 Host 进程中；释放模型会话和注销 Cordis 插件不能释放这些文件。包移除因此停滞，最终触发无输出超时。

这是宿主更新器对 Windows 原生依赖的处理缺口，同时可以在插件侧通过隔离原生运行时解决本插件的触发条件。不能据此推断所有用户、平台或插件都会卡住。

## 现场与可重复的对照

原现场为中文检查 0.2.3 升 0.3.0：`remove` 于 `08:49:14.140Z` 开始、`08:59:16.731Z` 以 `failed/operation-error` 结束。失败后依赖仍声明旧版本，启用列表已去掉插件，包目录缺失；原生界面仍显示“正在更新”。完整 pnpm 日志最后为：

```text
Lockfile is up to date, resolution step is skipped
Already up to date
dsh: pnpm printed nothing for 600000ms and was terminated
```

`Already up to date` 不能当作进程退出证据。此前记录中“刷新运行时会执行 pnpm install”和“HMR 死锁”的推测已由阶段跟踪纠正：`configure/reload` 已完成，真正停滞的是随后执行的 **`pnpm remove dsh-zh-typo-check`**。

独立 profile 通过实际安装中的官方 CLI 启动，不使用账号、凭据或模型云端请求。为缩短失败试验，只在这些隔离 profile 将 `idleTimeoutMs` 从 600000 调成 5000。

| 对照 | 结果 |
| --- | --- |
| 原 0.2.3，不读取模型状态、不导入原生库 | 热更新至 0.3.0 成功，约 7.29 秒 |
| 原 0.2.3，只请求一次模型 status | `pnpm remove` 无输出超时，约 8.60 秒后失败 |
| 文件占用探针 | 导入前可用 `r+` 打开；导入后 `onnxruntime.dll`、`onnxruntime_binding.node` 报 `EBUSY` |
| 子进程修复源码作为旧版本运行，再更新至已发布 0.3.0 | 约 7.30 秒成功；`pnpm remove` 开始前两文件已恢复可写 |
| 冷安装 0.3.1 候选 npm 包，加载两套真实模型后卸载 | 成功，配置和模型哈希保留；详见机读验证记录 |

源码替换试验保留旧版 package.json 以使用真实 registry 更新流程，不能称作正式 0.3.1 发布。冷安装包试验单独验证打包完整性。原始阶段日志保存在本地 `.research/updater/`；公开摘要见 [data/upgrade-native-verification.json](../data/upgrade-native-verification.json)。

## 插件侧修复

0.3.1 候选把原有模型路由及 ONNX 推理移入按需启动的私有 IPC 子进程；DSH Host 保留配置和模型文件的 Range 流式分发。卸载先注销路由，再停止接收检查、等待检查结束及子进程真正退出，之后 DSH 才继续移除依赖。异常退出可在下次请求时重启检查进程；请求超时和停止超时只终止插件自身的子进程，完成退出后再释放卸载。

模型、阈值和建议保持不变，磁盘上不增加第二份运行时或模型。代价是一个额外进程及其内存；对照结果记录实际延迟与进程工作集，不能把模型的 27.44 MB 当作整个应用的内存用量。

旧版已经把 DLL 加载进 Host 的用户，**第一次切换到修复版仍须完全退出 DSH 后安装**。只禁用旧插件不能保证解除文件占用；当前已卡住时使用[离线恢复步骤](升级卡死恢复.md)。用户真实 desktop 已恢复为 0.3.0，未用根因试验覆盖它。

## DSH 仍需处理的部分

- 原生依赖无法在当前 Host 内移除时，应采用重启后更新或其他明确的安装策略。
- 包操作失败后，应恢复可用状态或给出准确的恢复入口。
- `operation` 已失败时，更新弹窗应结束等待并显示错误与下一步。

插件修复减少本插件的触发条件，没有修改已安装的 DSH `app.asar`，也没有修好宿主对其他包操作失败的界面处理。本记录尚未代用户发送给上游。

参考：[实际版本的 update/remove 实现](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/plugin-manager/src/index.ts)、[Windows DeleteFile 对映射文件的限制](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-deletefile)。

## 复验

```powershell
# 旧版：导入原生库后，实际卸载应被记录为超时失败。
python tools/dsh-upgrade-smoke.py --dsh-exe 'D:/deepseek-harness/DeepSeek Harness.exe' --installed-spec dsh-zh-typo-check@0.3.0 --with-models --operation remove --expect failed

# 当前 bundle 源码作为旧版本执行，走真正的更新流程。
python tools/dsh-upgrade-smoke.py --dsh-exe 'D:/deepseek-harness/DeepSeek Harness.exe' --candidate-source

# 本地打包后冷安装，运行两套模型、验证 Range、实际卸载。
python tools/dsh-upgrade-smoke.py --dsh-exe 'D:/deepseek-harness/DeepSeek Harness.exe' --installed-spec '<本地 tgz 的绝对路径>' --with-models --operation remove
```

完整模型试验读取本仓库已缓存的公开模型；不读取真实 desktop 的模型或账号。每次创建全新测试 profile，命令失败会保留 receipt 和日志以便排查。
