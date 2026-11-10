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

正式 npm 标签、registry 制品核对和本机安装结果在完成后追加；上述候选验证不替代公开 registry 与真实 desktop 验收。
