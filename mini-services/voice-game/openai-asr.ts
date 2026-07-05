// OpenAI ASR (gpt-4o-transcribe / gpt-4o-mini-transcribe)
// 用於 ASR_PROVIDER=openai 或 auto fallback
// API key 只從 server env 讀取，不進 repo，不進 frontend，不進 log

import OpenAI from 'openai'

const apiKey = process.env.OPENAI_API_KEY
const asrModel = process.env.OPENAI_ASR_MODEL || 'gpt-4o-mini-transcribe'

let officialOpenAI: OpenAI | null = null

function getOfficialOpenAI(): OpenAI | null {
  if (!apiKey) {
    console.warn('[OpenAI ASR] OPENAI_API_KEY not set, ASR fallback unavailable')
    return null
  }
  if (!officialOpenAI) {
    officialOpenAI = new OpenAI({ apiKey })
  }
  return officialOpenAI
}

export function isOpenAIASRConfigured(): boolean {
  return !!apiKey
}

/**
 * 用 official OpenAI SDK 把 base64 音訊轉成文字
 * 失敗時 throw（由 caller 決定要不要再 fallback 或報錯）
 *
 * 注意：OpenAI transcription API 接受 file (Buffer/Stream)，不是 base64 字串
 * 我們把 base64 解碼成 Buffer 再傳
 */
export async function speechToTextOpenAI(base64Audio: string, mimeType: string = 'audio/webm'): Promise<string> {
  const client = getOfficialOpenAI()
  if (!client) {
    throw new Error('OPENAI_API_KEY not configured')
  }

  // base64 → Buffer
  const audioBuffer = Buffer.from(base64Audio, 'base64')

  // 根據 mimeType 決定副檔名
  const ext = mimeType.includes('webm') ? 'webm' :
              mimeType.includes('ogg') ? 'ogg' :
              mimeType.includes('mp4') ? 'mp4' :
              mimeType.includes('wav') ? 'wav' :
              'webm'

  // OpenAI SDK 的 file 參數接受 { name, type, data } 或 Buffer
  // 用 toFile helper 把 Buffer 包成 File-like object
  const file = await OpenAI.toFile(audioBuffer, `audio.${ext}`, { type: mimeType })

  const response = await client.audio.transcriptions.create({
    model: asrModel,
    file: file as any,
    // 不指定 language 讓 OpenAI 自動偵測（支援中文）
  })

  return response.text || ''
}
