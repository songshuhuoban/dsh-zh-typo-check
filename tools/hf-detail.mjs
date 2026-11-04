/**
 * 候选模型细查：参数量、ONNX 体积、许可证、最后更新时间。
 * 参数量从 config.json 的 hidden_size / num_layers / vocab_size 估算。
 */
const CANDIDATES = [
  'Xenova/bert-base-chinese',
  'Xenova/macbert4csc-base-chinese',
  'shibing624/macbert4csc-base-chinese',
  'uer/chinese_roberta_L-4_H-256',
  'uer/chinese_roberta_L-2_H-128',
  'ckiplab/albert-tiny-chinese',
  'ckiplab/albert-base-chinese',
  'hfl/chinese-electra-180g-small-generator',
  'hfl/chinese-electra-180g-small-ex-generator',
  'junnyu/roformer_chinese_small',
  'iioSnail/ChineseBERT-for-csc',
  'iioSnail/ReaLiSe-for-csc',
  'LuRr/babylm-chinese-deberta-v2-14m-CL',
]

const MB = (n) => (n === undefined || n === null ? '-' : (n / 1048576).toFixed(1))

async function head(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' })
    if (!res.ok) return null
    return res
  } catch { return null }
}

async function getJson(url) {
  const res = await head(url)
  if (res === null) return null
  const text = await (await fetch(url)).text()
  try { return JSON.parse(text) } catch { return null }
}

for (const id of CANDIDATES) {
  const meta = await getJson(`https://huggingface.co/api/models/${id}`)
  if (meta === null) { console.log(`${id}  (not found)`); continue }
  const config = await getJson(`https://huggingface.co/${id}/resolve/main/config.json`)

  const tree = await getJson(`https://huggingface.co/api/models/${id}/tree/main?recursive=true`) ?? []
  const files = Array.isArray(tree) ? tree.filter((f) => f.type === 'file') : []
  const onnx = files.filter((f) => String(f.path).includes('onnx') && String(f.path).endsWith('.onnx'))
  const biggestOnnx = onnx.sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0]
  const smallestOnnx = onnx.sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0]
  const safetensors = files.filter((f) => String(f.path).endsWith('.safetensors'))
  const weights = safetensors.reduce((sum, f) => sum + (f.size ?? 0), 0)

  let params = '-'
  if (config && typeof config.hidden_size === 'number' && typeof config.num_hidden_layers === 'number') {
    const h = config.hidden_size
    const l = config.num_hidden_layers
    const v = config.vocab_size ?? 21128
    const i = config.intermediate_size ?? h * 4
    const perLayer = 4 * h * h + 2 * h * i
    const total = v * h + l * perLayer + 2 * h
    params = (total / 1e6).toFixed(1) + ' M'
  } else if (config && typeof config.hidden_size === 'number' && config.encoder_layers) {
    params = `~${config.encoder_layers}L/${config.hidden_size}H`
  }

  console.log(`\n${id}`)
  console.log(`  参数     ${params}${config?.hidden_size ? `   (L${config.num_hidden_layers ?? config.encoder_layers}/${config.hidden_size}H, v${config.vocab_size})` : ''}`)
  console.log(`  许可证   ${meta.cardData?.license ?? meta.tags?.find((t) => t.startsWith('license:')) ?? '?'}`)
  console.log(`  更新     ${meta.lastModified?.slice(0, 10) ?? '?'}    下载 ${meta.downloads ?? 0}`)
  if (onnx.length > 0) console.log(`  ONNX     ${onnx.length} 个：最小 ${MB(smallestOnnx.size)} MB，最大 ${MB(biggestOnnx.size)} MB`)
  else console.log('  ONNX     无')
  if (weights > 0) console.log(`  权重     safetensors ${MB(weights)} MB`)
}
