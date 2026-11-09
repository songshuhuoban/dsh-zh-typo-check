# DSH 输入框中文词语检查 — 调研与设计笔记

## 一、DSH 输入框的真实结构

输入区不是 `<textarea>`，是 **shell 自带的 Lexical 编辑器**。从打包产物 `@deepseek-ai/dsh-client-ui-conversation/lib/client.js`
里挖出来的公开锚点（这些 `data-composer-*` 属性是刻意留的，可以安全依赖）：

| 选择器 | 含义 |
| --- | --- |
| `[data-composer-card]` | 整个输入卡片（下划线层的定位基准） |
| `[data-input-scroll]` | 文本滚动容器（滚动时要重算矩形） |
| `[data-composer-input]` | contenteditable 根节点（Lexical 的 root element） |
| `[data-composer-overlay]` | 浮层锚点，`position:absolute; inset:0 0 auto; height:0` |
| `[data-composer-composing]` | **输入法组合中**，检查必须完全静默 |
| `[data-lexical-decorator]` | 文件/命令 chip，占 DOM 但不算正文 |

编辑器内部的节点类型：普通文本、`composer-text-ref`（可编辑的 `/命令`、`@路径` 文本实体）、
装饰器节点（chip）。内容按 `<p>` 分段，样式 `white-space: pre-wrap; word-break: break-word`。

## 二、可用的扩展点

| Slot | 能拿到的 | 用途 |
| --- | --- | --- |
| `conversation.input.overlay` | `useInput`（`draft`、`draftRev`、`phase`…）、`inputActions` | 下划线层、问题面板 |
| `conversation.input.left` / `.right` | 无 | 工具条上的开关按钮 |
| `settings.general.item` | — | 设置项 |
| `shell.overlay` | — | 全屏浮层（不需要） |

`inputActions` 的公开面（已确认）：

```js
captureInsertion()            // -> { start, end, draftRev }
insertText(text, span)        // 带 draftRev 守卫的区间替换，返回 boolean
setDraft(text)                // 整体替换（会丢 chip，慎用）
insertQuote(text)
```

**替换单个错字用 `insertText(fix, { start, end, draftRev })`**，revision 不匹配会返回 false，
天然避免"检查结果过期把用户刚打的字覆盖掉"。

## 三、下划线方案：不用镜像 div

常见做法是"透明 textarea + 背后镜像层"，靠字体度量对齐，chip 一出现就崩。

这里改用 **DOM Range 测量**：
1. 遍历 `[data-composer-input]` 下的文本节点，跳过 `[data-lexical-decorator]` 子树，
   建一张 `draft 偏移 -> (文本节点, 节点内偏移)` 的表；
2. 对每个问题区间 `range.setStart/setEnd` 后取 `getClientRects()`；
3. 在 overlay 里按矩形画波浪线（`pointer-events:none`）；
4. `draftRev` 变化、滚动、`ResizeObserver` 时重算。

像素级精确，不受字体、换行、chip 影响。

## 四、判定内核

`src/core.mjs`：纯函数、零依赖、无 DOM。

```
check(text, { minConfidence }) -> Issue[]
Issue = { start, end, text, kind, message, suggestions[], confidence }
```

管线：**遮罩 → 词表最长匹配 → 词边界校验 → 上下文规则 → 标点/重复字规则**。

词表 205 条，全部是「错误写法本身不是词」的条目（成语误字、同音成词），宁缺毋滥。

**词边界校验**（`CROSSING_WORDS`）只对二字错形生效：错形的前一字和首字能组成词
（`可`+`以`=可以），或末字和后一字能组成词（`便`+`宜`=便宜），就说明这次命中跨了词边界，丢弃。
没有它，`以经` 会在「可以经常」里被误报。四字成语自带边界，不走这条，否则会漏报。

**上下文规则**补词表天生抓不到的单个同音字，目前一条：句末 `的还` → `的话`
（`他的还行` 跟的是「行」，不会误报）。

遮罩先吃掉：围栏代码块、行内代码、URL、邮箱、`@引用` / `/命令`、Windows/Unix 路径、版本号、英文标识符。
这些不该被当中文判断。

## 五、当前成绩与已知天花板

`node src/demo.mjs`：18 条真实句子 **18/18** 全中（在次、迫不急待、一如继往、甘败下风、
谈笑风声、按耐不住、契而不舍、句末「的还」、半角标点、重复标点），代码/路径/`的的确确`/正常句子 **零误报**。

`node src/adversarial.mjs`：16 条正常句子 **误报 0**。

上一版这里还有 2 条误报，都是同一个根因：

- `现在在现场…` → `在在`
- `他存在在这里…` → `在在`

修法不是分词器，而是一个小而准的观察：**叠字是否笔误，取决于它是不是跨了词边界**。
`现在|在` 里的 `在在` 合法，`但是|是` 里的 `是是` 却是真笔误——同样两个字，
区别只在前面那个字。所以按功能字维护一张「前字白名单」（`REPEAT_BLOCKERS`），
`在` 和 `了` 各一张，`是` 故意不进表。

同一轮里还发现：新加的二字错形（`围巢`、`肆业`、`循私`、`全愈`）会落进更长合法词的肚子里
——`包围|巢穴`、`大肆|业务`、`遵循|私人`、`安全|愈发`。这四组用 `GUARDS` 的左邻字挡住了，
并写进了 adversarial 测试集。**这类问题会随词表增长而线性增多，正是 L1 分词边界要解决的。**

## 五点五、边界问题的通用解：CROSSING_WORDS

真实报障「我到上海住的还，可以经常包斯成晚餐咯~」同时暴露了两类错：

| 现象 | 根因 | 属于 |
| --- | --- | --- |
| 误报 `以经`（在「可以经常」里） | 词表匹配不管词边界 | L0，可修 |
| 漏报 `还`（应为「话」） | 单个同音字，词表里没有 `的还` 这个"错形" | L1，残缺 |

第一个是边界问题，通用解不是继续加 `GUARDS`，而是拿一张高频二字词表做**跨边界判定**：
`可`+`以`、`便`+`宜`、`经`+`常` 都是词，说明错形被词切开了，丢弃。一张 ~300 词的
`CROSSING_WORDS` 就替掉了逐条打补丁，`以经`/`在见`/`既便` 三个隐患一次解决。

第二个是上下文问题：`的还` 不是任何词的错形，唯一线索是它后面跟了停顿。
只能写成上下文规则（`的还` + 标点/句尾 → `的话`）。**这类规则是 L1 之前的权宜之计**，
每一条都要手写，覆盖不了长尾——想系统解决就得靠字符级 n-gram 打分。

## 六、分层路线（按 ROI）

| 层 | 内容 | 体积 | 延迟 | 解决 |
| --- | --- | --- | --- | --- |
| L0 | 词表 + 规则 + 分词边界 | ~100KB | µs | 同音/形近选错、成语固定搭配、标点 |
| L1 | 拼音混淆集 + 字符 n-gram 打分 | 30–50MB | <1ms | 上下文选字（"这里在次" vs "再次"） |
| L2 | 小模型（ONNX，quantized） | 10–20MB | 10–50ms | 语义搭配（"改善效率"→"提高效率"） |
| L3 | agent 深度校对（按需） | 0 | 1–3s | 语法/语义/风格，返回 diff |

L3 是 DSH 独有的一层（飞书没有 agent），建议作为差异化做。

## 六点五、延迟策略：不防抖，用同帧

`node src/bench.mjs` 的实测（Windows / Node 24）：

| 草稿长度 | median | p95 |
| --- | --- | --- |
| 60 字 | 7.5 µs | 17.8 µs |
| 400 字 | 41.6 µs | 115 µs |
| 1000 字 | 98.0 µs | 227 µs |
| 3000 字 | 485 µs | 787 µs |
| 10000 字 | 2730 µs | 3752 µs |

结论：一段正常草稿的判定成本比一帧（16.7 ms）低两到三个数量级，**防抖只会让下划线迟到**。
所以：

- **判定同步跑**：`useLayoutEffect` 里直接 `check()`，下划线和文字落在同一次绘制。
- **测量也同帧**：同一个 layout effect 里 `Range.getClientRects()`，不占额外一帧。
- **按文本缓存**：同一段文字的重判定命中缓存；几何位置永不缓存（同样的字可能挪位置）。
- **只在超长文本降级**：`> 4000 字`（粘贴整篇文档）才走 140ms 防抖。
- **滚动/缩放按帧合并**：rAF 节流，一次拖动只重算一次。
- **输入法**：组合期（`data-composer-composing`）完全静默；`compositionend` 后强制重测一次
  （IME 提交有时不改草稿文本，只移除属性）。

