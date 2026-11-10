# DSH 0.2.2-rc.1 插件「更新」卡在「停止并移除旧版本」

> 这是一份可直接提交给 DSH 反馈/issue 的复现记录。记录时间 2026-11-09，Windows，DSH Desktop 0.2.2-rc.1。
> 涉事插件：`dsh-zh-typo-check`（第三方组合包，1 个 Loader 行，`immediately: true` 的客户端模块）。

## 现象

插件页点「更新」（0.1.3 → 0.2.0，以及 0.2.0 → 0.2.1），进度弹窗停在第二步，按钮一直显示「正在更新」：

```
✓ 检查 0.2.1
○ 停止并移除 0.2.0
  正在更新
```

没有超时、没有错误提示；等几分钟也不动。强制退出/重启 DSH 后，profile 留下半截状态：
`dsh.profile.bundles` 已去掉该插件、`dependencies` 仍是旧版本、`node_modules/dsh-zh-typo-check` 文件已不在
→ 插件不加载（输入框功能消失，插件详情页也没有插件注册的配置区块）。

## 证据

### 1. plugin-operations journal

`%APPDATA%\@deepseek-ai\dsh-desktop\plugin-operations\operations.jsonl`：

```json
// 第一次：更新 0.1.3 → 0.2.0，卡死
{"reason":"remove","target":"dsh-zh-typo-check","stage":"remove","version":"0.1.3",
 "phase":"started","time":"2026-11-09T07:59:30.421Z"}

// 对照组：插件当时处于禁用状态，走「添加插件」安装，同一个 remove 1.4 秒完成
{"reason":"remove","target":"dsh-zh-typo-check","stage":"remove","version":"0.1.3",
 "phase":"started","time":"2026-11-09T08:36:37.027Z"}
{"reason":"remove","target":"dsh-zh-typo-check","stage":"remove","version":"0.1.3",
 "phase":"settled","application":"applied","changed":true,"time":"2026-11-09T08:36:38.479Z"}

// 第二次：更新 0.2.0 → 0.2.1，插件处于运行状态，再次卡死
{"reason":"remove","target":"dsh-zh-typo-check","stage":"remove","version":"0.2.0",
 "phase":"started","time":"2026-11-09T08:40:53.310Z"}
```

两次卡死的 `remove` 都**没有 `settled`/`unknown` 记录**，说明宿主侧操作一直没结束；两次都是用户强制重启 DSH 才恢复。

### 2. pnpm 日志

对应操作目录 `.plugin-manager/logs/operation-*/pnpm.log` 内容为：

```
? Verifying lockfile against supply-chain policies (22 entries)...
✓ Lockfile passes supply-chain policies (22 entries in 211ms)
Lockfile is up to date, resolution step is skipped
Already up to date
```

移除流程里的一次 `pnpm install` 输出到这里，之后没有新的输出，也没有 `pnpm remove` 的记录。
**校正（2026-11-10）：这些文字不能证明 pnpm 进程已经退出**，日志没有进程退出标记。
现阶段证据把问题限定在宿主移除/HMR 与包重组路径，具体等待在哪一个 await 仍需进程/阶段跟踪，不能只凭此日志排除子进程问题。

### 3. 对照实验：不经过更新器的卸载/加载完全正常

不走「更新」按钮，直接修改 profile manifest 的 `dsh.profile.bundles`（HMR 监听到后自动重载）：

```
08:44:34 apply start ... settings={...}          ← 0.2.1 启用
08:44:34 route registered at /zh-typo-model
08:44:34 [client] settings bridge attached to zh-typo-check

08:44:48 released: download aborted, model unloaded   ← 从 bundles 移除，卸载完成
08:45:03 apply start ... settings={...}          ← 再启用，0.2.1 重新加载成功
```

宿主与客户端都在 0.2 秒级完成停止/加载，说明**插件本身的卸载与热加载没有问题**，
问题范围收窄到 plugin-manager 的 update 路径（`updateBundle → removeBundle → change + hmr.runExclusive → reload`）。

### 4. 半截状态

强制重启后 profile 内容（重启前更新卡死）：

```json
"dependencies": { "dsh-zh-typo-check": "0.2.0" },   // 旧依赖还在
"dsh": { "profile": { "bundles": [ ... 无 dsh-zh-typo-check ] } }
```

同时 `node_modules/dsh-zh-typo-check` 已不存在。即 remove 流程改了一半 manifest、删掉了包目录，
但没有完成安装/回滚，也没有任何错误上报。

## 排查线索（推测）

