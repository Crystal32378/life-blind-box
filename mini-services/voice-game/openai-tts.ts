// OpenAI TTS client (official SDK, NOT via Z.ai gateway)
// 用於 TTS_PROVIDER=auto 時的 fallback
// API key 只從 server env 讀取，不進 repo，不進 frontend

import OpenAI from 'openai'

const apiKey = process.env.OPENAI_API_KEY
const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts'
const voice = process.env.OPENAI_TTS_VOICE || 'coral'
const responseFormat = (process.env.OPENAI_TTS_RESPONSE_FORMAT || 'wav') as 'wav' | 'mp3' | 'pcm' | 'opus' | 'aac' | 'flac'

// 延遲初始化：只有真的要用時才建 client（避免沒設 key 時就崩）
let officialOpenAI: OpenAI | null = null

function getOfficialOpenAI(): OpenAI | null {
  if (!apiKey) {
    console.warn('[OpenAI TTS] OPENAI_API_KEY not set, fallback TTS unavailable')
    return null
  }
  if (!officialOpenAI) {
    officialOpenAI = new OpenAI({ apiKey })
  }
  return officialOpenAI
}

export interface OpenAITTSResult {
  buffer: Buffer
  provider: 'openai'
  model: string
  voice: string
}

/**
 * 用 official OpenAI SDK 把文字轉成 WAV Buffer
 * 失敗時 throw（由 caller 決定要不要再 fallback 到 text-only）
 */
export async function textToSpeechOpenAI(text: string): Promise<OpenAITTSResult> {
  const client = getOfficialOpenAI()
  if (!client) {
    throw new Error('OPENAI_API_KEY not configured')
  }

  const cleanText = text.replace(/\[\[END\]\]/g, '').trim()
  if (!cleanText) {
    return { buffer: Buffer.alloc(0), provider: 'openai', model, voice }
  }

  const response = await client.audio.speech.create({
    model,
    voice,
    input: cleanText,
    response_format: responseFormat,
  } as any)  // as any 因為 instructions 欄位只在 gpt-4o-mini-tts 支援

  const arrayBuffer = await response.arrayBuffer()
  return {
    buffer: Buffer.from(new Uint8Array(arrayBuffer)),
    provider: 'openai',
    model,
    voice,
  }
}

export function isOpenAIConfigured(): boolean {
  return !!apiKey
}
