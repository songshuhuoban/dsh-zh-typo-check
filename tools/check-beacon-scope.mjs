/** 校验客户端 bundle 里 beacon 的作用域顺序：定义必须早于使用。 */
import fs from 'node:fs'

const source = fs.readFileSync('bundle/client.js', 'utf8')
const def = source.indexOf('function beacon(')
const uses = [...source.matchAll(/beacon\(/g)].map((m) => m.index).filter((i) => i !== def + 9)

console.log(`定义位置: ${def}`)
console.log(`调用数: ${uses.length}`)
const bad = uses.filter((i) => i < def)
console.log(`定义前就有调用: ${bad.length > 0 ? bad.join(', ') : '无'}`)
process.exit(def > 0 && bad.length === 0 ? 0 : 1)