- `removeBundle()` 在 `withFileLock(profile/package.json)` 内执行，并通过 `configure()` 进入
  `hmr.runExclusive(...)`，随后 `selectBundle(false)` 改写 manifest、`reload()` 触发 HMR 重组合。
- HMR 重组合会刷新 runtime resolution（日志里那次 `pnpm install`），刷新完成后卡住。
- 对照：同一次 remove 在插件**禁用**时 1.4 秒完成；插件**运行中**时必卡。怀疑更新路径里存在
  「文件锁 ↔ HMR 事务 ↔ runtime resolution 刷新」的相互等待，或某个 await 没有超时。
- 该路径目前没有超时、没有把中间态写进 journal，失败后也没有回滚 manifest，用户只能重启。

## 规避方式（插件作者/用户侧）

1. 升级前先在插件页把该插件**关闭/禁用**，再点「更新」；更新完成后重新启用。
2. 或者退出 DSH，在 profile 里直接用 pnpm 升级，再启动 DSH。
3. 卡住后不要反复点更新，避免 profile 反复进入半截状态；重启后如插件消失，
   需要重新启用/重装（本次用 `dsh.profile.bundles` 加回并热加载修复）。

## 期望

- 更新操作应有超时与明确失败上报（至少把 started 补成 settled/unknown）。
- 失败/中断时应把 manifest 与 node_modules 回滚到更新前状态（或提示如何恢复）。
- 建议检查 `removeBundle` 在「插件运行中」被更新路径调用时的锁/事务顺序。

## 2026-11-10：0.2.3 升 0.3.0 现场与恢复验证

真实 desktop profile 再次出现：依赖声明仍为 `0.2.3`，bundle 选择中已无该插件，安装目录缺失。操作日志本次为：

| UTC 时间 | 阶段 | 结果 |
| --- | --- | --- |
| 2026-11-10 08:49:14.140 | remove 0.2.3 started | 界面停在“停止并移除” |
| 2026-11-10 08:59:16.731 | remove 0.2.3 settled | failed、changed=true、errorCode=operation-error |

本次最终约十分钟后返回失败，因此不能称此现场永久没有 settled。失败后上述半截状态仍在；新插件尚未安装。提取安装中的实际 Host 模块确认版本为 `0.2.2-rc.1`，不使用旧 SDK 副本代替现场版本。该定位尚不足以断言某个具体锁死循环已经证实。

在宿主记录 failed 之后，通过原生 UI 辅助功能树复核，更新弹窗仍显示“检查 0.3.0 → 停止并移除 0.2.3”和禁用的“正在更新”。界面也未反映宿主已经失败的终态；这与仅等待包下载的情况不同。

新增 [tools/repair-upgrade.ps1](../tools/repair-upgrade.ps1) 与[恢复步骤](升级卡死恢复.md)。在全新的无账号 profile 模拟同样半截状态，使用官方 CLI 从 npm 安装精确 `0.3.0`，补回启用记录；原有偏好文件和 27,092,583 字节的真实 R13 模型 SHA-256 不变，无关 manifest 字段保留，启用条目只出现一次。恢复后的真实 DSH Host 启动并注册检查路由成功，原问题句得到 R13 warning=true、margin=13.770684242248535。验证时间 `2026-11-10T09:05:42Z`，临时本机测试服务在验证后停止。

脚本在真实桌面进程仍运行时拒绝执行；测试前后核对真实 desktop manifest 字节相同。本节仅证明离线恢复路径，未修改已安装的 app.asar，也未声称已经修好 DSH 的热更新实现。真实 desktop 的恢复与验收另在对应 issue 记录。

Windows PowerShell 5.1 与 PowerShell 7 均实际执行恢复通过；已覆盖重复安装已有0.3.0但未启用的恢复分支。脚本可先用 `-PlanOnly` 预览。

### 真实 desktop 已恢复

用户保存草稿并完全退出后，于 `2026-11-10T09:12:53Z` 完成实际 profile 恢复：官方 CLI 将0.2.3升级0.3.0，启用记录恢复，检查偏好文件与已有两份模型哈希一致。正常启动原桌面应用后，原生 UI 确认组件运行中、当前版本0.3.0、已是最新版本；选定的27MB整句模型已下载、SHA-256匹配冻结值并显示就绪。

`2026-11-10T09:19:59Z` 在实际桌面的检查接口复验：原句R13提示为true，正常gRPC混排及英文对照为false，旧错字模型仍提示“还→话”。真实检查偏好文件仍与恢复前逐字节相同。可机读结果在 `data/upgrade-recovery-verification.json`，本地界面证据在 `.research/updater/live-recovered-desktop.png`；未发送聊天消息。
