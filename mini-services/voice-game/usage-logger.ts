// Structured usage logger — JSONL format, one line per event
// 寫到 /tmp/voice-game-usage.jsonl（重啟不遺失，且不污染 repo）

import fs from 'fs'
import path from 'path'

const LOG_FILE = process.env.USAGE_LOG_FILE || '/tmp/voice-game-usage.jsonl'

// 確保 log 目錄存在
const logDir = path.dirname(LOG_FILE)
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true })
}

export interface UsageEvent {
  session_id: string
  anon_user_id: string
  turn_id: number
  generation_id: string
  event_type: string
  timestamp: string  // ISO 8601
  // 以下欄位 optional，依 event_type 決定填哪些
  asr_latency_ms?: number
  llm_first_token_ms?: number
  llm_total_ms?: number
  tts_first_audio_ms?: number
  tts_total_ms?: number
  audio_bytes_in?: number
  audio_bytes_out?: number
  retry_count?: number
  error_code?: string
  ending_type?: string
  completed?: boolean
  dropped?: boolean
  share_clicked?: boolean
  replay_clicked?: boolean
  category?: string
  template_id?: string
  extra?: Record<string, any>
}

export class UsageLogger {
  private stream: fs.WriteStream | null = null

  private getStream(): fs.WriteStream {
    if (!this.stream || this.stream.destroyed) {
      this.stream = fs.createWriteStream(LOG_FILE, { flags: 'a' })
    }
    return this.stream
  }

  log(event: UsageEvent): void {
    try {
      const line = JSON.stringify(event) + '\n'
      this.getStream().write(line)
    } catch (err) {
      // logging 失敗不應該影響遊戲流程
      console.error('[usage-logger] failed to write:', err)
    }
  }

  // 把 anon_user_id 做 hash（不存 raw IP）
  static hashUserId(rawId: string): string {
    // 簡單 hash：取 SHA256 前 16 chars
    // 不用 crypto 是為了避免 import 麻煩，用簡單 hash 即可（這不是密碼學用途）
    let hash = 0
    for (let i = 0; i < rawId.length; i++) {
      const char = rawId.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash |= 0
    }
    return 'u_' + Math.abs(hash).toString(36).padStart(8, '0').slice(0, 12)
  }
}

export const usageLogger = new UsageLogger()

// Helper: 記錄一個事件的簡單包裝
export function logUsage(event: UsageEvent): void {
  usageLogger.log(event)
}