## 七、工程红线

- 输入法组合期（`data-composer-composing`）完全静默
- 精度优先：默认只报 `confidence >= 0.9`
- 用户可一键忽略、加入本地词典
- 的/地/得、其它/其他、布署/部署 这类有争议的不强报
- 不读别的插件的样式去"估算位置"；这里的 DOM 读取是为了**精确测量真实文本**，性质不同

## 八、工具

`tools/asar.mjs` —— 无需 Electron 就能读 `app.asar`（`ls` / `cat`），
用来看打包后的 DSH 源码：

```
$env:OUT_FILE='out.js'; node tools/asar.mjs cat dsh/node_modules/@deepseek-ai/<pkg>/lib/client.js
node tools/asar.mjs ls dsh/node_modules/@deepseek-ai
```

`.research/vendor-src/` 是已解出的三个客户端 bundle，供检索。

> 注：`.acl-recovery/` 是修复本工作区 Windows 文件权限时生成的回滚资料，保留勿删。

## 九、已落地的实现

插件包：`bundle/`，安装名 `@local/zh-typo-check`（profile `desktop`）。
安装是 **link** 到本目录，所以改完源码只要重新 build + 刷新页面，不用重装。

```
src/core.mjs     判定内核（纯函数，可 node 直接跑）
src/editor.mjs   DOM 文本 <-> 草稿偏移映射，可单测
src/client.js    客户端 UI 模板（含 /*__CORE__*/ 与 /*__EDITOR__*/ 两个拼接位）
tools/build-client.mjs   把上面两个模块拼进 bundle/client.js
bundle/          package.json / cordis.patch.yml / index.js / client.js / locale / icon
```

注册点：`conversation.input.overlay`，id `zh-typo-check`，order 10。

交互：悬停波浪线 → 浮出「原文 → 建议」气泡，可「替换」或「忽略」；直接点波浪线等于替换。
替换走 `inputActions.insertText(fix, { start, end, draftRev })`，revision 过期会被拒绝而不是覆盖。
「忽略」对词类问题会写进 `localStorage` 的 `dsh.zh-typo-check.ignored`，对标点只忽略当次。

**已知限制**：草稿里有文件名 chip（`@文件`）时，DOM 文本与草稿文本会分叉；此时只检查
分叉点之前的部分，而不是整段失效。

验证状态：JS 语法通过、manifest 通过、客户端 slot occupant 已 live（`active: true`）；
**视觉未验证**——本会话没有浏览器控制，无法截图确认波浪线位置与气泡样式。


## 十、可下载模型：实现进度

| 件 | 状态 |
| --- | --- |
| 宿主侧模型服务（下载/校验/分发/删除） | 已实现，`tools/model-service-test.mjs` **15 项全过** |
| 模型选型 | `Xenova/macbert4csc-base-chinese` int8 98.8 MB，留出集 F1 91.9% |
| 国内镜像 | `hf-mirror.com` 实测 200，下载按「镜像 → 官方」逐线路重试 |
| 完整性 | 每个文件硬编码 SHA-256，错了删半成品换线路 |
| 设置页 `settings.section` | 已注册（id `zh-typo-check`，order 25），状态/进度条/下载/删除 |
| 客户端模型依赖 | **零**。`bundle/client.js` 47.9 KB，不含任何 ONNX 代码；未装模型时只有 L0 |

宿主模块是新的 module generation，**要重启 DSH 才生效**——重启前
`GET /zh-typo-model/status` 仍是 404，设置页会显示"宿主服务不可用"并提示重启。
## 十一、推理放哪儿：用数据定的

| 后端 | 单次推理 | 运行时体积 | 结论 |
| --- | --- | --- | --- |
| onnxruntime-node（宿主进程） | **21 ms** | 打包进 profile，无额外下载 | ✅ 采用 |
| onnxruntime-web（页面 WASM） | **135 ms** | wasm 13.6 MB 还得下载 | ❌ 慢 6.4 倍 |

单句要 6–12 次推理：WASM 就是 0.8–1.6 s，native 是 0.13–0.25 s。
所以推理放宿主进程，客户端只发一个 HTTP 请求，页面里连 wasm 都不用碰。

## 十二、宿主侧推理链（本轮完成）

| 件 | 验证 |
| --- | --- |
| 自写 BERT 分词器 `src/tokenizer.mjs` | **84/84 句逐 token 与 transformers.js 完全一致** |
| 推理封装 `src/infer.mjs` | 复现「还」→「话」（Δ=18.0），正常句零命中 |
| `GET /zh-typo-model/check?text=` | 端到端 11 项全过 |
| 稳态延迟 | 20 字 12 次推理 **256 ms**；冷启动 806 ms（含 763 ms 载模型） |
| 超长/空文本/无模型 | 各自有明确返回，不报错 |

### 两个必须记住的坑

1. **这个 int8 模型不是 batch 不变的。**
   把 12 个掩码位置堆成 batch 一次跑（258 ms → 123 ms），同一个位置单独跑首选是「话」，
   混在 batch 里变成「哥」。校验场景不能拿正确性换速度，已回退逐位置推理。
2. **`pnpm` 不会给本地 link 包装它自己的依赖。**
   插件以 `link:` 方式安装时 `onnxruntime-node` 不会被装上，模型在、运行时不在。
   现在 `status` 会返回 `runtime` 布尔值，设置页据此提示，`check` 返回 `state: "no-runtime"`。

### 还欠的一刀

`包斯成` 那处模型报的是 `包→休`（正解是 `包斯成`→汉堡），
因为宿主侧还没接"成词/同音"约束——这一层要 1.9 MB 词表（gzip 956 KB）。
接上之后误报会再降一档。
## 十三、产品路径实测（第 5 轮）

`tools/host-eval.mjs` 走的是**真正会发布的那条链**：客户端 L0 + 宿主 `check`（模型 + 词表约束）。

| 配置 | 精确率 | 召回率 | F1 | 干净句误报 | 单句耗时 |
| --- | --- | --- | --- | --- | --- |
| L0 + 宿主模型，**无词表约束** | 74.4% | 76.2% | 75.3% | 3/30 | 230 ms |
| L0 + 宿主模型，**有词表约束** | **86.5%** | 76.2% | **81.0%** | **1/30** | 191 ms |

词表约束带来 +5.7 F1、误报从 11 处降到 5 处。离线实验台的全配置是 91.9/81.0/86.1，
差的 5 个点就是**还没搬过来的 A 路**（同音候选 + 低阈值）。

### 试过但否掉的两个想法

1. **给"像话"的候选单独设低阈值**（2.5/5/8 都试了）。
   结果模型会放着明显更好的候选不用、去挑一个勉强成词的：L2 上报从 10 条涨到 97 条，
   F1 掉到 39.8。约束必须是**过滤式**的——先过滤再比强弱，不能先比强弱再按候选分档。
2. **批量掩码**（见第十二节）：快一倍，但 int8 模型 batch 不变性不成立。

### 已知局限

`包斯成` → `汉堡` 这类**多字错词**报不出来：模型只做单字替换，
`包→喝` 落在三字错误区间里算误报。要治它得在候选里允许"整词替换"。

## 十四、客户端接入

`TypoLayer` 里加了一层异步补报：

```
按键 → L0 微秒级同步出下划线（不变）
停手 400 ms → GET /zh-typo-model/check?text=... → 并进同一份下划线
```

- 只在文本变过才发请求；返回的 `text` 与当前草稿不一致就丢弃，杜绝错位
- 宿主没装模型时路由秒回空结果，客户端不需要特判
- `bundle/client.js` 51.4 KB，仍然只有一次 HTTP 调用，没有任何推理代码

bundle 现在带词表：`data/l1-words.txt` 1.9 MB + `l1-sounds.txt` 28 KB。
## 十五、A 路接上之后的数字（第 6 轮）

宿主 `checkText` 现在是完整两路，共用同一次前向：

| 配置 | 精确率 | 召回率 | F1 | 干净句误报 | 单句 |
| --- | --- | --- | --- | --- | --- |
| 只有 B 路（上轮） | 86.5% | 76.2% | 81.0% | 1/30 | 191 ms |
| **A + B，B 阈值 12** | **92.1%** | **81.4%** | **86.4%** | **0/30** | 234 ms |

