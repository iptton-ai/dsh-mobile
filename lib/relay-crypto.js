// 中转数据腿端到端加密(dsh-mobile ↔ singleman;网关只逐帧透传密文)。
//
// 密钥层次:配对时经二维码 fragment 带外分发 32 字节 PSK(k= 参数,不落
// 网关)→ 每条数据腿用 HKDF-SHA256 派生方向子密钥(salt 绑定 rsid):
//   c2h = HKDF(PSK, "dsh-relay-v1:"+rsid, "dsh-c2h")   手机→宿主
//   h2c = HKDF(PSK, "dsh-relay-v1:"+rsid, "dsh-h2c")   宿主→手机
// 帧封装(WS 二进制消息):[0x01][12B nonce][密文][16B GCM tag];
// nonce = 4B 零 + u64 BE 计数器,每方向从 0 单调递增,收方严格校验
// 连续性(乱序/重放/跳号 = 断腿重连)。kid = SHA-256(PSK) 前 8 字符
// (b64url),仅作密钥提示,不泄露密钥材料。
//
// 协商:手机腿 ready 后发 {"t":"crypto","v":1,"kid"},宿主有对应 PSK 则
// 回 crypto-ok 双方转入密文,否则回 crypto-na 降级明文(面板警示)。
// 与 Dart 侧(lib/connection/relay/relay_crypto.dart)逐字节互操作,
// 固定向量见 test/relay-crypto-vectors.json。
import crypto from 'node:crypto'

export const ENV_VER = 1
const NONCE_LEN = 12
const TAG_LEN = 16
const HEADER_LEN = 1 + NONCE_LEN

export const genPsk = () => crypto.randomBytes(32).toString('base64url')

export const kidFor = (pskB64) =>
  crypto.createHash('sha256').update(Buffer.from(pskB64, 'base64url')).digest('base64url').slice(0, 8)

export function deriveKeys(pskB64, rsid) {
  const ikm = Buffer.from(pskB64, 'base64url')
  const salt = Buffer.from('dsh-relay-v1:' + rsid, 'utf8')
  const hkdf = (info) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), 32))
  return { c2h: hkdf('dsh-c2h'), h2c: hkdf('dsh-h2c') }
}

const nonceFor = (counter) => {
  const n = Buffer.alloc(NONCE_LEN)
  n.writeUInt32BE(Math.floor(counter / 2 ** 32), 4)
  n.writeUInt32BE(counter >>> 0, 8)
  return n
}

/** 明文 vstream 帧 → 密文信封(计数器由调用方按方向维护并单调递增)。 */
export function seal(key, counter, frame) {
  const nonce = nonceFor(counter)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([cipher.update(frame), cipher.final()])
  return Buffer.concat([Buffer.from([ENV_VER]), nonce, ct, cipher.getAuthTag()])
}

/** 密文信封 → 明文帧;版本/计数器/认证标签任一不符即抛错(调用方断腿)。 */
export function open(key, counter, envelope) {
  if (envelope.length < HEADER_LEN + TAG_LEN || envelope[0] !== ENV_VER) {
    throw new Error('bad envelope version/length')
  }
  if (!nonceFor(counter).equals(envelope.subarray(1, 1 + NONCE_LEN))) {
    throw new Error('nonce/counter out of order')
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.subarray(1, 1 + NONCE_LEN))
  decipher.setAuthTag(envelope.subarray(envelope.length - TAG_LEN))
  return Buffer.concat([
    decipher.update(envelope.subarray(HEADER_LEN, envelope.length - TAG_LEN)),
    decipher.final(),
  ])
}
