// Server-side quota + kill switch
// per IP daily limit + global daily cap + max turns + max audio + env kill switch

import fs from 'fs'

// ====== Config (from env) ======
const BETA_DISABLED = process.env.BETA_DISABLED === 'true'
const PER_IP_DAILY_LIMIT = parseInt(process.env.PER_IP_DAILY_LIMIT || '5', 10)  // 每 IP 每天 5 局
const GLOBAL_DAILY_CAP = parseInt(process.env.GLOBAL_DAILY_CAP || '200', 10)    // 全站每天 200 局
const MAX_TURNS_PER_GAME = parseInt(process.env.MAX_TURNS_PER_GAME || '5', 10)
const MAX_AUDIO_BYTES = parseInt(process.env.MAX_AUDIO_BYTES || (2 * 1024 * 1024).toString(), 10)  // 2MB
const MAX_AUDIO_SECONDS = parseInt(process.env.MAX_AUDIO_SECONDS || '60', 10)  // 60 秒

// ====== State (in-memory, 重啟重置) ======
const ipCountFile = '/tmp/voice-game-ip-counts.json'
const globalCountFile = '/tmp/voice-game-global-count.json'

interface IpCount {
  date: string  // YYYY-MM-DD
  count: number
}

interface GlobalCount {
  date: string
  count: number
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

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

// ====== Public API ======

export interface QuotaCheckResult {
  ok: boolean
  reason?: string
}

export class QuotaChecker {
  /** 檢查全域 kill switch + per-IP + global quota */
  static checkCanStart(ipHash: string): QuotaCheckResult {
    // 1. kill switch
    if (BETA_DISABLED) {
      return { ok: false, reason: 'BETA_DISABLED' }
    }

    const today = todayStr()

    // 2. per-IP daily limit
    const ipCounts = loadIpCounts()
    const ipEntry = ipCounts.get(ipHash)
    if (ipEntry && ipEntry.date === today && ipEntry.count >= PER_IP_DAILY_LIMIT) {
      return { ok: false, reason: `PER_IP_DAILY_LIMIT (${PER_IP_DAILY_LIMIT})` }
    }

    // 3. global daily cap
    const global = loadGlobalCount()
    if (global.date === today && global.count >= GLOBAL_DAILY_CAP) {
      return { ok: false, reason: `GLOBAL_DAILY_CAP (${GLOBAL_DAILY_CAP})` }
    }

    return { ok: true }
  }

  /** 記錄一次開局（increment counters） */
  static recordStart(ipHash: string): void {
    const today = todayStr()

    // per-IP
    const ipCounts = loadIpCounts()
    const entry = ipCounts.get(ipHash) || { date: today, count: 0 }
    if (entry.date !== today) {
      entry.date = today
      entry.count = 0
    }
    entry.count++
    ipCounts.set(ipHash, entry)
    saveIpCounts(ipCounts)

    // global
    const global = loadGlobalCount()
    if (global.date !== today) {
      global.date = today
      global.count = 0
    }
    global.count++
    saveGlobalCount(global)
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

  /** 取得目前限額狀態（給前端顯示） */
  static getStatus(ipHash: string): {
    betaDisabled: boolean
    perIpRemaining: number
    perIpLimit: number
    globalRemaining: number
    globalLimit: number
    maxTurns: number
  } {
    const today = todayStr()
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
    }
  }
}

export const MAX_AUDIO_SECONDS_EXPORT = MAX_AUDIO_SECONDS
