// Server-side quota + kill switch + founder mode
// per IP daily limit + global daily cap + max turns + max audio + env kill switch
// P0-0: quota refund on failed start_game (no playable response)
// P0-3: founder mode — FOUNDER_TOKEN bypasses public quota, uses FOUNDER_DAILY_LIMIT

import fs from 'fs'

// ====== Config (from env) ======
const BETA_DISABLED = process.env.BETA_DISABLED === 'true'
const PER_IP_DAILY_LIMIT = parseInt(process.env.PER_IP_DAILY_LIMIT || '5', 10)  // 每 IP 每天 5 局
const GLOBAL_DAILY_CAP = parseInt(process.env.GLOBAL_DAILY_CAP || '200', 10)    // 全站每天 200 局
const MAX_TURNS_PER_GAME = parseInt(process.env.MAX_TURNS_PER_GAME || '5', 10)
const MAX_AUDIO_BYTES = parseInt(process.env.MAX_AUDIO_BYTES || (2 * 1024 * 1024).toString(), 10)  // 2MB
const MAX_AUDIO_SECONDS = parseInt(process.env.MAX_AUDIO_SECONDS || '60', 10)  // 60 秒

// P0-3: Founder mode config
const FOUNDER_MODE_ENABLED = process.env.FOUNDER_MODE_ENABLED === 'true'
const FOUNDER_DAILY_LIMIT = parseInt(process.env.FOUNDER_DAILY_LIMIT || '100', 10)
const FOUNDER_TOKEN = process.env.FOUNDER_TOKEN || ''  // never logged, never sent to frontend

// ====== State (in-memory, 重啟重置) ======
const ipCountFile = '/tmp/voice-game-ip-counts.json'
const globalCountFile = '/tmp/voice-game-global-count.json'
const founderCountFile = '/tmp/voice-game-founder-counts.json'  // P0-3: separate counter for founder

interface IpCount {
  date: string  // YYYY-MM-DD
  count: number
}

interface GlobalCount {
  date: string
  count: number
}

// P0-3: User mode classification
export type UserMode = 'founder' | 'public'

export interface UserIdentity {
  mode: UserMode
  ipHash: string
  founderToken?: string  // never logged
}

function loadIpCounts(): Map<string, IpCount> {
  try {
    const raw = fs.readFileSync(ipCountFile, 'utf-8')
    return new Map(Object.entries(JSON.parse(raw)))
  } catch {
    return new Map()
  }
}

function saveIpCounts(map: Map<string, IpCount>): void {
  try {
    fs.writeFileSync(ipCountFile, JSON.stringify(Object.fromEntries(map)))
  } catch (err) {
    console.error('[quota] failed to save ip counts:', err)
  }
}

function loadGlobalCount(): GlobalCount {
  try {
    return JSON.parse(fs.readFileSync(globalCountFile, 'utf-8'))
  } catch {
    return { date: '', count: 0 }
  }
}

function saveGlobalCount(count: GlobalCount): void {
  try {
    fs.writeFileSync(globalCountFile, JSON.stringify(count))
  } catch (err) {
    console.error('[quota] failed to save global count:', err)
  }
}

// P0-3: Founder counts (separate from public, so founder testing doesn't pollute public counters)
function loadFounderCounts(): Map<string, IpCount> {
  try {
    const raw = fs.readFileSync(founderCountFile, 'utf-8')
    return new Map(Object.entries(JSON.parse(raw)))
  } catch {
    return new Map()
  }
}

