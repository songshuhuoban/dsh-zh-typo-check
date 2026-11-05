/** 校验客户端模块的注册 id 是否等于包名。 */
import fs from 'node:fs'

const source = fs.readFileSync('bundle/client.js', 'utf8')
const match = /id: "([^"]+)",/.exec(source)
const pkg = JSON.parse(fs.readFileSync('bundle/package.json', 'utf8'))
const ok = match !== null && match[1] === pkg.name
console.log(`client module id: ${match === null ? '(missing)' : match[1]}`)
console.log(`package name    : ${pkg.name}`)
console.log(`match           : ${ok}`)
process.exit(ok ? 0 : 1)
