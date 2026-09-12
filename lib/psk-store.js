// 配对 PSK 本地持久化(宿主侧)。文件:<DSH_HOME|~/.dsh>/dsh-mobile-psks.json,
// 数组最新在前,上限 8 条(多次配对共存:设备 A 不因配对设备 B 而失效)。
// PSK 属于密钥材料,与 adminKey 同级 —— 文件权限随用户目录,不进 dotfiles。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { kidFor } from './relay-crypto.js'

const MAX_ENTRIES = 8

export function createPskStore({ emit }) {
  const file = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-mobile-psks.json')
  let entries = []
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Array.isArray(parsed?.psks)) entries = parsed.psks.filter((e) => e && e.kid && e.psk)
  } catch { /* 首次/损坏:空表起 */ }

  const save = () => {
    try {
      fs.writeFileSync(file, JSON.stringify({ psks: entries.slice(0, MAX_ENTRIES) }, null, 2))
    } catch (e) {
      emit?.('warning', 'PSK 持久化失败:' + String(e && e.message ? e.message : e))
    }
  }

  return {
    /** 配对确认后落一条(同 kid 原地刷新,置顶)。 */
    add(pskB64, device) {
      const kid = kidFor(pskB64)
      entries = entries.filter((e) => e.kid !== kid)
      entries.unshift({ kid, psk: pskB64, device: String(device ?? ''), at: Date.now() })
      save()
    },
    byKid(kid) {
      return entries.find((e) => e.kid === kid) ?? null
    },
    count() {
      return entries.length
    },
  }
}