function saveFounderCounts(map: Map<string, IpCount>): void {
  try {
    fs.writeFileSync(founderCountFile, JSON.stringify(Object.fromEntries(map)))
  } catch (err) {
    console.error('[quota] failed to save founder counts:', err)
  }
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

// P0-3: Classify user based on founder token
function classifyUser(ipHash: string, founderToken?: string): UserIdentity {
  if (FOUNDER_MODE_ENABLED && founderToken && FOUNDER_TOKEN && founderToken === FOUNDER_TOKEN) {
    return { mode: 'founder', ipHash, founderToken }
  }
  return { mode: 'public', ipHash }
}

// ====== Public API ======

export interface QuotaCheckResult {
  ok: boolean
  reason?: string
  mode?: UserMode  // P0-3: tell caller which mode was evaluated
}

export class QuotaChecker {
  /** P0-3: 檢查 quota — 支援 founder mode */
  static checkCanStart(ipHash: string, founderToken?: string): QuotaCheckResult {
    const user = classifyUser(ipHash, founderToken)
    const today = todayStr()

    // ====== Founder mode ======
    if (user.mode === 'founder') {
      const founderCounts = loadFounderCounts()
      const entry = founderCounts.get(ipHash)
      if (entry && entry.date === today && entry.count >= FOUNDER_DAILY_LIMIT) {
        return { ok: false, reason: `FOUNDER_DAILY_LIMIT (${FOUNDER_DAILY_LIMIT})`, mode: 'founder' }
      }
      return { ok: true, mode: 'founder' }
    }

    // ====== Public mode ======
    // 1. kill switch
    if (BETA_DISABLED) {
      return { ok: false, reason: 'BETA_DISABLED', mode: 'public' }
    }

    // 2. per-IP daily limit
    const ipCounts = loadIpCounts()
    const ipEntry = ipCounts.get(ipHash)
    if (ipEntry && ipEntry.date === today && ipEntry.count >= PER_IP_DAILY_LIMIT) {
      return { ok: false, reason: `PER_IP_DAILY_LIMIT (${PER_IP_DAILY_LIMIT})`, mode: 'public' }
    }

    // 3. global daily cap
    const global = loadGlobalCount()
    if (global.date === today && global.count >= GLOBAL_DAILY_CAP) {
      return { ok: false, reason: `GLOBAL_DAILY_CAP (${GLOBAL_DAILY_CAP})`, mode: 'public' }
    }

    return { ok: true, mode: 'public' }
  }

  /** P0-3: 記錄一次開局 — 根據 mode 寫入對應 counter */
  static recordStart(ipHash: string, founderToken?: string): UserMode {
    const user = classifyUser(ipHash, founderToken)
    const today = todayStr()

    if (user.mode === 'founder') {
      const founderCounts = loadFounderCounts()
      const entry = founderCounts.get(ipHash) || { date: today, count: 0 }
      if (entry.date !== today) {
        entry.date = today
        entry.count = 0
      }
      entry.count++
      founderCounts.set(ipHash, entry)
      saveFounderCounts(founderCounts)
      return 'founder'
    }

    // public mode
    const ipCounts = loadIpCounts()
    const entry = ipCounts.get(ipHash) || { date: today, count: 0 }
    if (entry.date !== today) {
      entry.date = today
      entry.count = 0
    }
    entry.count++
    ipCounts.set(ipHash, entry)
    saveIpCounts(ipCounts)

    const global = loadGlobalCount()
    if (global.date !== today) {
      global.date = today
      global.count = 0
    }
    global.count++
    saveGlobalCount(global)
    return 'public'
  }

  /** P0-0: 退還一次開局 — 失敗的 start_game 不扣 quota */
  static refundStart(ipHash: string, founderToken?: string): UserMode {
    const user = classifyUser(ipHash, founderToken)
    const today = todayStr()

    if (user.mode === 'founder') {
      const founderCounts = loadFounderCounts()
      const entry = founderCounts.get(ipHash)
      if (entry && entry.date === today && entry.count > 0) {
        entry.count--
        founderCounts.set(ipHash, entry)
        saveFounderCounts(founderCounts)
        console.log(`[quota] founder refund: ${ipHash} → ${entry.count}`)
      }
      return 'founder'
    }

    // public mode refund
    const ipCounts = loadIpCounts()
    const entry = ipCounts.get(ipHash)
    if (entry && entry.date === today && entry.count > 0) {
      entry.count--
      ipCounts.set(ipHash, entry)
      saveIpCounts(ipCounts)
      console.log(`[quota] public refund: ${ipHash} → ${entry.count}`)
    }

    const global = loadGlobalCount()
    if (global.date === today && global.count > 0) {
      global.count--
      saveGlobalCount(global)
    }
    return 'public'
  }

  /** 檢查 audio 大小 */
  static checkAudioSize(audioBytes: number): QuotaCheckResult {
    if (audioBytes > MAX_AUDIO_BYTES) {
      return { ok: false, reason: `AUDIO_TOO_LARGE (max ${MAX_AUDIO_BYTES} bytes)` }
    }
    return { ok: true }
  }

  /** 檢查是否超過 max turns */
  static checkMaxTurns(currentTurn: number): QuotaCheckResult {
    if (currentTurn >= MAX_TURNS_PER_GAME) {
      return { ok: false, reason: `MAX_TURNS_REACHED (${MAX_TURNS_PER_GAME})` }
    }
    return { ok: true }
  }

  /** P0-3: 取得目前限額狀態 — 根據 mode 回傳對應 limit */
  static getStatus(ipHash: string, founderToken?: string): {
    betaDisabled: boolean
    perIpRemaining: number
    perIpLimit: number
    globalRemaining: number
    globalLimit: number
    maxTurns: number
    userMode: UserMode
    founderModeEnabled: boolean
  } {
    const user = classifyUser(ipHash, founderToken)
    const today = todayStr()

    if (user.mode === 'founder') {
      const founderCounts = loadFounderCounts()
      const entry = founderCounts.get(ipHash)
      const used = (entry && entry.date === today) ? entry.count : 0
      return {
        betaDisabled: false,  // founder mode bypasses beta disabled
        perIpRemaining: Math.max(0, FOUNDER_DAILY_LIMIT - used),
        perIpLimit: FOUNDER_DAILY_LIMIT,
        globalRemaining: Math.max(0, FOUNDER_DAILY_LIMIT - used),  // founder doesn't share global cap
        globalLimit: FOUNDER_DAILY_LIMIT,
        maxTurns: MAX_TURNS_PER_GAME,
        userMode: 'founder',
        founderModeEnabled: FOUNDER_MODE_ENABLED,
      }
    }

    const ipCounts = loadIpCounts()
    const ipEntry = ipCounts.get(ipHash)
    const ipUsed = (ipEntry && ipEntry.date === today) ? ipEntry.count : 0

    const global = loadGlobalCount()
    const globalUsed = global.date === today ? global.count : 0

    return {
      betaDisabled: BETA_DISABLED,
      perIpRemaining: Math.max(0, PER_IP_DAILY_LIMIT - ipUsed),
      perIpLimit: PER_IP_DAILY_LIMIT,
      globalRemaining: Math.max(0, GLOBAL_DAILY_CAP - globalUsed),
      globalLimit: GLOBAL_DAILY_CAP,
      maxTurns: MAX_TURNS_PER_GAME,
      userMode: 'public',
      founderModeEnabled: FOUNDER_MODE_ENABLED,
    }
  }

  /** P0-3: 驗證 founder token（給前端 connected event 用） */
  static isFounderTokenValid(founderToken?: string): boolean {
    return FOUNDER_MODE_ENABLED && !!founderToken && !!FOUNDER_TOKEN && founderToken === FOUNDER_TOKEN
  }

  /** P0-3: founder mode 是否啟用（給前端顯示用） */
  static isFounderModeEnabled(): boolean {
    return FOUNDER_MODE_ENABLED
  }
}

export const MAX_AUDIO_SECONDS_EXPORT = MAX_AUDIO_SECONDS