离线实验台是 91.9/81.0/86.1——产品路径的精确率已经反超，因为多了一层「成词/同音」硬约束。

B 阈值扫描（A 路不变）：

| B 阈值 | 精确率 | 召回率 | F1 | 干净句误报 |
| --- | --- | --- | --- | --- |
| 10 | 90.0% | 83.7% | 86.7% | 1/30 |
| 11 | 90.0% | 83.7% | 86.7% | 1/30 |
| **12** | **92.1%** | **81.4%** | **86.4%** | **0/30** |
| 13 | 94.3% | 76.7% | 84.6% | 0/30 |
| 14 | 94.3% | 76.7% | 84.6% | 0/30 |

12 是拐点：再往上召回掉得太快，往下就开始在正常句子上画线。

## 十六、用户来的那句话，是这轮最有价值的一个样本

「我到上海住的还，可以经常包斯成晚餐咯~」

我一开始把它当成两个错：`还`→`话`、`包斯成`→`汉堡`。
**用户指出 `包斯成` 不是错字：包=承包，斯成是人名。**

- 语料已修正：这句的 gold 只有 `还`→`话`。
- 模型仍然报 `包`→`喝`，**这是一个真误报**，且调不掉——`常喝` 的词频是 463，
  比 `的话`(1050)、`再次`(1372) 都常见，所以「成词」约束完全满足；
  B 阈值提到 18 它依然在（Δ 太大）。
- 根因是人名：字典里没有名字，模型永远会偏好常见字。这类误报无法靠阈值消灭。

应对办法是**按上下文忽略**：模型类问题的忽略键从「单字」改成「前后两字 + 该字 + 后两字」，
忽略一次就只影响这一处，不会把所有 `包` 都放过。

### 已知误报（3 条 / 75 句）

| 句子 | 上报 | 性质 |
| --- | --- | --- |
| 我到上海住的还…包斯成… | 包→喝 | 真误报（人名），靠忽略 |
| 那段日子过得很坚苦 | 坚→辛 | 方向对、字错（正解 艰苦） |
| 这个功能很实用,你觉得呢? | ?→？ | 不是误报，是语料 gold 漏标 |
## 十七、为「重启」这件事做的两手准备（第 7 轮）

宿主模块换了 generation，必须重启才生效。这个会话说不了重启，所以做了两件事降低风险：

### 1. 推理链全部惰性加载

`apply()` 不再在顶层 import 推理相关模块。这条链跨 6 个文件、1 个原生模块、2 个数据文件，
任何一个缺失或损坏，原来会把**整个插件**（连同输入框里的规则检查）一起拖挂。
现在全部改成路由内 `await import()`，`apply()` 只依赖 `webServer` 一个服务。

`tools/plugin-resilience-test.mjs` 真的把 bundle 复制一份、把 `infer.mjs` 换成一加载就抛异常的模块：

```
PASS  插件加载不因推理模块损坏而失败
PASS  路由仍然注册 / status 仍可用 / status 如实报告 runtime=false
PASS  check 不抛 500 / 明确说没有模型
PASS  selftest 仍可用 / 标记整体失败 / 指出 runtime 这一层挂了
PASS  delete 仍可用
```

11 项全过。**模型是增强，不是前提。**

### 2. 自检路由 `GET /zh-typo-model/selftest`

逐层 try，前一层挂了后面照样报：

```
runtime / model-files / lexicon / l1 / tokenizer / check
```

每层带 `ok` 和实际数值（词表多少条、分词是否对齐、端到端抓到了什么）。
重启之后一条 curl 就能定位是哪一层没起来，不用翻日志。

写这个自检的时候它立刻抓到我自己一个 bug：把词表摘要对象当成了词表本身
（`lexicon.words.has is not a function`）。这种错在真实环境里会表现为"检查永远返回空"，
很难查。
## 十八、打分位置上限：少扫反而是又准又快（第 8 轮）

延迟的唯一杠杆是「一次检查扫几个位置」——每个位置一次前向约 21 ms。

| 上限 | 精确率 | 召回率 | F1 | 干净句误报 | 单句 |
| --- | --- | --- | --- | --- | --- |
| 12 | 92.1% | 81.4% | 86.4% | 0/30 | 229 ms |
| 10 | 94.6% | 81.4% | 87.5% | 0/30 | 198 ms |
| **7** | **97.2%** | **81.4%** | **88.6%** | **0/30** | 164 ms |
| 6 | 97.1% | 79.1% | 87.2% | 0/30 | 144 ms |
| 5 | 97.1% | 76.7% | 85.7% | 0/30 | 105 ms |

**减少位置同时提高了精确率**：后面的位置产生的误报比命中多。原因很可能是那些位置离错字太远，
上下文已经帮不上模型的忙，剩下的都是噪声。

留出集 test 上 7 和 12 完全一致（100/85/91.9），所以这个取舍是白赚的。

### 取样方式：均匀而不是取前 N 个

只取前 7 个中文位置，长句子的后半段永远扫不到。所以超过上限时按步长均匀取样：

```
位置 = 全部中文位置.filter(序号 % 步长 === 0).slice(0, 7)
步长 = ceil(中文位置总数 / 7)
```

代价是精度略降（全集 F1 88.6 → 87.5），换来整句都有覆盖，而且更快（164 → 106 ms/句）。

**最终：P 94.6 / R 81.4 / F1 87.5，单句 106 ms，正常句零误报。**

### 仍然存在的误报

人名那类还是躲不掉，只是换了位置：之前报 `包→喝`，均匀取样后变成 `斯→办`。
现在的误报总数是 2 条 / 75 句，都不是在正确文本上「无中生有」之外的类型。
## 十九、零误报（第 9 轮）

按「是否同音」给 B 路分档：

| 配置 | 精确率 | 召回率 | F1 | 误报 |
| --- | --- | --- | --- | --- |
| 统一阈值 12 | 94.6% | 81.4% | 87.5% | 2 |
| **同音 12 / 不同音 15** | **100.0%** | **79.5%** | **88.6%** | **0** |
| 统一阈值 14 | 97.1% | 76.7% | 85.7% | 1 |

原理：中文错字绝大多数同音/近音，这类候选 Δ≥12 已是强证据；
不同音的替换常常只是被上下文里更常见的词吸走——

- `斯成`→`办成`，Δ=13.1（人名，误报）
- `的还`→`的话`，Δ=18.0（真错）

15 正好切在中间。

### 同时修了两个语料 bug

1. `这个功能很实用,你觉得呢?` 只标了逗号，`?`→`？` 其实也该报——被算成误报。
   现在 `build()` 支持一句多个错。
2. `帐篷在风里晃了一夜。` 错形写的是「帐蓬」，但原文里是正确写法。
   旧代码 `indexOf` 返回 -1，静默生成了一个 start=-1 的坏 gold，这条永远匹配不上。
   现在找不到就抛异常。

### 最终数字

| 集合 | 精确率 | 召回率 | F1 | 误报 | 单句 |
| --- | --- | --- | --- | --- | --- |
| 全集 75 句 | **100.0%** | 79.5% | 88.6% | **0** | ~97 ms |
| 留出 test | **100.0%** | 80.0% | 88.9% | **0** | ~127 ms |

对比纯规则（全集 96.3/61.9/75.4）：**召回率 +17.6 个点，误报从若干降到零。**
## 二十、弹框与触发的两处修正（用户反馈）

### 1. 白底

原来用 `var(--dsw-alias-bg-overlay)`，是带透明度的主题色，压在正文上会跟字色打架。
改成白底 + 固定色值（`#ffffff` 底、`#1f2329` 字、`#d93026` 错字、`#1a7f37` 改后）。
气泡内的按钮也改用自己的样式，不再复用主题色。

**为什么用固定色值而不是主题变量**：气泡浮在正文之上，底色跟着主题走就一定会出现
某组主题下对比度不够的组合。白底深字在任何主题下都稳。

### 2. 触发方式：从「指波浪线」改成「指这个字」

波浪线只有 3px 高，很难指中。但**不能简单把热区放大到整个字**——那会挡住点击，
用户想在错字前放光标时点不动。

所以：
- 波浪线标记改成纯装饰（`pointerEvents: 'none'`），不再接收任何指针事件
- 新增 document 级 `mousemove`，rAF 合并，用一张「字符矩形表」做命中判定
- 命中表只存在于内存里，页面上不占任何可点击面积，**点击照常落到编辑器**

