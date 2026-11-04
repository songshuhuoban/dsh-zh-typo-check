/**
 * 在 Hugging Face 上普查候选模型：
 *  - 中文掩码语言模型（做上下文判据）
 *  - 中文纠错专用模型（CSC）
 * 输出：下载量、参数量（从 config 推）、是否有 ONNX、ONNX 文件大小。
 */
const QUERIES = [
  { label: 'chinese + fill-mask', q: 'search=chinese&filter=fill-mask&sort=downloads&direction=-1&limit=40' },
  { label: 'chinese + onnx', q: 'search=chinese&filter=onnx&sort=downloads&direction=-1&limit=40' },
  { label: 'spelling correction', q: 'search=spell&sort=downloads&direction=-1&limit=30' },
  { label: 'corrector', q: 'search=corrector&sort=downloads&direction=-1&limit=30' },
  { label: 'csc (chinese spelling check)', q: 'search=csc&sort=downloads&direction=-1&limit=30' },
  { label: 'macbert', q: 'search=macbert&sort=downloads&direction=-1&limit=20' },
]

async function j(url) {
  const res = await fetch(url)
  if (!res.ok) return null
  return res.json()
}

for (const { label, q } of QUERIES) {
  const rows = await j(`https://huggingface.co/api/models?${q}`)
  console.log(`\n===== ${label} =====`)
  if (!rows) { console.log('  (query failed)'); continue }
  for (const row of rows.slice(0, 12)) {
    const d = row.downloads ?? 0
    const likes = row.likes ?? 0
    console.log(`${String(d).padStart(8)} dl  ${String(likes).padStart(4)} ♥  ${String(row.pipeline_tag ?? '-').padEnd(12)} ${row.id}`)
  }
}
