import { createServer } from 'http'
import { Server } from 'socket.io'
import ZAI from 'z-ai-web-dev-sdk'
import { SYSTEM_PROMPT, splitIntoSentences, detectEnding, EndingMeta } from './prompt'

// ====== Types ======
interface GameState {
  messages: Array<{ role: string; content: string }>
  turnCount: number
  ended: boolean
  sessionId: string
}

interface PendingTTS {
  seq: number
  text: string
}

// ====== Globals ======
const PORT = 3003
const MAX_TURNS = 5
const games = new Map<string, GameState>() // socket.id -> game state

// Singleton ZAI instance
let zaiInstance: any = null
async function getZAI() {
  if (!zaiInstance) {
    zaiInstance = await ZAI.create()
  }
  return zaiInstance
}

// ====== HTTP + Socket.io server ======
const httpServer = createServer()
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
 * 串流呼叫 LLM。對每個 chunk 觸發 onText 回呼。回傳完整文字。
 */
async function streamLLM(
  messages: Array<{ role: string; content: string }>,
  onText: (chunk: string) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  const zai = await getZAI()
  let fullText = ''
  const t0 = Date.now()
  console.log(`[LLM] starting stream, messages=${messages.length}`)

  const stream: ReadableStream<Uint8Array> = await zai.chat.completions.create({
    messages,
    thinking: { type: 'disabled' },
    stream: true,
  })
  console.log(`[LLM] stream returned after ${Date.now() - t0}ms`)

  let chunkCount = 0
  for await (const data of parseSSEStream(stream, abortSignal)) {
    if (abortSignal?.aborted) break
    chunkCount++
    const delta = extractDelta(data)
    if (delta) {
      fullText += delta
      onText(delta)
    }
  }
  console.log(`[LLM] stream ended after ${Date.now() - t0}ms, chunks=${chunkCount}, textLen=${fullText.length}`)

  return fullText
}

/**
 * 把文字轉成 WAV Buffer。失敗時指數 backoff 重試 2 次。
 * 若全部失敗就丟出錯誤，由呼叫端決定是否跳過。
 */