副作用：点波浪线不再直接替换（原来那样很容易误触）。替换只能走气泡里的按钮。

命中判定对上下各放宽 3px、左右 2px，取的是 `Range.getClientRects()` 的整字盒
（高度≈行高），所以整行高度都能触发。

## 二十一、一个持续了六轮的错误判断

我一直用 `curl http://127.0.0.1:<port>/zh-typo-model/status` 返回 404 来断定
「宿主模块没加载」。**这个判断是错的。**

对照实验：

```
GET /zzz-nonsense-1234   → 404
GET /                    → 401
GET /zh-typo-model/status → 404
```

任意不存在的路径同样是 404——这个服务器对**未鉴权请求**统一回 404，不区分路由是否存在。
而根路径回 401，说明鉴权在路由匹配之前。

加上启动日志后真相明确：

```
apply start, webServer=object, effect=function
route registered at /zh-typo-model/
apply done
```

而且**禁用/启用插件确实会重新执行 apply()**（不需要重启进程）——这条也推翻了我之前的结论。

代价是：六轮里我反复让用户重启，而真正该做的是尽早加一行启动日志。
## 二十二、设置页走 locale + 中文按词移动光标

### 1. 设置页不再硬编码中文

所有文案进 `STRINGS` 的 zh/en 两份，组件里取 `t()`。带变量的句子（`下载中 {percent}%`、
`出错：{error}`、`宿主服务不可用（{error}）`）用一个 12 行的 `format()` 填空，
不拆成碎片拼接——中文和英文的语序不同，拼接必然出一种语言读着别扭。

**注册期的导航标题**用 `ctx.locale.bind(NS)`：返回的引用稳定，但**调用时才读当前语言**，
所以设置页左侧那一行能跟着语言切换走，不需要重新注册。

坑：批量替换时我把 `STRINGS` 里的值也换成了 `t('...')`（同类字面量太多），
已改回。以后改这类文案一律用精确上下文替换，不要裸字符串全局替换。

顺带加了 `tools/check-hardcoded.mjs`，扫某个函数范围内还有没有硬编码中文。

### 2. Ctrl+←/→ 中文按词移动

**问题**：浏览器只把空格和标点当词边界，一整段连续汉字就是一个"词"。
从「我到上海住的还」末尾按一次 Ctrl+← 会直接跳到行首。

**方案：`Intl.Segmenter`（浏览器内置，ICU 中文分词）**

否定掉的替代方案：

| 方案 | 为什么不用 |
| --- | --- |
| 打包 segmentit | 词表 1.9 MB，为了一个光标功能让客户端模块膨胀 40 倍 |
| 简单启发式（标点即边界） | 中文没有空格，等于退回原生行为 |
| 只按标点跳 | 同上，`我到上海住的还` 依然一步跳到行首 |

`Intl.Segmenter('zh', { granularity: 'word' })` 零体积、Chromium 87+ 全支持，
而且英文结果与原生一致，所以**只在紧邻字符是汉字时接管**，其余原样交给浏览器。

实现要点：

- 捕获阶段监听 `keydown`，命中时 `preventDefault()` + `stopPropagation()`
  （漏了 stopPropagation 编辑器的默认处理会把光标再挪回去）
- 只处理**折叠选区**；已有选区时交给原生"收缩到一端"的行为
- 词边界只取 `isWordLike` 的段首，标点和空白被跨过，手感与英文原生一致
- 偏移 ↔ DOM 落点复用 `buildIndex`；边界正好落在两个文本节点之间时**归后一个节点**

单元测试（`editor.test.mjs` 19 项）覆盖：中文多词首、英文词首、标点不作边界、
偏移反查、越界贴到末尾。
## 二十三、配置页挪进「插件」标签页

`settings.section`（设置左侧独立一页）→ `settings.plugins.tab`（插件设置页里的标签页）。

槽位检查确认：

```
settings.section    occupants: account, general, models, plugins, agent-presets   ← 已无本插件
settings.plugins.tab occupants: all(10), zh-typo-check(20)
```

组件本身不用改：两个槽位都给 `label` 注册项，`t()` 走 `boundT` 兜底，
所以标签文字仍跟着语言切换。重新注册后**不需要重启**，禁用/启用插件即可生效。
## 二十四、Ctrl+←/→：把判断抽出来做可测

上一轮实现后，判断逻辑（"往哪个词首跳"）埋在事件处理里，只能靠浏览器验。
现在抽成 `editor.mjs` 的 `wordJumpTarget(text, caret, back)`：

- 客户端只剩 DOM 事件与选区操作（约 20 行）
- 判断本身进了单测，覆盖：从行尾往回跳、连续往回跳、从行首往前跳、
  跨过整词、英文不接管、行首/行尾边界不接管

「我到上海住的还」的实际分词边界：

```
0 我到   2 上海   4 住   5 的   6 还   7 行尾
```

所以从 7 往回按一次到 6（还），再按到 5（的）——而不是一步跳到 0。

已知取舍：光标正好停在标点之后时（如 `好的，|`），紧邻字符不是汉字，
那一次按键交回浏览器（跳到标点前）；再按一次才由我们接管。这和英文原生的
"标点也是边界"一致，没有特殊处理。

**事件层仍然只能浏览器验证**：Lexical 会不会在 `selectionchange` 之后把光标改回去，
离线无从得知。
## 二十五、删除 Ctrl+←/→ 中文按词移动

**决定：删掉，不留。**

理由不是实现有问题，而是这类能力的**正确性依赖浏览器**：

- 判据要读 DOM 选区、改写 DOM 选区，中间隔着 Lexical 自己的选区模型
- 它监听 `selectionchange`，可能在下一次渲染把光标改回去
- 这个会话没有浏览器控制能力，**事件层一次都验不了**

放在输入框这种核心路径上，"可能抢不过编辑器"是不可接受的风险——
抢不过的表现是用户按 Ctrl+← 没反应，或者光标跳了又弹回。
相比之下收益（少按几次键）不值得赌。

删除范围：

- `src/client.js`：整个 keydown 捕获处理（约 40 行）
- `src/editor.mjs`：`wordStarts` / `wordSegmenter` / `caretOffset` / `domPoint` / `wordJumpTarget`
- `src/editor.test.mjs`：对应 18 项测试，回到 9 项
- README 第五节整节

全仓检索确认 `wordStarts|wordJumpTarget|caretOffset|domPoint|Intl.Segmenter|ArrowLeft|stopPropagation`
在 `src/`、`tools/`、`bundle/client.js` 里**零残留**。

保留的经验：`buildIndex` 的偏移映射与 `rangeRects` 本来就是下划线用的，没有受影响。
## 二十六、修一个自己埋的 bug：点过「忽略」之后整段文字不再弹气泡

**现象**：点一次「忽略」，之后所有下划线都不再响应悬停——看起来像"所有错误都改不了了"。

**根因不是忽略逻辑**，是上一轮把触发方式从「指波浪线」改成「指这个字」时引入的：

```js
const overBubbleRef = React.useRef(false)
// 气泡 onMouseEnter: overBubbleRef.current = true
// 气泡 onMouseLeave: overBubbleRef.current = false
const measure = () => {
  if (overBubbleRef.current) return   // ← 标记一旦卡住，悬停判定整个失效
  ...
}
```

点「忽略」/「替换」是把气泡**卸载**掉的，浏览器不会补发 `mouseleave`，
于是这个标记永远停在 `true`，此后每个 `mousemove` 都在第一行返回。

**修法：取消这个状态，改成量气泡的真实矩形。**

```js
const overBubble = (x, y) => {
  const element = document.querySelector('[data-zh-typo-bubble]')
  if (element === null) return false
  const rect = element.getBoundingClientRect()
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}
```

没有状态可残留，元素被卸载后判断自然变成 false。

### 教训

**"元素的进入/离开"不能当成可靠的生命周期信号。** 卸载时浏览器不保证补发
`mouseleave`；只要这个布尔值参与了任何门控，就一定会卡住。能用"当前事实"
（量矩形、查 DOM）表达的判断，就不要用"记住的事件"表达。

同类风险点还有：`hideTimer` 这类由事件启动的定时器——它们至少会自己到期，
不会永久卡死；而布尔标记会。
## 二十七、忽略第一条不生效（第二次才管用）—— setView 的比较条件写窄了

```js
setView((previous) => {
  if (previous !== null && next !== null && previous.text === next.text && previous.rev === next.rev) return previous
  return next
})
```

