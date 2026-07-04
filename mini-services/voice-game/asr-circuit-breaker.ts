// ASR Circuit Breaker
// 監控 ASR 429 失敗率，避免使用者陷入重試地獄
//
// 規則（per 大G Bug C Level 1 fix）:
//   - per session 連續 2 次 ASR 429 → 該 session 進入 cooldown 90 秒
//   - global 5 分鐘內超過 5 次 ASR 429 → 全站進入 cooldown 120 秒
//   - circuit open 時，submit_audio 不打 provider，直接回 rate_limited error_msg
//   - usage log 記 asr_circuit_open: true, asr_rate_limited: true, cooldown_until
//
// 用 in-memory + file persist，重啟後 global state 保留（session state 重置）

import fs from 'fs'

const GLOBAL_STATE_FILE = '/tmp/voice-game-asr-breaker.json'

interface SessionBreakerState {
  consecutive429: number
  circuitOpenUntil: number  // timestamp ms，0 = closed
}

interface GlobalBreakerState {
  recent429s: number[]  // timestamps of recent 429s (within 5 min window)
  circuitOpenUntil: number  // timestamp ms，0 = closed
}

// ====== In-memory state ======
const sessionBreakers = new Map<string, SessionBreakerState>()
let globalBreaker: GlobalBreakerState = loadGlobalState()

const SESSION_COOLDOWN_MS = 90 * 1000  // 90 秒
const GLOBAL_COOLDOWN_MS = 120 * 1000  // 120 秒
const SESSION_THRESHOLD = 2  // 連續 2 次
const GLOBAL_THRESHOLD = 5   // 5 分鐘內 5 次（比 TTS 寬鬆，因為 ASR 429 更常見）
const GLOBAL_WINDOW_MS = 5 * 60 * 1000  // 5 分鐘 window

function loadGlobalState(): GlobalBreakerState {
  try {
    const raw = fs.readFileSync(GLOBAL_STATE_FILE, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return { recent429s: [], circuitOpenUntil: 0 }
  }
}

function saveGlobalState(): void {
  try {
    fs.writeFileSync(GLOBAL_STATE_FILE, JSON.stringify(globalBreaker))
  } catch (err) {
    console.error('[asr-circuit-breaker] failed to save:', err)
  }
}

function nowMs(): number {
  return Date.now()
}

// ====== Public API ======

export interface ASRBreakerStatus {
  mode: 'asr_ok' | 'asr_rate_limited'
  reason?: string  // 'SESSION_RATE_LIMIT' | 'GLOBAL_RATE_LIMIT'
  retryAfterMs?: number  // 多久後可重試
}

export class ASRCircuitBreaker {
  /** 檢查當前是否應該跳過 ASR（per session + global） */
  static check(sessionId: string): ASRBreakerStatus {
    // 1. global breaker 優先
    if (globalBreaker.circuitOpenUntil > nowMs()) {
      return {
        mode: 'asr_rate_limited',
        reason: 'GLOBAL_RATE_LIMIT',
        retryAfterMs: globalBreaker.circuitOpenUntil - nowMs(),
      }
    }
    // global breaker 過期了，重置
    if (globalBreaker.circuitOpenUntil > 0 && globalBreaker.circuitOpenUntil <= nowMs()) {
      globalBreaker.circuitOpenUntil = 0
      globalBreaker.recent429s = []
      saveGlobalState()
    }

    // 2. session breaker
    const session = sessionBreakers.get(sessionId)
    if (session && session.circuitOpenUntil > nowMs()) {
      return {
        mode: 'asr_rate_limited',
        reason: 'SESSION_RATE_LIMIT',
        retryAfterMs: session.circuitOpenUntil - nowMs(),
      }
    }
    // session breaker 過期，重置
    if (session && session.circuitOpenUntil > 0 && session.circuitOpenUntil <= nowMs()) {
      session.consecutive429 = 0
      session.circuitOpenUntil = 0
    }

    return { mode: 'asr_ok' }
  }

  /** 記錄一次 ASR 429 失敗 */
  static record429(sessionId: string): { sessionTripped: boolean; globalTripped: boolean } {
    const now = nowMs()

    // === session breaker ===
    let session = sessionBreakers.get(sessionId)
    if (!session) {
      session = { consecutive429: 0, circuitOpenUntil: 0 }
      sessionBreakers.set(sessionId, session)
    }
    session.consecutive429++
    let sessionTripped = false
    if (session.consecutive429 >= SESSION_THRESHOLD && session.circuitOpenUntil <= now) {
      session.circuitOpenUntil = now + SESSION_COOLDOWN_MS
      sessionTripped = true
      console.warn(`[asr-circuit-breaker] SESSION tripped: ${sessionId.slice(0, 8)} for ${SESSION_COOLDOWN_MS / 1000}s`)
    }

    // === global breaker ===
    // 清掉過期的 429 紀錄（超過 5 分鐘 window）
    globalBreaker.recent429s = globalBreaker.recent429s.filter(ts => now - ts < GLOBAL_WINDOW_MS)
    globalBreaker.recent429s.push(now)
    let globalTripped = false
    if (globalBreaker.recent429s.length >= GLOBAL_THRESHOLD && globalBreaker.circuitOpenUntil <= now) {
      globalBreaker.circuitOpenUntil = now + GLOBAL_COOLDOWN_MS
      globalTripped = true
      console.warn(`[asr-circuit-breaker] GLOBAL tripped for ${GLOBAL_COOLDOWN_MS / 1000}s (${globalBreaker.recent429s.length} 429s in window)`)
    }
    saveGlobalState()

    return { sessionTripped, globalTripped }
  }

  /** 記錄一次 ASR 成功（重置 session 連續失敗計數） */
  static recordSuccess(sessionId: string): void {
    const session = sessionBreakers.get(sessionId)
    if (session) {
      session.consecutive429 = 0
    }
  }

  /** 取得目前狀態（給 monitor 用） */
  static getStatus(): {
    globalOpen: boolean
    globalRetryAfterMs: number
    globalRecent429s: number
    sessionsOpen: number
  } {
    const now = nowMs()
    const globalOpen = globalBreaker.circuitOpenUntil > now
    let sessionsOpen = 0
    for (const [, s] of sessionBreakers) {
      if (s.circuitOpenUntil > now) sessionsOpen++
    }
    return {
      globalOpen,
      globalRetryAfterMs: globalOpen ? globalBreaker.circuitOpenUntil - now : 0,
      globalRecent429s: globalBreaker.recent429s.filter(ts => now - ts < GLOBAL_WINDOW_MS).length,
      sessionsOpen,
    }
  }
}
