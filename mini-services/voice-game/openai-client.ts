import OpenAI from 'openai'
import ZAI from 'z-ai-web-dev-sdk'
import fs from 'fs'
import path from 'path'

// 讀取 z.ai 的設定（從 /etc/.z-ai-config）
function loadZaiConfig() {
  const configPaths = [
    '/etc/.z-ai-config',
    path.join(process.cwd(), '.z-ai-config'),
    path.join(process.home || process.env.HOME || '/root', '.z-ai-config'),
  ]
  for (const p of configPaths) {
    try {
      const raw = fs.readFileSync(p, 'utf-8')
      const cfg = JSON.parse(raw)
      if (cfg.baseUrl && cfg.apiKey) return cfg
    } catch {}
  }
  return null
}

const zaiCfg = loadZaiConfig()

if (!zaiCfg) {
  console.error('[FATAL] Cannot find /etc/.z-ai-config')
  process.exit(1)
}

// 用 OpenAI SDK 走 z.ai 的 OpenAI-compatible gateway
// 這樣可以享受 OpenAI SDK 的好處（typed、retry、stream），但實際跑 GLM 模型
export const openai = new OpenAI({
  apiKey: zaiCfg.apiKey,
  baseURL: zaiCfg.baseUrl,
  defaultHeaders: {
    'X-Chat-Id': zaiCfg.chatId || '',
    'X-User-Id': zaiCfg.userId || '',
    'X-Token': zaiCfg.token || '',
    'X-Z-AI-From': 'Z',
  },
})

// ZAI 原生 instance（給 TTS / ASR 用，因為它們的 API 格式跟 OpenAI 不完全相容）
let zaiInstance: any = null
export async function getZAI() {
  if (!zaiInstance) {
    zaiInstance = await ZAI.create()
  }
  return zaiInstance
}

// 模型選擇
export const LLM_MODEL = process.env.LLM_MODEL || 'glm-4-plus'
export const TTS_VOICE = process.env.TTS_VOICE || 'tongtong'

console.log(`[Gateway] LLM=${LLM_MODEL} via ${zaiCfg.baseUrl}`)
console.log(`[Gateway] TTS voice=${TTS_VOICE}`)