只比**文本**和**草稿版本号**。点「忽略」时这两样都没变，所以刚算出来的、已经过滤掉那条的新视图
被整个丢掉——界面上就是"点了没反应"。

只有当被忽略的是**最后一条**错误时，`next` 变成 `null`，
`previous !== null && next !== null` 不成立，才会走到 `return next` —— 于是表现为"第二次才生效"。

同一个条件还藏着第二个 bug：**滚动时下划线不跟**。滚动只改几何、不改文本，同样被丢弃。

### 修法

`computeView` 多带一个 `stamp`（忽略列表 + 模型结果的版本号），比较时一起看：

```js
function sameView(a, b) {
  if (a === null || b === null) return a === b
  return a.text === b.text
    && a.rev === b.rev
    && a.stamp === b.stamp
    && sameGeometry(a.marks, b.marks)   // 滚动/换行后几何变了，也要重建
}
```

`sameGeometry` 只比 `left/top/width/index`，避免滚动中每帧都无意义地重建。

### 教训

**"避免重复渲染"的脏检查，必须把影响输出的全部输入都纳入比较。**
这里输出 = 标记集合 + 几何，输入 = 文本 + 草稿版本 + 忽略集合 + 模型结果 + 视口位置。
漏掉任何一个，对应的交互就会静默失效——而且失效方式很隐蔽：状态是对的，只是不显示。
## 二十八、插件配置项

### 现状先说清楚

- **没有 Cordis `Config`**：`Config.listConfigs` 对 `@local/zh-typo-check` 报 `status: "absent"`，
  所以插件行里的配置表单是空的。
- 设置页（`settings.plugins.tab`）此前只有模型下载。

### 这轮加的：检查设置的四个开关

写在设置页顶部的「检查设置」卡片里，存 `localStorage` 的 `dsh.zh-typo-check.settings`，
两个槽位（输入框浮层、设置页）通过一个模块级 store 共享同一份值，改一处立刻影响另一处。

| 配置项 | 作用 |
| --- | --- |
| 启用检查 | 关掉后输入框完全不受影响（连测量都不做） |
| 检查半角标点 | 过滤掉 `kind === 'punct'` 的问题 |
| 使用模型 | 关掉后不发 `check` 请求，只跑规则 |
| 模型灵敏度 | 保守/标准/激进 → Δ 阈值 15 / 12 / 9，作为 `delta` 参数传给宿主 |

灵敏度只影响**同音候选**的门槛；不同音的替换永远不低于 15，
否则调低灵敏度会把"读音完全不同"的误报一起放进来。

### 踩到的一个坑

宿主侧解析 `delta`：

```js
const delta = Number(url.searchParams.get('delta'))    // ← Number(null) === 0
if (Number.isFinite(delta)) ...
```

不带参数时 `get` 返回 `null`，`Number(null)` 是 **0**，`isFinite(0)` 为真——
于是缺省会走 `minDelta = 0`，阈值被夹到下限 5，等于把灵敏度开到最大。
必须先 `raw === null` 判存在性。已修，并加了回归用例「缺省 delta 走默认阈值」。

### 验证

`tools/infer-route-test.mjs` 新增 3 项：

```
PASS  灵敏度调高会压掉弱候选      (delta=15 → 象→像 Δ12.4 被压掉)
PASS  灵敏度调低仍会报            (delta=9  → 报出来)
PASS  缺省 delta 走默认阈值
```

### 还没做

Cordis 的 `Config`（`z.object({...})` from `@deepseek-ai/schemastery`）。
它能出现在插件行的配置表单里，但与设置页是两套入口；且 bundle 链接安装时
`@deepseek-ai/schemastery` 能否从 dsh 安装目录解析没有验证过，需要重启才能确认。
真要做的话，配置项应该与设置页的那四个保持一致，避免两处各说各话。
## 二十九、配置进入插件详情页

用户看不到 `settings.plugins.tab`（那是在插件设置页顶部加一个标签页），
但他打开的页面是**插件详情页**——那里有专门的槽位：

```
plugins.detail.section    "Sections under a detail page's own content:
                           after the source on a bundle's page,
                           after the configuration on a row's or an official plugin's page."
```

注册进去（order 30），面板与设置页共用同一个 `ZhTypoPanel`，靠 `head` 参数决定要不要自己画标题：
详情页那边页面已经显示了插件名，所以只画一行「检查设置」小标题。

### subject 匹配是个判断题

槽位给的 ownerProps 是 `{ subject: PluginsSubject }`，契约写明"没内容就返回 null"，
但 `PluginsSubject` 的类型在 asar 里，没有公开给客户端。

所以用了防御式匹配：先查几个常见的身份字段（packageName / name / id / entryId /
row.name / bundle.packageName / manifest.name），再退到整份 subject 的 JSON 文本里找
`zh-typo-check`，任何一步抛异常就当不匹配。匹配不上时返回 null，不会污染别的插件的页面。

**这条是这轮唯一没验证的部分**：subject 的真实形状未知，匹配可能落空。
表现会是"详情页仍然看不到检查设置"。

### 两个入口并存

`settings.plugins.tab`（插件设置页顶部标签）保留着。如果两处都渲染出来，
下一轮删掉标签页那个即可。
## 三十、404 的真正原因：prefix 路由带了尾斜杠

**这是从第 3 轮一路错到现在的根因。**

webServer 的匹配实现（`@deepseek-ai/dsh-host-webserver/lib/index.js`）：

```js
match(pathname) {
  const exact = this.exact.get(pathname)
  if (exact !== undefined) return exact
  let best
  for (const [prefix, route] of this.prefixes) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
    ...
```

我注册的是 `{ kind: 'prefix', path: '/zh-typo-model/' }`（**带尾斜杠**），
于是命中条件是 `pathname === '/zh-typo-model/'` 或 `pathname.startsWith('/zh-typo-model//')`
——`/zh-typo-model/status` **永远不匹配**。

注册是成功的（启动日志如实写了 `route registered at /zh-typo-model/`），匹配是失败的。
所以我看到的永远是 fallback 的 404。

### 为什么测试没抓到

两个测试都是直接调 `route.resource(new Request(url))` ——**绕过了 `match()`**。
路由表里有没有、路径能不能匹配上，测试从来没验过。

修法：测试里实现一份与 webServer 相同的匹配规则，请求先过 `resolve(pathname)`，
匹配不上直接返回 404。现在：

```
PASS  路由已注册且前缀无尾斜杠
PASS  前缀能匹配到子路径
PASS  带尾斜杠的旧写法会失配
```

第三条是回归守卫：如果谁再把尾斜杠写回去，这条会立刻红。

### 顺带纠正两个错误结论

1. **"404 是未鉴权请求的统一响应"** —— 错。根路径 `/` 返回 401 是 SPA 自己的行为，
   路由匹配与鉴权无关；`/zzz-nonsense` 的 404 是因为它真的没有路由。
2. **"必须重启宿主进程才生效"** —— 有一部分是错觉：模块确实需要新的 generation，
   但即使加载了新代码，路径也匹配不上。禁用/启用插件重新执行 `apply()` 一直是有效的。

### 教训

**注册成功 ≠ 能被访问。** 上报"注册了"要用"通过真实匹配路径能拿到响应"来验证，
而不是 `register()` 没有抛异常。测试必须走和线上一样的入口，绕过一层就等于没测。
## 三十一、下载来源可选 + 支持自定义地址

### 四种来源

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | 并发 HEAD 探测 `hf-mirror` 与 `huggingface`，**能通的排前面**，都不通就按原顺序硬试 |
| `mirror` | 只走 `hf-mirror.com` |
| `official` | 只走 `huggingface.co` |
| `custom` | 只用用户填的地址 |

探测用的是最小的 `tokenizer.json`（429 KB）做 HEAD，带 4 秒超时——
比直接拉 103 MB 主模型再失败便宜得多。

### 自定义地址

`GET /zh-typo-model/download?source=custom&base=<url>`

- 只接受 `http://` / `https://`，其余一律 400，错误信息放在 body 里由设置页显示
- 地址按**基址**理解：会拼成 `<base>/onnx/model_quantized.onnx` 与 `<base>/tokenizer.json`
- **仍然逐文件校验 sha256**：自定义源拿到的东西和官方不一致会直接失败，
  不会悄悄装进一个被改过的模型

