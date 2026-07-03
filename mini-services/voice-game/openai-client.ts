import OpenAI from 'openai'

// 從環境變數讀取 API key，永不寫死
const apiKey = process.env.OPENAI_API_KEY

if (!apiKey) {
  console.error('[FATAL] OPENAI_API_KEY environment variable is not set')
  console.error('Please create /home/z/my-project/.env.local with:')
  console.error('  OPENAI_API_KEY=sk-...')
  process.exit(1)
}

export const openai = new OpenAI({ apiKey })

// 模型選擇（可在 .env.local 覆寫）
export const LLM_MODEL = process.env.OPENAI_LLM_MODEL || 'gpt-4o-mini'
export const TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts'
export const TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy'
export const STT_MODEL = process.env.OPENAI_STT_MODEL || 'whisper-1'

console.log(`[OpenAI] LLM=${LLM_MODEL} TTS=${TTS_MODEL}(${TTS_VOICE}) STT=${STT_MODEL}`)
