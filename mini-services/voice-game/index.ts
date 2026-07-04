import { createServer } from 'http'
import { Server } from 'socket.io'
import { randomUUID } from 'crypto'
import { openai, getZAI, LLM_MODEL, TTS_VOICE } from './openai-client'
import { SYSTEM_PROMPT, splitIntoSentences, detectEnding, isEnteringEndingBlock, extractPreEndingText, FALLBACK_ENDING_META, EndingMeta } from './prompt'
import { pickRandomTemplate, pickTemplateByCategory, templateToOpeningPrompt, SceneTemplate, CATEGORY_NAMES, SceneCategory, SCENE_TEMPLATES } from './scene-templates'
import { usageLogger, logUsage, UsageLogger } from './usage-logger'
import { QuotaChecker, UserMode } from './quota'
import { checkContentSafety, checkLLMOutput, checkUserInput, SAFETY_FALLBACK_NARRATION } from './safety'
import { TTSCircuitBreaker } from './tts-circuit-breaker'
import { textToSpeechOpenAI, isOpenAIConfigured } from './openai-tts'
import { streamLLMViaOpenAI, isOpenAILLMConfigured } from './openai-llm'

// ====== Types ======
interface GameState {
  messages: Array<{ role: string; content: string }>
  turnCount: number
  ended: boolean
  sessionId: string
  template?: SceneTemplate  // 這一局抽到的場景模板
  currentGenerationId: string  // 當前有效的 generation（用來 discard 舊事件）
  anonUserId: string  // 匿名用戶 ID（IP hash）
  founderToken?: string  // P0-3: founder token (never logged, never sent to frontend)
  userMode: UserMode  // P0-3: 'founder' | 'public'
}

interface PendingTTS {
  seq: number
  text: string
}

// ====== Globals ======
const PORT = 3003
const MAX_TURNS = 5
const games = new Map<string, GameState>() // socket.id -> game state

// P0-1: narrative error copy (no technical jargon, per 大G)
const NARRATIVE_ERRORS = [
  '這段人生剛剛沒有聽清楚，請再說一次。',
  '命運線路短暫打結，請重新敲門。',
  '訊號在時空裂縫中迷路了，再試一次吧。',
  '這段對話被風吹散了，請重說一次。',
]
function pickNarrativeError(): string {
  return NARRATIVE_ERRORS[Math.floor(Math.random() * NARRATIVE_ERRORS.length)]
}

// ====== HTTP + Socket.io server ======
const httpServer = createServer((req, res) => {
  // P1: monitor endpoint for circuit breaker status
  if (req.url === '/health') {
    const breakerStatus = TTSCircuitBreaker.getStatus()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      tts_provider: TTS_PROVIDER,
      openai_configured: isOpenAIConfigured(),
      openai_llm_configured: isOpenAILLMConfigured(),
      circuit_breaker: breakerStatus,
      founder_mode_enabled: QuotaChecker.isFounderModeEnabled(),
      uptime_ms: Date.now() - startTime,
    }))
    return
  }
  res.writeHead(404)
  res.end('Not Found')
})
const startTime = Date.now()

const io = new Server(httpServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 10 * 1024 * 1024, // 10 MB for audio blobs
})

// ====== Helpers ======

/**
 * 把 ReadableStream<Uint8Array> 解析成 SSE events。
 * 支援兩種格式：
 * 1. text/event-stream: 每行 "data: {...}\n\n"
 * 2. text/plain: 直接是字串片段（有些供應商這樣回）
 */