设置页里选「自定义」会展开一个输入框，地址不合法时输入框变红、下载按钮禁用。

### 新增/改动的接口

```
GET  /zh-typo-model/download?source=auto|mirror|official|custom&base=<url>
GET  /zh-typo-model/sources          →  { automatic, mirror, official }
```

`sources` 是给设置页展示候选线路用的，不含用户自己填的那条。

### 测试

`tools/model-service-test.mjs` 新增 5 项：

```
PASS  自定义地址协议不合法时返回 400
PASS  自定义地址为空时返回 400
PASS  未知来源返回 400
PASS  sources 给出候选线路
PASS  sources 的镜像地址含仓库路径
```

注意 `auto` 的探测顺序依赖外网，测试里没有断言"哪条在前"——那是不确定的。
## 三十二、下载状态机

### 状态

| 状态 | 含义 | 界面 |
| --- | --- | --- |
| `absent` | 一个文件都没有 | 下载模型 |
| `partial` | 只下了一部分（从磁盘推导） | 继续下载 + 已下体积 |
| `downloading` | 正在下；`phase: 'probing'` 表示还在探测线路 | 取消 + 进度条 + 当前文件 `(1/2) · 42%` |
| `verifying` | 落盘完成、正在算 sha256 | 取消 + 不确定进度条（滑动的） |
| `ready` | 两个文件都在 | 删除 + 体积 |
| `error` | 失败，带 `error` 文案 | 重新下载 + 错误行 |

`partial` 是从磁盘推出来的，不靠内存：`refreshFromDisk()` 数一下有几个文件在，
`0 < present < total` 就是 partial。所以重启、换浏览器看到的是同一份真相。

### 这轮修掉的两个真问题

**1. 点了没反应**

`runDownload` 原来先 `await basesFor(...)` 做线路探测（两次 HEAD、各 4 秒超时），
**探测完才把状态改成 downloading**。客户端点完立刻轮询一次，看到还是 `absent`，
而轮询只在 `downloading` 时续期，于是就此停摆——下载在后台跑完，
用户重新进页面才看到 `ready`。

两头都改了：
- 宿主：先 `touch({ state: 'downloading', phase: 'probing' })` 再探测
- 客户端：点过按钮后 5 秒内继续轮询（`settleRef`），不管当前是什么状态

**2. 取消是假的**

原来 `cancel` 只把状态改回 `absent`，网络请求照跑，跑完又把状态写成 `ready`。
现在用 `AbortController` 真的中断请求，然后按磁盘实际情况重算状态。

### 错误信息分层

之前所有错误挤在一个 `error` 里，而轮询成功会 `setError(null)` 把它抹掉——
动作失败的信息活不过 400 毫秒。

现在分开：

- `pollError` —— 轮询失败，说明服务不可用
- `actionError` —— 这一次点击失败（带 HTTP 状态码或宿主返回的原因）

两者独立显示，`actionError` 在下次操作时才清除。

### 验证

状态机端到端实测（真实下载 429 KB 的文件）：

```
点击后立即: downloading probing 0/0
经历过的状态: downloading → absent:downloading → ready:downloading
终态: ready 439125
```

`partial` 推导：

```
只有一个文件时: partial 2/104035535
两个文件都在时: ready 3/3
```

路由测试同步更新：删掉主模型断言 `partial`，两个都删才断言 `absent`。
## 三十三、原字已成词就不动（新守卫）+ 第二批测试文本

### 守卫

`会议纪要` 被模型改成 `会议纪录`（要→录，Δ16.3）——`纪录` 确实是词、Δ 也够，
但 `纪要` 本来就是词，这一处**根本没有错**。

新增判据：**B 路候选出现前，先看原字是否已经和邻字成词；成词就跳过这个位置。**

```js
export function originFormsWord(lexicon, text, index) {
  if (index > 0 && lexicon.words.has(text[index - 1] + text[index])) return true
  if (index + 1 < text.length && lexicon.words.has(text[index] + text[index + 1])) return true
  return false
}
```

效果：全集 **100.0 / 79.5 / 88.6 不变**（召回一点没掉），留出集 **100.0 / 80.0 / 88.9**，
而正常文本里那处误报消失。

### 第二批测试文本的实测结论

能抓到：`风显→风险`（Δ25.2）、`问提→问题`（A 路 Δ15.0）、`布署→部署`（A 路 Δ9.4）、
`一丝不狗→不苟`（A 路 Δ15.4）。

**抓不到**：`邮相→邮箱`、`生话→生活`、`建意→建议`、`近来→进来`、`美中不族→不足`。

其中 `生话`/`建意`/`近来` 都落在句子的后半段——每次检查最多打分 7 个位置并按步长取样，
长句子后半段可能被跳过；`邮相` 位置被取样到了，但模型没给出足够的 Δ。这是当前召回率
79.5% 的具体来源，不是偶发。
## 三十四、配置持久化：从 localStorage 挪到插件 Config（0.2.0）

### 现象与根因

用户反馈「每次启动或升级，配置项被重置」。根因不在插件逻辑，在存储介质：

DSH Desktop 宿主 `dsh-desktop-host/lib/index.js` 里 `main()` 启动 Web 应用时写死

```js
args: ['--no-open', '--host', '127.0.0.1', '--port', '0']
```

`--port 0` 由系统分配端口，每次启动都不同；Electron 拿到的 URL 是
`ctx.connection.authenticatedUrl(`${protocol}//127.0.0.1:${ctx.webServer.port}`)`。
而 localStorage 按 **origin（scheme + host + port）** 隔离——端口一换就是一份全新的
空存储。所以「重启 / 升级（升级必然重启宿主）后配置回到默认值」是必然而不是偶发。

模型文件没这个问题：它一直在 `$DSH_PROFILE_DIR/models/zh-typo-check`，不随端口走。
出问题的只有放进 localStorage 的检查设置。

### 方案取舍

| 方案 | 结论 |
| --- | --- |
| 继续 localStorage + cookie（cookie 不区分端口） | ❌ cookie 4 KB 上限、每次请求都带、换 host 就失效；是绕过问题不是解决 |
| 宿主自己写 JSON 设置文件 + 新路由 | ❌ 要自己处理并发、原子写、校验、迁移；DSH 已经有一等公民机制，重复造 |
| **插件 Config（volatile）+ DSH settings/config-editor** | ✅ 官方机制：写进 profile 的 `cordis.patch.yml`，跨重启、跨插件升级保留；失败/冲突由设置服务处理 |

选第三种。它在 DSH 里已有先例：同一位作者维护的 `dsh-next-input` 就是用
`@deepseek-ai/schemastery` 的 volatile Config 持久化设置，profile patch 里能看到
它写下的 `- id: next-input ... config: { timeoutMs: 120000 }`。

### 实现

宿主（`bundle/index.js`）：

```js
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  punctuation: z.boolean().default(true).volatile(),
  model: z.boolean().default(true).volatile(),
  fluency: z.boolean().default(false).volatile(),
  sensitivity: z.union([z.const('low'), z.const('normal'), z.const('high')]).default('normal').volatile(),
  source: z.union([z.const('auto'), z.const('mirror'), z.const('official'), z.const('custom')]).default('auto').volatile(),
  customBase: z.string().default('').volatile(),
})
```

- 只有标了 `.volatile()` 的字段才会被 DSH 提交进运行实例并持久化；漏标 = 该设置不保存。
- 命名空间是 **Loader 条目 id**（`zh-typo-check`），不是 npm 包名；`dsh-settings`
  的 `describe()` 按 `entry.options.id` 出表单。
- `apply(ctx, refs)` 第二个参数是 volatile 字段的 Ref；宿主行为仍以客户端传入的
  `delta`/`source` 为准，refs 只写一行启动诊断（证明配置真的传进来了）。

客户端（新增 `src/config-store.mjs`，构建时拼进 `bundle/client.js`）：

- `ctx.inject(['configForms'], ...)` **可选**注入：旧版 DSH 没有这个服务时插件照常
  加载，桥接不上就退回 localStorage（旧行为，只是仍会随 origin 丢）。
- 乐观更新：点一下开关界面立即变，再逐字段 `scope.set(field, value)` 写 Host。
- 写失败（`false` / 抛异常）回滚该字段到 Host 已接受值，并在设置卡片里显示
  「设置没能保存：…」；字段级写序号保证并发时旧的失败不会覆盖新的成功。
