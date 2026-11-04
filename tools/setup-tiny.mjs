/**
 * 把 11 MB 的 ALBERT-tiny 拼成一个 transformers.js 能直接吃的本地目录，
 * 用来回答"小模型到底行不行"。
 */
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'Hosstia/bert-tiny-chinese-onnx'
const OUT = path.resolve('.model-cache/local-tiny')
fs.mkdirSync(path.join(OUT, 'onnx'), { recursive: true })

async function download(url, target) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()))
  console.log(`  ${(fs.statSync(target).size / 1048576).toFixed(1)} MB -> ${path.relative('.', target)}`)
}

console.log('下载 tiny 模型：')
await download(`https://huggingface.co/${REPO}/resolve/main/config.json`, path.join(OUT, 'config.json'))
await download(`https://huggingface.co/${REPO}/resolve/main/vocab.txt`, path.join(OUT, 'vocab.txt'))
await download(`https://huggingface.co/${REPO}/resolve/main/model_int8.onnx`, path.join(OUT, 'onnx', 'model_quantized.onnx'))

const config = JSON.parse(fs.readFileSync(path.join(OUT, 'config.json'), 'utf8'))
console.log(`  架构 ${config.architectures}  L${config.num_hidden_layers}/H${config.hidden_size}  v${config.vocab_size}`)

// tokenizer.json 借用同词表的 bert-base-chinese；vocab 不同就不借。
const ref = '.model-cache/Xenova/bert-base-chinese/tokenizer.json'
if (fs.existsSync(ref)) {
  fs.copyFileSync(ref, path.join(OUT, 'tokenizer.json'))
  fs.writeFileSync(path.join(OUT, 'tokenizer_config.json'), JSON.stringify({
    do_lower_case: true,
    tokenizer_class: 'BertTokenizer',
    model_max_length: 512,
  }), 'utf8')
  console.log('  借用 bert-base-chinese 的 tokenizer.json（词表同为 21128）')
} else {
  console.log('  缺少参考 tokenizer，跳过')
}
