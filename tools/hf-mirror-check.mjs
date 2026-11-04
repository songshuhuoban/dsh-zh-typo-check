/**
 * 细查两个重点候选，并检查国内镜像可得性。
 */
const MB = (n) => (n / 1048576).toFixed(1)

async function tree(id) {
  const res = await fetch(`https://huggingface.co/api/models/${id}/tree/main?recursive=true`)
  if (!res.ok) return null
  return res.json()
}

for (const id of ['Xenova/macbert4csc-base-chinese', 'Xenova/bert-base-chinese']) {
  const files = await tree(id)
  console.log(`\n===== ${id} =====`)
  if (files === null) { console.log('  (none)'); continue }
  for (const f of files.filter((x) => x.type === 'file').sort((a, b) => (a.size ?? 0) - (b.size ?? 0))) {
    console.log(`${MB(f.size ?? 0).padStart(8)} MB  ${f.path}`)
  }
}

// 国内镜像：hf-mirror.com 是否提供同样的文件
console.log('\n===== hf-mirror 可用性 =====')
for (const path of [
  'https://hf-mirror.com/Xenova/macbert4csc-base-chinese/resolve/main/onnx/model_quantized.onnx',
  'https://hf-mirror.com/shibing624/macbert4csc-base-chinese/resolve/main/config.json',
]) {
  try {
    const res = await fetch(path, { method: 'HEAD', redirect: 'follow' })
    console.log(`  ${res.status}  ${path}`)
  } catch (error) {
    console.log(`  ERR ${path}  ${error.message}`)
  }
}

// ModelScope：中文用户的另一条路
console.log('\n===== ModelScope 是否有同款 =====')
for (const id of ['shibing624/macbert4csc-base-chinese', 'iic/nlp_macbert_base_corrector']) {
  const [owner, name] = id.split('/')
  const url = `https://www.modelscope.cn/api/v1/models/${owner}/${name}`
  try {
    const res = await fetch(url, { method: 'GET' })
    const text = await res.text()
    console.log(`  ${res.status}  ${id}  ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
  } catch (error) {
    console.log(`  ERR ${id}  ${error.message}`)
  }
}