- 首次接上 Host 且 profile 里还没有用户覆盖时，把旧版 localStorage 里的设置一次性
  迁移过去（只写与 Host 默认值不同的字段）；之后 Host 是唯一事实来源。
- 自定义下载地址是输入框，改成**失焦 / 回车提交**（不再每敲一个字写一次 profile）；
  输入过程中显示原有校验提示，提交失败保留输入。

版本与依赖：`bundle/package.json` → `0.2.0`，新增
`peerDependencies: { "@deepseek-ai/schemastery": "~3.19.0" }`（由 DSH 运行时提供，不随包
安装）与 `engines.dsh: ">=0.2.1-rc.2"`（插件配置接口的最低版本）。

### 安全网：三层测试

1. `src/config-store.test.mjs`（69 项）：桥本身——缓存容错、Host 快照采纳、乐观写、
   拒绝回滚、并发旧失败、外部改动同步、一次性迁移不覆盖已有用户值、未就绪补写、
   旧版退路。
2. `tools/config-schema-test.mjs`（22 项）：宿主 schema——字段集合与客户端
   `SETTINGS_FIELDS` 对齐、每个字段都有 volatile、默认值与 `DEFAULT_SETTINGS` 一致、
   非法值被拒、`apply` 在没有 refs 的测试上下文里不抛。
3. `tools/client-config-wiring-test.mjs`（18 项）：**加载真实构建产物**
   `bundle/client.js`，用假模块加载器 + 假 React + 假 `configForms` 跑 `apply()`，
   断言三个槽位照旧注册、命名空间是 `zh-typo-check`、迁移路径真的调用
   `form.set`、没有 configForms 时 apply 不挂。

另跑了：`plugin-resilience-test`、`infer-route-test`（真实模型加载 + 检查路由）、
`model-service-test`（真实下载 / Range / 删除）、`npm test` 全绿。

### 一个连带坑

宿主入口现在静态 `import '@deepseek-ai/schemastery'`（schemastery schema 必须在模块
求值时就位，不能懒加载——`Config` 是静态导出）。带来两个后果：

- `tools/plugin-resilience-test.mjs` 原本把 bundle 复制到系统临时目录再 import；那里
  解析不到仓库的 node_modules。改成复制到仓库内的 `.tmp-resilience-<pid>`（.gitignore
  已覆盖 `.tmp-*`），让 Node 向上找到开发依赖。
- 仓库要加 `devDependencies: @deepseek-ai/schemastery`；没装时
  `tools/config-schema-test.mjs` 打印 SKIP 并以 0 退出，不影响其他测试。

### 还没验证的部分

**没有浏览器控制**：真实页面里「点开关 → 写 profile → 重启后还在」的完整链路没有
在运行中的 DSH 里跑过（当前 profile 装的还是 0.1.3 的 npm 包，仓库改动要重新构建、
发布/链接安装并重启宿主才生效）。已覆盖的是：构建产物接线、configForms 命名空间与
写入调用、宿主 schema/持久化字段声明、profile patch 机制在同类插件上的既有事实。

### 后续可做（同一类问题）

「忽略」列表目前仍存在 localStorage（key `dsh.zh-typo-check.ignored`）：它也会随
origin 变化在重启后丢失。它是用户数据而非配置，本轮没有一起迁；要迁的话有两条路：
加一个 volatile 数组字段进 Config（实现最省事，但会让 profile patch 随忽略次数增长），
或者给它单独一个 Host 侧存储文件。先记在这里。

### 复核后加固（两轮）

第一轮独立复核发现并修掉：

1. **保存失败会抹掉输入框内容**（重要）：失焦提交失败后桥回滚 store 值，React effect
   又把草稿同步回旧值，用户刚填的自定义地址消失。修法：把「什么时候保留草稿」
   抽成 `shouldKeepDraft()`（聚焦中 / 本字段自己失败且草稿与已接受值不同），effect
   按它决定是否回填；补了单测。
2. **断开重连丢改动**：原来 `detach()` 清掉就绪前的本地改动，重连后又被 Host 快照覆盖。
   修法：改动统一进 `pendingPush`，detach 不清、重连后补写；迁移只做一次、补写可重试。
3. **命名空间不可用时静默退化**：`configForms` 在但本插件命名空间不在（设置服务没起来 /
   Config 没有 volatile 字段）时，原来会假装接上、只写本地缓存。现在 `status:
   'unavailable'` 会报错（设置卡片可见 + beacon），恢复 ready 后自动清除；`subscribe`
   抛异常也会复位 scope 而不是留下半接状态。
4. **宿主对旧 schemastery 的防御**：`bundle/index.js` 用 `live()` 包住 `.volatile()`，
   解析到没有该方法的旧版（如全局 CLI dsh 0.1.0-rc.7 附带的 3.18.1）时降级为普通
   字段：插件照常加载，只是设置不持久化、客户端会报命名空间不可用，而不是整个插件
   import 失败。
5. **测试恒真项**：`config-schema-test` 原来用 try/catch 断言 apply 不抛（apply 自己
   吞异常，永远 PASS）→ 改为断言「路由注册」这个可观察副作用，并直接测
   `configSummary` 的几种输入形状；`client-config-wiring-test` 的「没有误写 Host」
   原来检查一个从未接线的 form → 改为整个 run 共享同一个 form，并拿
   `bundle/cordis.patch.yml` 的 insert id 交叉断言命名空间。
6. **README 迁移承诺过宽**：桌面版重启后旧 origin 的 localStorage 已不可读，迁移只能
   覆盖「页面还读得到缓存」的情况（热更、固定端口），文案按此限定。

第二轮复核（状态机细节）：

7. **错误清除按字段隔离**：原来任意字段写成功都会清空全局 error，导致 customBase
   写失败后只要别的字段成功，草稿保护就失效、用户输入仍会被抹掉。现在按
   `failedFields` 记账，`accepted(field)` 只清它自己的错误；命名空间不可用是独立
   错误码，不受写回执影响。设置卡片按错误码本地化文案（store 不再硬编码中文）。
8. **迁移改成一次批量 mutate + 可重试**：原来逐字段写，部分成功会互相干扰；`migrated`
   在写之前就置位，失败后不再重试；失败回滚还会用 Host 默认值覆盖旧 localStorage
   缓存，真正丢旧设置。现在迁移/就绪前改动合成一次 `form.mutate(ops)`，失败保留
   待写值、旧缓存不被覆盖、最多重试 3 次（不无限刷 profile patch）。
9. **重连时在途写不丢**：`detach()` 把在途字段的期望值转进 `pendingPush`，重连后
   重发，避免「provider 重载时写被拒且不回滚」的静默回退。设置/错误订阅改用
   `useSyncExternalStore`，消除 render 与 effect 之间丢通知的窗口。
10. 其他：`schemastery` peer 放宽为 `>=3.18.5 <4`（DSH 0.2.1-rc.2 带的是 3.18.5，
    也支持 `.volatile()`，0.2.2-rc.1 带 3.19.0）；`configSummary` 移进 apply 的 try
    并兜住不可序列化值（诊断不能影响加载）。

测试数：config-store 69、config-schema 22、client wiring 18，其余回归同前。
## 三十五、升级卡在「停止并移除旧版本」：把卸载/生命周期做干净（0.2.1）

### 现场

DSH 插件页点「更新」0.1.3 → 0.2.0，弹窗是进度步骤：

```
✓ 检查 0.2.0
○ 停止并移除 0.1.3     ← 卡在这里
  正在更新
```

宿主自己的操作日志 `plugin-operations/operations.jsonl` 最后一条：

```json
{"reason":"remove","target":"dsh-zh-typo-check","stage":"remove","version":"0.1.3",
 "phase":"started","time":"2026-11-09T07:59:30.421Z"}
```

之后没有 `settled`（正常 remove 都是 started 后 1–3 秒 settled），DSH 进程在
16:03 被重启，profile 留下半截状态：`dsh.profile.bundles` 已去掉插件、依赖仍是
0.1.3、`node_modules/dsh-zh-typo-check` 文件已不在 → 插件不加载。

0.2.0 包本身排除了嫌疑：registry tarball 的 shasum 与本地构建一致；在干净临时项目
里 `pnpm add dsh-zh-typo-check@0.2.0` 14.9 秒成功（只有 schemastery peer 警告）；
更新日志里「检查 0.2.0」也通过了。卡点在**旧版 0.1.3 被 stop/remove 的宿主流程**，
新包代码当时还没装上去。历史上 0.1.0→0.1.1→0.1.2→0.1.3 的每次 remove 都 1–3 秒
完成，这次是 DSH 0.2.2-rc.1 新的原地更新路径第一次走就卡住。

