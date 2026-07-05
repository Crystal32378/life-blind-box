import OpenAI from 'openai'
import ZAI from 'z-ai-web-dev-sdk'
import fs from 'fs'
import path from 'path'

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
  console.warn('[Gateway] No .z-ai-config found. z.ai providers will fail.')
  console.warn('[Gateway] Set LLM_PROVIDER=openai, ASR_PROVIDER=openai, TTS_PROVIDER=openai to use OpenAI only.')
}

export const openai = new OpenAI({
  apiKey: zaiCfg?.apiKey || 'placeholder',
  baseURL: zaiCfg?.baseUrl || 'https://placeholder.invalid',
  defaultHeaders: {
    'X-Chat-Id': zaiCfg?.chatId || '',
    'X-User-Id': zaiCfg?.userId || '',
    'X-Token': zaiCfg?.token || '',
    'X-Z-AI-From': 'Z',
  },
})

let zaiInstance: any = null
export async function getZAI(): Promise<any> {
  if (!zaiCfg) {
    throw new Error('z.ai not configured (no .z-ai-config). Use OpenAI providers instead.')
  }
  if (!zaiInstance) {
    zaiInstance = await ZAI.create()
  }
  return zaiInstance
}

export const LLM_MODEL = process.env.LLM_MODEL || 'glm-4-plus'
export const TTS_VOICE = process.env.TTS_VOICE || 'tongtong'

if (zaiCfg) {
  console.log(`[Gateway] LLM=${LLM_MODEL} via ${zaiCfg.baseUrl}`)
}
console.log(`[Gateway] TTS voice=${TTS_VOICE}`)