async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      if (abortSignal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // 以換行切，處理 buffer 內所有完整行
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data === '[DONE]') return
          yield data
        } else if (line.startsWith('{') || line.startsWith('[')) {
          // 可能是 JSON 行
          yield line
        } else {
          // 純文字片段
          yield line
        }
      }
    }
    // 收尾
    if (buffer.trim()) {
      const line = buffer.trim()
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        if (data !== '[DONE]') yield data
      } else if (line.startsWith('{') || line.startsWith('[')) {
        yield line
      } else {
        yield line
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * 從 SSE data 字串抽出 content delta。
 * 支援 OpenAI 格式：{"choices":[{"delta":{"content":"..."}}]}
 * 也支援純文字（直接回傳）。
 */
function extractDelta(data: string): string {
  // 嘗試 JSON 解析
  try {
    const obj = JSON.parse(data)
    // OpenAI / GLM chat completion stream 格式
    const delta = obj?.choices?.[0]?.delta?.content
    if (typeof delta === 'string') return delta
    const content = obj?.choices?.[0]?.message?.content
    if (typeof content === 'string') return content
    // 也有可能直接是 {content: "..."}
    if (typeof obj?.content === 'string') return obj.content
    return ''
  } catch {
    // 不是 JSON，當純文字處理
    return data
  }
}

/**
 * 串流呼叫 LLM (via OpenAI SDK + z.ai gateway → GLM-4-plus)。
 */
async function streamLLM(
  messages: Array<{ role: string; content: string }>,
  onText: (chunk: string) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  let fullText = ''
  const t0 = Date.now()
  console.log(`[LLM] starting stream, model=${LLM_MODEL}, messages=${messages.length}`)

  try {
    // Primary: z.ai gateway
    const stream = await openai.chat.completions.create({
      model: LLM_MODEL,
      messages: messages as any,
      stream: true,
      temperature: 0.9,
    }, { signal: abortSignal })
    console.log(`[LLM] stream returned after ${Date.now() - t0}ms`)

    let chunkCount = 0
    for await (const part of stream) {
      if (abortSignal?.aborted) break
      chunkCount++
      const delta = part?.choices?.[0]?.delta?.content || ''
      if (delta) {
        fullText += delta
        onText(delta)
      }
    }
    console.log(`[LLM] stream ended after ${Date.now() - t0}ms, chunks=${chunkCount}, textLen=${fullText.length}`)
    return fullText
  } catch (err: any) {
    // P1: LLM fallback to OpenAI (implemented, not env-verified — sandbox 403)
    const msg = String(err?.message || err)
    const is429 = msg.includes('429') || msg.includes('Too many requests')
    if (is429 && isOpenAILLMConfigured()) {
      console.warn(`[LLM] z.ai 429, falling back to OpenAI: ${msg.slice(0, 100)}`)
      try {
        fullText = await streamLLMViaOpenAI(messages, onText, abortSignal)
        console.log(`[LLM] OpenAI fallback succeeded, textLen=${fullText.length}`)
        return fullText
      } catch (openaiErr: any) {
        console.error(`[LLM] OpenAI fallback also failed:`, String(openaiErr?.message || openaiErr).slice(0, 100))
      }
    }
    throw err
  }
}

// ====== TTS provider config ======
const TTS_PROVIDER = process.env.TTS_PROVIDER || 'auto'  // 'zai' | 'openai' | 'auto'

/**
 * Z.ai TTS（原本的 provider）
 */
async function textToSpeechZai(text: string): Promise<Buffer> {
  const zai = await getZAI()
  const cleanText = text.replace(/\[\[END\]\]/g, '').trim()
  if (!cleanText) return Buffer.alloc(0)

  const response = await zai.audio.tts.create({
    input: cleanText,
    voice: TTS_VOICE,
    speed: 1.0,
    response_format: 'wav',
    stream: false,
  })
  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(new Uint8Array(arrayBuffer))
}

interface TTSResult {
  buffer: Buffer
  provider: 'zai' | 'openai'
  fallbackUsed: boolean
  errorProvider?: 'zai' | 'openai'
  statusCode?: number
}

/**
 * 統一的 TTS 入口，根據 TTS_PROVIDER 決定用哪個 provider
 * - 'zai': 只用 Z.ai
 * - 'openai': 只用 OpenAI
 * - 'auto': 先 Z.ai，429 失敗 → fallback OpenAI，OpenAI 也失敗 → throw
 */
async function textToSpeechWav(text: string, sessionId: string): Promise<TTSResult> {
  const cleanText = text.replace(/\[\[END\]\]/g, '').trim()
  if (!cleanText) return { buffer: Buffer.alloc(0), provider: 'zai', fallbackUsed: false }

  // ====== P1: circuit breaker 檢查 ======
  const breakerStatus = TTSCircuitBreaker.check(sessionId)
  if (breakerStatus.mode === 'text_only') {
    // circuit open，不呼叫 TTS，直接回空 buffer（讓前端走字幕 fallback）
    console.warn(`[circuit-breaker] TTS skipped for ${sessionId.slice(0,8)}: ${breakerStatus.reason}`)
    return {
      buffer: Buffer.alloc(0),
      provider: 'zai',
      fallbackUsed: false,
      errorProvider: 'zai',
      statusCode: 429,
    }
  }

  const cleanText2 = cleanText  // 已經 trim 過

  // ====== TTS_PROVIDER=zai：只用 Z.ai ======
  if (TTS_PROVIDER === 'zai') {
    try {
      const buffer = await textToSpeechZai(cleanText2)
      TTSCircuitBreaker.recordSuccess(sessionId)
      return { buffer, provider: 'zai', fallbackUsed: false }
    } catch (err: any) {
      const msg = String(err?.message || err)
      const is429 = msg.includes('429') || msg.includes('Too many requests')
      if (is429) {
        TTSCircuitBreaker.record429(sessionId)
      }
      throw err
    }
  }

  // ====== TTS_PROVIDER=openai：只用 OpenAI ======
  if (TTS_PROVIDER === 'openai') {
    if (!isOpenAIConfigured()) {
      throw new Error('TTS_PROVIDER=openai but OPENAI_API_KEY not set')
    }
    const result = await textToSpeechOpenAI(cleanText2)
    TTSCircuitBreaker.recordSuccess(sessionId)
    return {
      buffer: result.buffer,
      provider: 'openai',
      fallbackUsed: false,
    }
  }

  // ====== TTS_PROVIDER=auto：先 Z.ai，429 → fallback OpenAI ======
  if (TTS_PROVIDER === 'auto') {
    // 先試 Z.ai
    try {
      const buffer = await textToSpeechZai(cleanText2)
      TTSCircuitBreaker.recordSuccess(sessionId)
      return { buffer, provider: 'zai', fallbackUsed: false }
    } catch (err: any) {
      const msg = String(err?.message || err)
      const is429 = msg.includes('429') || msg.includes('Too many requests')
      console.warn(`[TTS] Z.ai failed (${is429 ? '429' : 'other'}): ${msg.slice(0, 100)}`)

      if (is429) {
        TTSCircuitBreaker.record429(sessionId)
      }

      // Z.ai 429 → 試 OpenAI fallback
      if (is429 && isOpenAIConfigured()) {
        console.log('[TTS] falling back to OpenAI TTS')
        try {
          const result = await textToSpeechOpenAI(cleanText2)
          TTSCircuitBreaker.recordSuccess(sessionId)
          return {
            buffer: result.buffer,
            provider: 'openai',
            fallbackUsed: true,
            errorProvider: 'zai',
            statusCode: 429,
          }
        } catch (openaiErr: any) {
          console.error('[TTS] OpenAI fallback also failed:', String(openaiErr?.message || openaiErr).slice(0, 100))
          // 兩個都掛，throw 給上層走 text-only fallback
          throw openaiErr
        }
      }

      // 非 429 錯誤，直接 throw
      throw err
    }
  }

  throw new Error(`Unknown TTS_PROVIDER: ${TTS_PROVIDER}`)
}

/**
 * STT：base64 音訊 -> 文字 (via z.ai ASR)。
 * 失敗時指數 backoff 重試 3 次。
 */
async function speechToText(base64Audio: string, _mimeType: string = 'audio/webm'): Promise<string> {
  const zai = await getZAI()
  let lastErr: any = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await zai.audio.asr.create({
        file_base64: base64Audio,
      })
      return response.text || ''
    } catch (err: any) {
      lastErr = err
      const msg = String(err?.message || err)
      console.error(`[ASR error attempt ${attempt + 1}]`, msg.slice(0, 200))
      if (msg.includes('429') || msg.includes('Too many requests') || msg.includes('5')) {
        const backoff = Math.min(8000, 1500 * Math.pow(2, attempt))
        console.log(`[ASR retry] attempt=${attempt + 1} backoff=${backoff}ms`)
        await new Promise(r => setTimeout(r, backoff))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

/**
 * 簡易 semaphore：限制並行 TTS 數量，避免 429。
 */
class Semaphore {
  private permits: number
  private waiters: Array<() => void> = []
  constructor(permits: number) { this.permits = permits }
  async acquire(): Promise<void> {
    if (this.permits > 0) { this.permits--; return }
    await new Promise<void>(resolve => this.waiters.push(resolve))
    this.permits--
  }
  release() {
    this.permits++
    const w = this.waiters.shift()
    if (w) w()
  }
}

// P1-4: 降低 TTS 壓力（beta fragile window）
const ttsSemaphore = new Semaphore(1)  // 並行數從 2 降成 1
let lastTtsStartTime = 0
const MIN_TTS_INTERVAL_MS = 1500  // 從 300ms 提高到 1500ms

/**
 * 處理一輪 LLM 串流 + TTS 並行推送。
 * - 串流 LLM，累積成句子（splitIntoSentences）
 * - 每完整一句立刻「並行」起 TTS 任務（semaphore 限制並行）
 * - LLM 結束就觸發 onLLMDone，不等待 TTS（讓 turn_complete 盡快送出）
 * - TTS 在背景繼續推送 audio_chunk，玩家可以一邊聽一邊搶話
 */
async function streamNarration(
  socket: any,
  messages: Array<{ role: string; content: string }>,
  onFullText?: (text: string, isEnding: boolean, meta?: EndingMeta) => void,
  abortSignal?: AbortSignal,
  onLLMDone?: () => void,
  ids?: { sessionId: string; turnId: number; generationId: string; anonUserId?: string },
  onFirstTextChunk?: () => void,  // P0-0: fires when first text_chunk is emitted (for quota charge decision)
): Promise<{ fullText: string; isEnding: boolean; meta?: EndingMeta }> {
  const sessionId = ids?.sessionId || ''
  const turnId = ids?.turnId ?? 0
  const generationId = ids?.generationId || ''
  const anonUserId = ids?.anonUserId || ''

  let buffer = ''
  let fullText = ''
  let seq = 0
  let isEnding = false
  let endingMeta: EndingMeta | undefined
  let retryCount = 0

  // P0-ending-fix: once we see [[END]] or META: in fullText, enter metadata buffering mode
  // — stop emitting text_chunk / audio_chunk, just accumulate fullText for final parse
  let endingBlockStarted = false

  // 並行 TTS：每個 sentence 起一個 Promise，完成後 emit。
  const ttsPromises: Promise<void>[] = []

  // latency tracking
  const turnStart = Date.now()
  let llmFirstTokenMs = 0
  let ttsFirstAudioMs = 0

  const flushSentence = (sentence: string) => {
    const trimmed = sentence.trim()
    if (!trimmed) return

    // P0-ending-fix: if we've entered ending block, don't emit this sentence as text/TTS
    // (it's either META JSON or ending marker text — should not be shown or spoken)
    if (endingBlockStarted) {
      console.debug(`[ending-buffer] suppressing sentence in ending block: "${trimmed.slice(0, 40)}..."`)
      return
    }

    const { content, isEnding: ending, meta } = detectEnding(trimmed)
    if (ending) {
      isEnding = true
      if (meta) endingMeta = meta
    }

    const cleanSentence = content
    if (!cleanSentence) return

    // ====== 內容安全檢查 ======
    const safetyCheck = checkLLMOutput(cleanSentence)
    if (!safetyCheck.safe) {
      // 用 fallback 取代，記錄 reason
      console.warn(`[safety] LLM output blocked: ${safetyCheck.reason}, using fallback`)
      logUsage({
        session_id: sessionId,
        anon_user_id: anonUserId,
        turn_id: turnId,
        generation_id: generationId,
        event_type: 'safety_block',
        timestamp: new Date().toISOString(),
        error_code: safetyCheck.reason,
        extra: { original_text_preview: cleanSentence.slice(0, 80) },
      })
    }
    const finalSentence = safetyCheck.safe ? cleanSentence : (safetyCheck.fallback || '')

    const currentSeq = seq++
    // 同步 emit text chunk（讓前端即時顯示字幕）—— 帶完整 ID
    socket.emit('text_chunk', {
      sessionId,
      turnId,
      generationId,
      seq: currentSeq,
      text: finalSentence,
    })
    // P0-0: notify caller that at least one playable response was sent
    onFirstTextChunk?.()

    // 並行發起 TTS，但 semaphore 限制並行 + 節流
    const p = (async () => {
      if (abortSignal?.aborted) return
      await ttsSemaphore.acquire()
      try {
        // 節流：確保兩次 TTS 啟動至少間隔 MIN_TTS_INTERVAL_MS
        const now = Date.now()
        const wait = Math.max(0, lastTtsStartTime + MIN_TTS_INTERVAL_MS - now)
        if (wait > 0) await new Promise(r => setTimeout(r, wait))
        lastTtsStartTime = Date.now()

        if (abortSignal?.aborted) return
        const t0 = Date.now()
        const ttsResult = await textToSpeechWav(finalSentence, sessionId)
        if (abortSignal?.aborted) return

        // P1: 如果 circuit breaker 開了，emit tts_status 讓前端切字幕模式
        if (ttsResult.buffer.length === 0 && ttsResult.statusCode === 429) {
          const breakerStatus = TTSCircuitBreaker.check(sessionId)
          if (breakerStatus.mode === 'text_only') {
            socket.emit('tts_status', {
              sessionId, turnId, generationId,
              mode: 'text_only',
              reason: breakerStatus.reason || 'TTS_RATE_LIMIT',
              retryAfterMs: breakerStatus.retryAfterMs,
            })
            logUsage({
              session_id: sessionId,
              anon_user_id: anonUserId,
              turn_id: turnId,
              generation_id: generationId,
              event_type: 'tts_circuit_open',
              timestamp: new Date().toISOString(),
              extra: { reason: breakerStatus.reason, seq: currentSeq },
            })
          }
          return  // 不 emit audio_chunk，前端用字幕
        }

        if (ttsResult.buffer.length > 0) {
          socket.emit('audio_chunk', {
            sessionId,
            turnId,
            generationId,
            seq: currentSeq,
            audio: ttsResult.buffer.toString('base64'),
            format: 'wav',
          })
          if (!ttsFirstAudioMs) ttsFirstAudioMs = Date.now() - turnStart
          console.log(`[TTS] gen=${generationId.slice(0,8)} seq=${currentSeq} provider=${ttsResult.provider}${ttsResult.fallbackUsed ? '(fallback)' : ''} size=${ttsResult.buffer.length} time=${Date.now() - t0}ms`)
        }
      } catch (err: any) {
        retryCount++
        console.error('[TTS error]', err?.message || err)
        socket.emit('tts_error', {
          sessionId, turnId, generationId, seq: currentSeq,
          error: String(err?.message || err).slice(0, 200),
        })
        logUsage({
          session_id: sessionId,
          anon_user_id: anonUserId,
          turn_id: turnId,
          generation_id: generationId,
          event_type: 'tts_error',
          timestamp: new Date().toISOString(),
          retry_count: retryCount,
          error_code: String(err?.status || err?.code || 'TTS_FAIL'),
          extra: { seq: currentSeq, tts_provider: TTS_PROVIDER },
        })
      } finally {
        ttsSemaphore.release()
      }
    })()
    ttsPromises.push(p)
  }

  await streamLLM(
    messages,
    (delta) => {
      if (!llmFirstTokenMs) llmFirstTokenMs = Date.now() - turnStart
      buffer += delta
      fullText += delta

      // P0-ending-fix: check if we just entered the ending block ([[END]] or META:)
      // Once entered, stop flushing sentences as text/TTS — buffer everything for final parse
      if (!endingBlockStarted && isEnteringEndingBlock(fullText)) {
        endingBlockStarted = true
        console.log(`[ending-buffer] entering ending block, suppressing further text/TTS emit`)
        // Flush any pre-ending text that's still in buffer (劇情文字 before [[END]])
        const preEnding = extractPreEndingText(buffer)
        if (preEnding.trim()) {
          // Re-split the pre-ending part and flush those sentences
          const preSentences = splitIntoSentences(preEnding)
          for (const s of preSentences) {
            flushSentence(s)
          }
        }
        buffer = ''  // clear buffer, don't flush ending markers as text
        return
      }

      // If already in ending block, just accumulate fullText, don't flush
      if (endingBlockStarted) {
        return
      }

      // 嘗試切出完整句
      const sentences = splitIntoSentences(buffer)
      if (sentences.length > 1) {
        // 前面幾句是完整的，最後一句可能還沒結束
        for (let i = 0; i < sentences.length - 1; i++) {
          flushSentence(sentences[i])
        }
        buffer = sentences[sentences.length - 1]
      }
    },
    abortSignal,
  )

  // 收尾：剩下的 buffer 也送 TTS
  // P0-ending-fix: if in ending block, don't flush buffer (it's ending markers/META)
  if (!endingBlockStarted && buffer.trim()) {
    flushSentence(buffer)
  }

  // P0-ending-fix: if we entered ending block, parse the full text for ending/meta
  if (endingBlockStarted) {
    const { isEnding: detectedEnding, meta: detectedMeta } = detectEnding(fullText)
    if (detectedEnding) {
      isEnding = true
      endingMeta = detectedMeta || FALLBACK_ENDING_META
      console.log(`[ending-buffer] final parse: isEnding=true, meta title="${endingMeta?.title}"`)
    } else {
      // Saw [[END]] or META: but detectEnding didn't confirm? Use fallback.
      isEnding = true
      endingMeta = FALLBACK_ENDING_META
      console.warn(`[ending-buffer] ending block started but detectEnding didn't confirm, using fallback`)
    }
  }

  // LLM 結束，立刻通知（不等 TTS），讓前端可以早點切回 idle / 允許玩家搶話
  onLLMDone?.()

  // 記錄 latency
  logUsage({
    session_id: sessionId,
    anon_user_id: anonUserId,
    turn_id: turnId,
    generation_id: generationId,
    event_type: 'turn_llm_done',
    timestamp: new Date().toISOString(),
    llm_first_token_ms: llmFirstTokenMs,
    llm_total_ms: Date.now() - turnStart,
    tts_first_audio_ms: ttsFirstAudioMs,
    retry_count: retryCount,
  })

  // 把 TTS 完成的等待交給背景，回傳 LLM 結果
  // 不 await — 讓 TTS 在背景跑，audio_chunk 陸續推送
  Promise.all(ttsPromises).catch(err => {
    console.error('[TTS background error]', err)
  })

  onFullText?.(fullText, isEnding, endingMeta)
  return { fullText, isEnding, meta: endingMeta }
}

// ====== Socket handlers ======

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`)

  // 從 socket handshake 取 IP 並 hash 成 anon_user_id
  const rawIp = (socket.handshake as any)?.address || socket.id
  const anonUserId = UsageLogger.hashUserId(rawIp)

  // P0-3: parse founder token from handshake auth (not from query string — avoid URL logging)
  const founderToken = (socket.handshake as any)?.auth?.founderToken as string | undefined
  const userMode: UserMode = QuotaChecker.isFounderTokenValid(founderToken) ? 'founder' : 'public'

  games.set(socket.id, {
    messages: [{ role: 'assistant', content: SYSTEM_PROMPT }],
    turnCount: 0,
    ended: false,
    sessionId: socket.id,
    currentGenerationId: '',
    anonUserId,
    founderToken: userMode === 'founder' ? founderToken : undefined,
    userMode,
  })

  console.log(`[connect] ${socket.id} mode=${userMode}`)

  // 連線成功 → 送 sessionId + 額度狀態 + userMode (P0-3)
  const quotaStatus = QuotaChecker.getStatus(anonUserId, founderToken)
  socket.emit('connected', {
    sessionId: socket.id,
    anonUserId,
    quota: quotaStatus,
    userMode,
  })

  // 列出所有可用類別（給前端顯示用）
  socket.on('list_categories', () => {
    const categories = Object.entries(CATEGORY_NAMES).map(([key, val]) => ({
      key: key as SceneCategory,
      zh: val.zh,
      en: val.en,
      count: SCENE_TEMPLATES.filter(t => t.category === key).length,
    }))
    socket.emit('categories_list', { categories })
  })

  // 開始遊戲：生成開場白（可選 category，不傳就完全隨機）
  socket.on('start_game', async (payload?: { category?: string }) => {
    const game = games.get(socket.id)
    if (!game) return
    if (game.ended) {
      socket.emit('error_msg', { message: '遊戲已結束，請重新開始' })
      return
    }

    // ====== P0-2: server-side quota check (P0-3: pass founderToken) ======
    const quotaCheck = QuotaChecker.checkCanStart(game.anonUserId, game.founderToken)
    if (!quotaCheck.ok) {
      console.warn(`[quota] start_game blocked: ${quotaCheck.reason} mode=${game.userMode}`)
      socket.emit('error_msg', {
        message: quotaCheck.reason === 'BETA_DISABLED'
          ? 'Beta 暫時關閉維護中，稍後再來。'
          : '今日遊玩額度已達上限，明天再來吧。',
        code: quotaCheck.reason,
      })
      logUsage({
        session_id: socket.id,
        anon_user_id: game.anonUserId,
        turn_id: 0,
        generation_id: '',
        event_type: 'quota_blocked',
        timestamp: new Date().toISOString(),
        error_code: quotaCheck.reason,
        user_mode: game.userMode,
      })
      return
    }

    // ====== 記錄開局 + 抽 template (P0-3: pass founderToken) ======
    QuotaChecker.recordStart(game.anonUserId, game.founderToken)
    const category = payload?.category as SceneCategory | undefined
    const template = category ? pickTemplateByCategory(category) : pickRandomTemplate()
    game.template = template
    game.currentGenerationId = randomUUID()  // 新的 generation

    const turnId = 0  // 開場算 turn 0
    const generationId = game.currentGenerationId

    console.log(`[start_game] ${socket.id} template=${template.id} gen=${generationId.slice(0,8)} mode=${game.userMode}`)

    // 送 turn_start（帶 ID）
    socket.emit('turn_start', { sessionId: socket.id, turnId, generationId, turn: 0 })

    // 送 scene_template（帶 ID）
    socket.emit('scene_template', {
      sessionId: socket.id,
      turnId,
      generationId,
      id: template.id,
      category: template.category,
      categoryZh: CATEGORY_NAMES[template.category as SceneCategory]?.zh || template.category,
      categoryEn: CATEGORY_NAMES[template.category as SceneCategory]?.en || template.category,
    })

    // 記錄開局事件
    logUsage({
      session_id: socket.id,
      anon_user_id: game.anonUserId,
      turn_id: turnId,
      generation_id: generationId,
      event_type: 'game_start',
      timestamp: new Date().toISOString(),
      category: template.category,
      template_id: template.id,
      user_mode: game.userMode,
    })

    // P0-0: track whether any playable response (text_chunk) was sent to the user
    let playableResponseSent = false

    try {
      const trigger = templateToOpeningPrompt(template)
      const messagesForLLM = [
        ...game.messages,
        { role: 'user', content: trigger },
      ]

      const turnStart = Date.now()
      await streamNarration(
        socket,
        messagesForLLM,
        (text, ending) => {
          game.messages.push({ role: 'user', content: trigger })
          const cleanText = text.replace(/\[\[END\]\]/g, '').trim()
          game.messages.push({ role: 'assistant', content: cleanText })
          game.turnCount = 1
        },
        undefined,  // abortSignal
        undefined,  // onLLMDone
        { sessionId: socket.id, turnId, generationId, anonUserId: game.anonUserId },
        () => { playableResponseSent = true },  // P0-0: onFirstTextChunk
      )

      // 開場白永遠回傳 isEnding=false（帶 ID）
      socket.emit('turn_complete', {
        sessionId: socket.id,
        turnId,
        generationId,
        turn: game.turnCount,
        isEnding: false,
      })

      logUsage({
        session_id: socket.id,
        anon_user_id: game.anonUserId,
        turn_id: turnId,
        generation_id: generationId,
        event_type: 'turn_complete',
        timestamp: new Date().toISOString(),
        completed: true,
        extra: { turn_total_ms: Date.now() - turnStart },
        user_mode: game.userMode,
      })
    } catch (err: any) {
      console.error('[start_game error]', err?.message || err)

      // P0-0: refund quota if no playable response was sent (LLM/ASR failed before any text_chunk)
      let quotaRefunded = false
      if (!playableResponseSent) {
        QuotaChecker.refundStart(game.anonUserId, game.founderToken)
        quotaRefunded = true
        console.log(`[quota] refunded start_game for ${socket.id} mode=${game.userMode} (no playable response)`)
      }

      socket.emit('error_msg', {
        sessionId: socket.id, turnId, generationId,
        message: pickNarrativeError(),  // P0-1: narrative error copy
        code: 'START_GAME_FAIL',
      })
      logUsage({
        session_id: socket.id,
        anon_user_id: game.anonUserId,
        turn_id: turnId,
        generation_id: generationId,
        event_type: 'turn_error',
        timestamp: new Date().toISOString(),
        error_code: String(err?.code || err?.status || 'LLM_FAIL'),
        dropped: true,
        user_mode: game.userMode,
        quota_refunded: quotaRefunded,
      })
    }
  })

  // 提交錄音：base64 音訊
  socket.on('submit_audio', async (payload: { audio: string; format?: string }) => {
    const game = games.get(socket.id)
    if (!game) return
    if (game.ended) {
      socket.emit('error_msg', { message: '遊戲已結束，請重新開始' })
      return
    }

    if (!payload?.audio) {
      socket.emit('error_msg', { message: '沒有收到音訊' })
      return
    }

    // ====== P0-2: audio size check ======
    const audioBytes = Math.floor(payload.audio.length * 0.75)  // base64 → bytes 估計
    const sizeCheck = QuotaChecker.checkAudioSize(audioBytes)
    if (!sizeCheck.ok) {
      socket.emit('error_msg', {
        message: '錄音太長了，請控制在 60 秒內。',
        code: sizeCheck.reason,
      })
      return
    }

    // ====== 每次搶話都生成新 generationId（舊的 discard） ======
    const nextTurn = game.turnCount + 1
    const generationId = randomUUID()
    game.currentGenerationId = generationId  // 這行之後，舊 generation 的 emit 前端會 discard

    // P0-1: emit generation_start BEFORE ASR, so frontend updates its generationId ref
    // (prevents error_msg from being discarded when ASR fails — fixes "stuck in 理解中" race)
    socket.emit('generation_start', {
      sessionId: socket.id,
      turnId: nextTurn,
      generationId,
    })

    console.log(`[submit_audio] ${socket.id} gen=${generationId.slice(0,8)} bytes=${audioBytes} turn=${nextTurn} mode=${game.userMode}`)

    try {
      // 1. STT
      const t0 = Date.now()
      socket.emit('status', { sessionId: socket.id, turnId: nextTurn, generationId, stage: 'transcribing' })
      const mimeType = payload.format || 'audio/webm'
      const userText = await speechToText(payload.audio, mimeType)
      const asrLatency = Date.now() - t0
      console.log(`[STT] ${socket.id} gen=${generationId.slice(0,8)} time=${asrLatency}ms text="${userText}"`)

      if (!userText || !userText.trim()) {
        socket.emit('error_msg', {
          sessionId: socket.id, turnId: nextTurn, generationId,
          message: pickNarrativeError(),  // P0-1: narrative error copy
          code: 'ASR_EMPTY',
        })
        logUsage({
          session_id: socket.id,
          anon_user_id: game.anonUserId,
          turn_id: nextTurn,
          generation_id: generationId,
          event_type: 'asr_empty',
          timestamp: new Date().toISOString(),
          asr_latency_ms: asrLatency,
          audio_bytes_in: audioBytes,
          error_code: 'ASR_EMPTY',
          user_mode: game.userMode,
        })
        return
      }

      // ====== P0-4: 檢查使用者輸入安全性 ======
      const userSafety = checkUserInput(userText)
      if (!userSafety.safe) {
        console.warn(`[safety] user input blocked: ${userSafety.reason}`)
        // 不直接報錯，用 fallback 旁白帶過
        const fallbackText = userSafety.fallback || '你說了些什麼，但風把聲音吹散了。鏡頭突然切到另一個場景。'
        socket.emit('user_text', { sessionId: socket.id, turnId: nextTurn, generationId, text: '(系統：你的話被風吹散了)' })
        game.messages.push({ role: 'user', content: '(玩家試圖說了一些被系統攔截的話，已轉向)' })

        logUsage({
          session_id: socket.id,
          anon_user_id: game.anonUserId,
          turn_id: nextTurn,
          generation_id: generationId,
          event_type: 'safety_block_user',
          timestamp: new Date().toISOString(),
          error_code: userSafety.reason,
          user_mode: game.userMode,
        })

        // 直接用 fallback 旁白當作 LLM 回應
        socket.emit('turn_start', { sessionId: socket.id, turnId: nextTurn, generationId, turn: nextTurn })
        const seq = 0
        socket.emit('text_chunk', { sessionId: socket.id, turnId: nextTurn, generationId, seq, text: fallbackText })
        // P0-fix: textToSpeechWav requires (text, sessionId); returns TTSResult with .buffer
        const ttsResult = await textToSpeechWav(fallbackText, socket.id)
        if (ttsResult.buffer.length > 0) {
          socket.emit('audio_chunk', {
            sessionId: socket.id, turnId: nextTurn, generationId, seq,
            audio: ttsResult.buffer.toString('base64'),
            format: 'wav',
          })
        }
        game.messages.push({ role: 'assistant', content: fallbackText })
        game.turnCount = nextTurn
        socket.emit('turn_complete', { sessionId: socket.id, turnId: nextTurn, generationId, turn: nextTurn, isEnding: false })
        return
      }

      // 把使用者說的話送回前端顯示
      socket.emit('user_text', { sessionId: socket.id, turnId: nextTurn, generationId, text: userText })

      // 記錄 ASR 完成
      logUsage({
        session_id: socket.id,
        anon_user_id: game.anonUserId,
        turn_id: nextTurn,
        generation_id: generationId,
        event_type: 'asr_done',
        timestamp: new Date().toISOString(),
        asr_latency_ms: asrLatency,
        audio_bytes_in: audioBytes,
        user_mode: game.userMode,
      })

      // 2. 加入對話歷史
      game.messages.push({ role: 'user', content: userText })

      // 3. 提示 LLM 該收尾了
      if (nextTurn >= MAX_TURNS - 1 && nextTurn < MAX_TURNS) {
        game.messages.push({
          role: 'assistant',
          content: '（系統提示：這是最後一輪了，請給出一個明確的結局。結尾必須是 [[END]] 加上 META JSON，格式如：[[END]]\\nMETA:{"title":"劇名","endingType":"好結局/壞結局/懸念結局","verdict":"AI 判詞"}）',
        })
      } else if (nextTurn >= MAX_TURNS) {
        game.messages.push({
          role: 'assistant',
          content: '（系統提示：已達到 5 輪上限，必須立即結束故事，給出結局。結尾必須是 [[END]] 加上 META JSON，格式如：[[END]]\\nMETA:{"title":"劇名","endingType":"好結局/壞結局/懸念結局","verdict":"AI 判詞"}）',
        })
      }

      socket.emit('turn_start', { sessionId: socket.id, turnId: nextTurn, generationId, turn: nextTurn })

      // 4. 串流 LLM + TTS
      const allowEnding = nextTurn >= 4
      let detectedEnding = false
      let endingMeta: EndingMeta | undefined
      const turnStart = Date.now()
      const { isEnding } = await streamNarration(
        socket,
        game.messages,
        (text, ending, meta) => {
          const cleanText = allowEnding ? text : text.replace(/\[\[END\]\]/g, '').trim()
          game.messages.push({ role: 'assistant', content: cleanText })
          game.turnCount = nextTurn
          if (allowEnding && ending) {
            detectedEnding = true
            game.ended = true
            if (meta) endingMeta = meta
          }
        },
        undefined,
        undefined,
        { sessionId: socket.id, turnId: nextTurn, generationId, anonUserId: game.anonUserId },
      )

      const finalEnding = allowEnding ? (isEnding || detectedEnding) : false

      // P0-ending-fix: force ending on max turn even if LLM didn't output [[END]]
      // This prevents games from running past turn 5 without an ending card
      let forcedEndingMeta: EndingMeta | undefined
      let wasForcedEnding = false
      if (allowEnding && !finalEnding && nextTurn >= MAX_TURNS) {
        console.warn(`[ending-force] max turn ${nextTurn} reached without ending, forcing fallback`)
        wasForcedEnding = true
        forcedEndingMeta = FALLBACK_ENDING_META
        game.ended = true
      }

      const effectiveEnding = finalEnding || wasForcedEnding
      const effectiveMeta = endingMeta || forcedEndingMeta

      socket.emit('turn_complete', {
        sessionId: socket.id,
        turnId: nextTurn,
        generationId,
        turn: game.turnCount,
        isEnding: effectiveEnding,
      })

      logUsage({
        session_id: socket.id,
        anon_user_id: game.anonUserId,
        turn_id: nextTurn,
        generation_id: generationId,
        event_type: 'turn_complete',
        timestamp: new Date().toISOString(),
        completed: true,
        ending_type: effectiveEnding ? effectiveMeta?.endingType : undefined,
        extra: { turn_total_ms: Date.now() - turnStart, allow_ending: allowEnding, forced_ending: wasForcedEnding },
        user_mode: game.userMode,
      })

      if (effectiveEnding) {
        socket.emit('game_over', {
          sessionId: socket.id,
          turnId: nextTurn,
          generationId,
          ending: wasForcedEnding ? 'forced' : 'auto',
          meta: effectiveMeta,
        })
        logUsage({
          session_id: socket.id,
          anon_user_id: game.anonUserId,
          turn_id: nextTurn,
          generation_id: generationId,
          event_type: 'game_over',
          timestamp: new Date().toISOString(),
          completed: true,
          ending_type: effectiveMeta?.endingType,
          extra: effectiveMeta ? { title: effectiveMeta.title, verdict: effectiveMeta.verdict, forced: wasForcedEnding } : {},
          user_mode: game.userMode,
        })
      }
    } catch (err: any) {
      console.error('[submit_audio error]', err?.message || err)
      // P0-1: narrative error copy (was: '一陣雜訊干擾了你的訊號...')
      socket.emit('error_msg', {
        sessionId: socket.id, turnId: nextTurn, generationId,
        message: pickNarrativeError(),
        code: String(err?.code || err?.status || 'TURN_FAIL'),
      })
      logUsage({
        session_id: socket.id,
        anon_user_id: game.anonUserId,
        turn_id: nextTurn,
        generation_id: generationId,
        event_type: 'turn_error',
        timestamp: new Date().toISOString(),
        error_code: String(err?.code || err?.status || 'TURN_FAIL'),
        dropped: true,
        user_mode: game.userMode,
      })
    }
  })

  // ====== P0-3: 記錄分享 / 重玩事件 ======
  socket.on('share_clicked', (payload: { turnId?: number; generationId?: string }) => {
    const game = games.get(socket.id)
    if (!game) return
    logUsage({
      session_id: socket.id,
      anon_user_id: game.anonUserId,
      turn_id: payload.turnId || 0,
      generation_id: payload.generationId || '',
      event_type: 'share_clicked',
      timestamp: new Date().toISOString(),
      share_clicked: true,
      user_mode: game.userMode,
    })
  })

  socket.on('replay_clicked', (payload: { turnId?: number; generationId?: string }) => {
    const game = games.get(socket.id)
    if (!game) return
    logUsage({
      session_id: socket.id,
      anon_user_id: game.anonUserId,
      turn_id: payload.turnId || 0,
      generation_id: payload.generationId || '',
      event_type: 'replay_clicked',
      timestamp: new Date().toISOString(),
      replay_clicked: true,
      user_mode: game.userMode,
    })
  })

  // 重置遊戲
  socket.on('reset_game', () => {
    const oldGame = games.get(socket.id)
    const anonUserId = oldGame?.anonUserId || UsageLogger.hashUserId(socket.id)
    // P0-3: preserve founderToken and userMode across reset
    const founderToken = oldGame?.founderToken
    const userMode = oldGame?.userMode || 'public' as UserMode
    games.set(socket.id, {
      messages: [{ role: 'assistant', content: SYSTEM_PROMPT }],
      turnCount: 0,
      ended: false,
      sessionId: socket.id,
      currentGenerationId: '',
      anonUserId,
      founderToken,
      userMode,
    })
    socket.emit('reset_ok', { sessionId: socket.id })
    console.log(`[reset] ${socket.id} mode=${userMode}`)
  })

  socket.on('disconnect', () => {
    games.delete(socket.id)
    console.log(`[disconnect] ${socket.id}`)
  })

  socket.on('error', (err: any) => {
    console.error(`[socket error] ${socket.id}`, err)
  })
})

// ====== Start ======
httpServer.listen(PORT, () => {
  console.log(`🎤 Voice game service running on port ${PORT}`)
})

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0))
})