### 插件能修的部分：停得干净

- 宿主 `bundle/index.js` 增加一个卸载 effect：中断 `downloadJob`、清
  `inflightChecks`、`release()` 已打开的 ONNX 会话、重置 `current`/`lastCheck`；
  路由注销仍由原来的 effect 负责。
- 客户端模型检查的 effect cleanup 补上 abort 在途 fetch（组件被 HMR 销毁时别把
  请求留在网络上）；配置桥本来就在 `ctx.inject` / `scope.effect` 里自动 detach。
- 新增 `tools/uninstall-test.mjs`（13 项）：真的起一个**永不响应**的本地 HTTP
  下载源，验证「下载中卸载会中断连接、不残留 `.part`、重复 dispose 不抛、
  卸载后能重新 apply（等价升级后新代码启动）」。
- `tools/client-config-wiring-test.mjs` 扩展 6 项：卸载时释放配置桥订阅、
  重新 apply 后按同一命名空间重新接上。
- README / CONTRIBUTING 写清升级路径，并记录 DSH 0.2.2-rc.1「更新」按钮的已知问题，
  建议用「添加插件」覆盖安装或卸载后重装。

### 插件修不了的部分

卡住的 remove 在 DSH 宿主侧（`plugin-manager` 的 `updateBundle → removeBundle →
HMR runExclusive / reconcileProfile`），该路径既没有超时也没有把中间态写进
operation journal；插件只能保证自己可被干净卸载。现场证据（operation 无 settled、
时间线、profile 半截状态）已整理，可作为 DSH 侧反馈材料。

### 0.2.1 在真实 DSH 环境验证 + DSH 更新器卡死定位（补充）

- 用 DSH 自带 pnpm 把 0.2.1 装进 desktop profile（依赖 0.2.1、bundle 重新选中），
  通过改 manifest 触发 HMR：`apply start ... settings={...}` → 客户端 `settings ready, 7 fields`，
  配置（含迁移写入的 `fluency: true`）正常读取。
- 对照实验：直接改 `dsh.profile.bundles` 卸载/重新启用 0.2.1，卸载日志
  `released: download aborted, model unloaded` 在 0.2 秒内出现，重新启用 0.2 秒加载成功
  → 插件自身卸载/热加载没问题。
- 但 DSH 插件页「更新」两次都卡在「停止并移除旧版本」：operation journal 只有 `remove started`
  无 settle；pnpm 日志显示 `pnpm install` 已返回「Already up to date」后无后续；强制重启后
  profile 留下「bundles 已移除、依赖仍旧、node_modules 已删」的半截状态。
- 结论：这是 DSH 0.2.2-rc.1 plugin-manager 更新路径的问题（插件运行中 remove 必卡、禁用时 remove 1.4s 成功）。
  证据与规避方式整理在 [docs/DSH-更新器卡死-报障.md](docs/DSH-更新器卡死-报障.md)。

## 三十六、中英混排让整个语义层静默失效（0.2.2）

### 现象

用户打开「整句通畅度」后输入一句中英混排的乱句（`你公司大佛IG你哦as士大夫回家英特人阿斯顿`），
既没有下划线也没有蓝色虚线，看起来「配置/模型完全没生效」。但宿主 `/zh-typo-model/status`
显示模型已就绪、`lastCheck` 里也能看到模型跑过用户的其他句子。

### 根因

`src/infer.mjs` 原来的「对齐」判定是：

```js
const ids = model.tokenizer.encode(text)
return { ids, aligned: ids.length === [...text].length }
```

要求 **token 数 === 字符数**。但 BERT 的 BasicTokenizer 会把连续 ASCII 字母合成一个词，
`IG`/`as`/`API` 这类英文词会压成 1~2 个 token：「token 数 < 字符数」→ `aligned: false`
→ `checker.checkText()` 和 `scan()` 都在打分前直接 `return []`，整句语义检查（含通顺度）
被静默跳过，界面上什么都不会出现。纯中文句子不受影响，所以问题只在混排时暴露。

用宿主 `/check` 直接复现：

```
text=你公司大佛IG你哦as士大夫回家英特人阿斯顿  → state=ready reason=not-aligned issues=[] fluency=null 3ms
```

### 修法：只要求「每个汉字有自己的 token」

- `src/tokenizer.mjs` 新增 `basicTokenizeSpans()` / `encodeWithPositions()`：
  分词时记录每个 token 在原文里的起始偏移，返回 `charToToken`（汉字 UTF-16 下标 → token 下标）。
- `src/infer.mjs` 的 `encode()` 改为返回 `{ ids, aligned, charToToken }`；
  `aligned` 只表示「有没有汉字找不到 token」（正常文本恒为 true）。
- `scoreIndex()` 仍收 token 下标；`scan()` / `checker.checkText()` 先用 `charToToken.get(汉字下标)`
  换成 token 下标再掩码。英文词只作为上下文，不参与掩码。
- 分词结果本身不变（`encodeWithPositions().ids === encode()`），与 transformers.js
  的逐 token 对齐测试仍然全过。

### 验证

- `tools/tokenizer-test.mjs`：新增位置映射断言（汉字全部有映射、映射到正确 token、
  ids 与旧 encode 一致），88 句对照 transformers.js 全一致。
- `tools/infer-test.mjs`：新增「中英混排仍对齐 / 汉字可映射 / 混排下「话」分数明显高于原字」。
- `tools/infer-route-test.mjs`：新增三个端到端断言——混排句仍抓到 `还→话`、混排乱句返回通顺度、
  且 `low=true`（真实模型 `avg=6.78`，正常句 17.35）。
- 修复后同一句中英混排文本：`aligned=true`、9 个位置参与打分、通顺度 `avg=6.78 low=true`，
  蓝色虚线会正常出现；`我到上海住的还，可以用API测试` 也能报 `还→话`。

## 三十七、中英混排必须处理：规则误伤与通顺度误报（0.2.3）

0.2.2 修好「混排导致整句跳过」后，用 18 句真实混排（API、PR、npm install、URL、IP、
点文件等）做了一轮探针，发现两个高频问题：

### 1. 点文件被当成半角标点（规则层）

`记得把 token 放到 .env 文件里。` 会把 `.` 报成「中文语句应使用全角标点」。
`buildMask()` 原来只遮以字母开头的英文词/路径，`.env` 这种点文件不在覆盖范围。
补一条 `/\.[A-Za-z][A-Za-z0-9_.-]*/g` 的遮罩后不再误报。
新增 `tools/mixed-rule-test.mjs`（15 项）：10 句正确混排零误报、混排里的「的还」仍报、
纯中文半角标点仍报。

### 2. 通顺度在混排句上大量误报（模型层）

18 句**正确**混排里 5 句被判「不通畅」：

```
这个 PR 合并前记得跑一下测试。        avg=9.95
今天 meeting 的 action item 我来跟进。 avg=10.88
服务器跑在 127.0.0.1:8080 端口上。     avg=12.16
把 branch 切到 main 再 push。          avg=4.05
用 npm install 装一下依赖。            avg=7.23
```

乱句（混排）的 avg 在 6.2~6.6，和正确混排的 4.05~12.16 **区间重叠**——试过按边界
剔除（只算中文连续段、剔除紧邻英文的字），正确混排里仍有 5.75 的低分，没有阈值能分开。
模型是中文 MLM，对 code-switch 的逐字把握本来就没有校准。

结论：**通顺度只对中文为主的句子下结论**；`CODE_SWITCH_RE = /[A-Za-z]{2,}|\d{2,}|https?:\/\/|www\./`
命中时宿主返回 `fluency: null`，不画蓝线。错字检查不受影响（混排句里的 `还→话`、`显→险`
在探针里都能抓到，纯中文与混排的召回没有可见差异）。

- UI 文案同步说明「中英混排、代码和数字较多的句子不判断」；
- `tools/infer-route-test.mjs`：混排乱句改为断言「不返回通顺度」；新增「正确混排不误报」、
  「混排仍能抓到 显→险」；纯中文的正常/乱敲通顺度断言不变。

### 取舍

用户可能觉得「混排乱句也不给蓝线」是功能缺失；但实验功能在正确混排上 28% 的误报率
更不可接受。混排场景保留的是确定性的错字检查，通顺度只在有把握的中文句子上出现。
