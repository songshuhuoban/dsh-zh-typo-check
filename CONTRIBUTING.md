# 开发说明

这个仓库同时是一个 DSH 插件包（`bundle/`）和它的实验台（`src/`、`tools/`、`data/`）。
面向使用者的说明在 [README.md](README.md)。

## 结构

```
bundle/             可发布的插件包（npm 就是发这个目录）
  index.js          宿主半边：模型下载 / 校验 / 分发 / 检查路由
  client.js         页面半边：下划线、气泡、设置页（构建产物，勿手改）
  tokenizer.mjs     BERT 分词器（与 transformers.js 逐 token 对齐）
  infer.mjs         掩码打分
  lexicon.mjs       词表与近音字表
  checker.mjs       A/B 两路合流
  l1.mjs            同音候选
  core.mjs          规则判定
  data/             词表（构建时从 data/ 复制）
src/                源码
  client.js         页面半边的模板（client.js 由它 + core/editor 拼成）
  editor.mjs        DOM 偏移映射
  ...
tools/              构建与验证脚本
data/               生成的词表
```

## 构建

```bash
node tools/build-client.mjs
```

它会做三件事：把 `src/core.mjs`、`src/editor.mjs` 拼进 `bundle/client.js`；
把宿主侧模块从 `src/` 复制到 `bundle/`；把词表从 `data/` 复制到 `bundle/data/`。

**`bundle/client.js` 是产物**，改它没用，改 `src/client.js`。

## 测试

```bash
node src/editor.test.mjs               # DOM 偏移映射
node src/demo.mjs                      # 真实错句
node src/adversarial.mjs               # 正常句子误报
node tools/model-service-test.mjs      # 下载 / 校验 / 分发 / 删除
node tools/tokenizer-test.mjs          # 分词器与 transformers.js 逐 token 对齐
node tools/infer-test.mjs              # 推理正确性
node tools/infer-route-test.mjs        # 检查路由端到端
node tools/plugin-resilience-test.mjs  # 推理链损坏时的降级
node tools/host-eval.mjs all           # 产品路径的精确率 / 召回率
```

宿主侧的测试用的是「假 webServer + 真实匹配规则」，不走真实页面——所以能覆盖路由前缀、
状态机、错误分支这些以前只能靠重启验证的东西。

**一个踩过的坑**：`webServer.register({ kind: 'prefix', path })` 的 `path` **不能带尾斜杠**。
匹配规则是 `pathname === prefix || pathname.startsWith(prefix + '/')`，
写成 `/zh-typo-model/` 会让 `/zh-typo-model/status` 永远失配——注册成功但访问 404。

## 架构

三层，判据全在模型：

```
按键
 └─ L0 规则        微秒级，同步出下划线        成语误字、半角标点、的还→的话
    └─ 停手 400 ms
       └─ 宿主模型   MLM 掩码打分，补语义错   还→话、在→再、因→应……
```

模型那层在宿主进程里跑（`onnxruntime-node`），页面只发一个 HTTP 请求。
同一个模型，宿主原生推理约 21 ms/次，浏览器 WASM 约 135 ms/次——差 6.4 倍，
所以没有把推理放进页面。

判据是：把句子里的某个字遮住，让模型猜这里该是什么字。
猜得比原字强得多（Δ 够大），且替换后"像话"（和邻字成词或在近音集合内），才报。

## 数据

`data/l1-words.txt`（13 万词，带词频）和 `data/l1-sounds.txt`（近音字分组）
由 `tools/build-l1-data.mjs` 从 segmentit + pinyin-pro 生成，随包分发。

词频表只收 `rank > 0` 的词：收进 rank 0 的垃圾条目会造出 `饭→房` 这种误报。

## 评估

`tools/host-eval.mjs` 跑的是产品真实路径（客户端规则 + 宿主模型），
语料在 `src/corpus.mjs`，按 `dev` / `test` 隔离，阈值只在 dev 上定。

当前数字（全集 75 句）：**精确率 100.0% / 召回率 79.5% / F1 88.6**，正常句零误报。
纯规则是 96.3 / 61.9 / 75.4。

逐轮实验记录（含被否掉的方案和原因）在 [NOTES.md](NOTES.md)。

## 发布

```bash
node tools/build-client.mjs
cp README.md bundle/README.md
cd bundle && npm publish
```

`bundle/package.json` 里的 `files` 决定包里有什么；`bundle/data/` 里那 1.9 MB 词表是必需的。
