/** Exit without disposal, as when a desktop Host is terminated. */
const { createModelProcess } = await import(process.argv[2])
const worker = createModelProcess({ profileDirectory: process.argv[3] })
await worker.request(new Request('http://127.0.0.1/zh-typo-model/status'))
console.log(worker.pid)
process.exit(0)
