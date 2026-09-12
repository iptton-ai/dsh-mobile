#!/usr/bin/env node
// 节点侧向量自检:用 lib/relay-crypto.js 解开 test/relay-crypto-vectors.json
// 里的固定密文(与 Dart 测试同一份文件),并验证 seal 往返。
import fs from 'node:fs'
import { deriveKeys, seal, open, kidFor } from '../lib/relay-crypto.js'

const v = JSON.parse(fs.readFileSync(new URL('../test/relay-crypto-vectors.json', import.meta.url), 'utf8'))
const keys = deriveKeys(v.psk, v.rsid)
if (kidFor(v.psk) !== v.kid) throw new Error('kid mismatch')
for (const c of v.cases) {
  const env = Buffer.from(c.envelope_hex, 'hex')
  const key = c.dir === 'p2h' ? keys.c2h : keys.h2c
  const pt = open(key, c.counter, env)
  if (!pt.equals(Buffer.from(c.plaintext_hex, 'hex'))) throw new Error('open mismatch: ' + c.dir + '#' + c.counter)
  const re = seal(key, c.counter, pt)
  if (!re.equals(env)) throw new Error('seal mismatch: ' + c.dir + '#' + c.counter)
}
// 自造帧往返 + 篡改拒收
const pt = Buffer.from('roundtrip')
const env = seal(keys.c2h, 7, pt)
if (!open(keys.c2h, 7, env).equals(pt)) throw new Error('roundtrip fail')
env[env.length - 1] ^= 1
try { open(keys.c2h, 7, env); throw new Error('tamper accepted') } catch (e) {
  if (String(e.message) === 'tamper accepted') throw e
}
console.log('crypto vectors: OK (' + v.cases.length + ' cases, kid ' + v.kid + ')')
