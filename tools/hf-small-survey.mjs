/**
 * 找「小尺寸 + 已有 ONNX」的中文模型。
 * 小模型通常藏在冷门仓库里，所以按组织、按关键词多扫几轮。
 */
const MB = (n) => ((n ?? 0) / 1048576).toFixed(1)

async function models(query) {
  const res = await fetch(`https://huggingface.co/api/models?${query}`)
  return res.ok ? res.json() : []
}

async function onnxSize(id) {
  const res = await fetch(`https://huggingface.co/api/models/${id}/tree/main?recursive=true`)
  if (!res.ok) return null
  const files = (await res.json()).filter((f) => f.type === 'file' && String(f.path).endsWith('.onnx'))
  if (files.length === 0) return null
  return { count: files.length, min: Math.min(...files.map((f) => f.size ?? 0)), max: Math.max(...files.map((f) => f.size ?? 0)) }
}

const seen = new Set()
const rows = []

for (const query of [
  'search=chinese%20onnx&sort=likes&direction=-1&limit=60',
  'search=chinese&author=onnx-community&limit=60',
  'search=tiny%20chinese&limit=40',
  'search=small%20chinese%20bert&limit=40',
  'search=chinese%20mlm&limit=40',
]) {
  for (const row of await models(query)) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    rows.push(row)
  }
}

const candidates = []
for (const row of rows) {
  const onnx = await onnxSize(row.id)
  if (onnx === null) continue
  candidates.push({ id: row.id, downloads: row.downloads ?? 0, likes: row.likes ?? 0, onnx, updated: row.lastModified?.slice(0, 10) })
}

candidates.sort((a, b) => a.onnx.min - b.onnx.min)
console.log('按 ONNX 最小体积排序（前 25）')
console.log('最小MB   最大MB  文件数  下载      更新        模型')
for (const c of candidates.slice(0, 25)) {
  console.log(`${MB(c.onnx.min).padStart(7)} ${MB(c.onnx.max).padStart(8)} ${String(c.onnx.count).padStart(6)}  ${String(c.downloads).padStart(8)}  ${c.updated}  ${c.id}`)
}
console.log(`\n共 ${rows.length} 个仓库中，${candidates.length} 个含 ONNX`)