async function textToSpeechWav(text: string): Promise<Buffer> {
  const zai = await getZAI()
  const cleanText = text.replace(/\[\[END\]\]/g, '').trim()
  if (!cleanText) return Buffer.alloc(0)

  let lastErr: any = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await zai.audio.tts.create({
        input: cleanText,
        voice: 'tongtong',
        speed: 1.0,
        response_format: 'wav',
        stream: false,
      })
      const arrayBuffer = await response.arrayBuffer()
      return Buffer.from(new Uint8Array(arrayBuffer))
    } catch (err: any) {
      lastErr = err
      const msg = String(err?.message || err)
      // 429 / 5xx 才重試
      if (msg.includes('429') || msg.includes('Too many requests') || msg.includes('5')) {
        const backoff = 1500 * Math.pow(2, attempt) // 1.5s, 3s, 6s
        console.log(`[TTS retry] attempt=${attempt + 1} backoff=${backoff}ms`)
        await new Promise(r => setTimeout(r, backoff))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

/**
 * STT：base64 音訊 -> 文字。失敗時指數 backoff 重試 3 次。
 */
async function speechToText(base64Audio: string): Promise<string> {
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

const ttsSemaphore = new Semaphore(1)
let lastTtsStartTime = 0
const MIN_TTS_INTERVAL_MS = 1200 // 兩次 TTS 啟動之間至少間隔 1200ms，避免 429

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
): Promise<{ fullText: string; isEnding: boolean; meta?: EndingMeta }> {
  let buffer = ''
  let fullText = ''
  let seq = 0
  let isEnding = false
  let endingMeta: EndingMeta | undefined

  // 並行 TTS：每個 sentence 起一個 Promise，完成後 emit。
  const ttsPromises: Promise<void>[] = []

  const flushSentence = (sentence: string) => {
    const trimmed = sentence.trim()
    if (!trimmed) return

    const { content, isEnding: ending, meta } = detectEnding(trimmed)
    if (ending) {
      isEnding = true
      if (meta) endingMeta = meta
    }

    const cleanSentence = content
    if (!cleanSentence) return

    const currentSeq = seq++
    // 同步 emit text chunk（讓前端即時顯示字幕）
    socket.emit('text_chunk', { seq: currentSeq, text: cleanSentence })

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
        const wavBuffer = await textToSpeechWav(cleanSentence)
        if (abortSignal?.aborted) return
        if (wavBuffer.length > 0) {
          socket.emit('audio_chunk', {
            seq: currentSeq,
            audio: wavBuffer.toString('base64'),
            format: 'wav',
          })
          console.log(`[TTS] seq=${currentSeq} size=${wavBuffer.length} time=${Date.now() - t0}ms`)
        }
      } catch (err) {
        console.error('[TTS error]', err)
        socket.emit('tts_error', { seq: currentSeq, error: String(err) })
      } finally {
        ttsSemaphore.release()
      }
    })()
    ttsPromises.push(p)
  }

  await streamLLM(
    messages,
    (delta) => {
      buffer += delta
      fullText += delta
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
  if (buffer.trim()) {
    flushSentence(buffer)
  }

  // LLM 結束，立刻通知（不等 TTS），讓前端可以早點切回 idle / 允許玩家搶話
  onLLMDone?.()

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
  games.set(socket.id, {
    messages: [{ role: 'assistant', content: SYSTEM_PROMPT }],
    turnCount: 0,
    ended: false,
    sessionId: socket.id,
  })

  socket.emit('connected', { sessionId: socket.id })

  // 開始遊戲：生成開場白
  socket.on('start_game', async () => {
    const game = games.get(socket.id)
    if (!game) return
    if (game.ended) {
      socket.emit('error_msg', { message: '遊戲已結束，請重新開始' })
      return
    }

    console.log(`[start_game] ${socket.id}`)
    socket.emit('turn_start', { turn: 0 })

    try {
      // 加入一個 user message 觸發 LLM 開始（GLM API 要求至少一個 user message）
      const trigger = '請隨機生成一個開場白，直接開始遊戲。記得：開場白絕對不要使用 [[END]] 標記。'
      const messagesForLLM = [
        ...game.messages,
        { role: 'user', content: trigger },
      ]

      const { fullText, isEnding } = await streamNarration(
        socket,
        messagesForLLM,
        (text, ending) => {
          game.messages.push({ role: 'user', content: trigger })
          // 開場白強制不結束（即使 LLM 誤加 [[END]]）
          const cleanText = text.replace(/\[\[END\]\]/g, '').trim()
          game.messages.push({ role: 'assistant', content: cleanText })
          game.turnCount = 1
          // 開場白永遠不結束遊戲
        },
      )

      // 開場白永遠回傳 isEnding=false
      socket.emit('turn_complete', {
        turn: game.turnCount,
        isEnding: false,
      })
    } catch (err) {
      console.error('[start_game error]', err)
      socket.emit('error_msg', { message: '開場生成失敗，請重試' })
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

    console.log(`[submit_audio] ${socket.id} size=${payload.audio.length}`)

    try {
      // 1. STT
      const t0 = Date.now()
      socket.emit('status', { stage: 'transcribing' })
      const userText = await speechToText(payload.audio)
      console.log(`[STT] ${socket.id} time=${Date.now() - t0}ms text="${userText}"`)

      if (!userText || !userText.trim()) {
        socket.emit('error_msg', { message: '聽不清楚，請再說一次' })
        return
      }

      // 把使用者說的話送回前端顯示
      socket.emit('user_text', { text: userText })

      // 2. 加入對話歷史
      game.messages.push({ role: 'user', content: userText })
      const nextTurn = game.turnCount + 1

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

      socket.emit('turn_start', { turn: nextTurn })

      // 4. 串流 LLM + TTS
      // 強制：前 3 輪（nextTurn <= 3）不允許 [[END]]，避免太早結束
      const allowEnding = nextTurn >= 4
      let detectedEnding = false
      let endingMeta: EndingMeta | undefined
      const { isEnding } = await streamNarration(
        socket,
        game.messages,
        (text, ending, meta) => {
          // 前 3 輪：強制移除 [[END]]
          const cleanText = allowEnding ? text : text.replace(/\[\[END\]\]/g, '').trim()
          game.messages.push({ role: 'assistant', content: cleanText })
          game.turnCount = nextTurn
          if (allowEnding && ending) {
            detectedEnding = true
            game.ended = true
            if (meta) endingMeta = meta
          }
        },
      )

      const finalEnding = allowEnding ? (isEnding || detectedEnding) : false

      socket.emit('turn_complete', {
        turn: game.turnCount,
        isEnding: finalEnding,
      })

      if (finalEnding) {
        socket.emit('game_over', {
          ending: 'auto',
          meta: endingMeta,
        })
      }
    } catch (err) {
      console.error('[submit_audio error]', err)
      socket.emit('error_msg', { message: '處理失敗：' + String(err) })
    }
  })

  // 重置遊戲
  socket.on('reset_game', () => {
    games.set(socket.id, {
      messages: [{ role: 'assistant', content: SYSTEM_PROMPT }],
      turnCount: 0,
      ended: false,
      sessionId: socket.id,
    })
    socket.emit('reset_ok', {})
    console.log(`[reset] ${socket.id}`)
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
