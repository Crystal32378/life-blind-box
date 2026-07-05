// Setup script: read z.ai config from env vars, write to cwd/.z-ai-config
// This is needed because z-ai-web-dev-sdk only reads from file, not env.
//
// On sandbox: .z-ai-config exists at /etc/.z-ai-config (pre-installed)
// On Railway/Render: no .z-ai-config file, so we write one from env vars
//
// Run this before starting the server:
//   bun setup-config.ts && bun index.ts
//
// Env vars needed (only if using z.ai providers):
//   ZAI_API_KEY (required)
//   ZAI_BASE_URL (default: https://internal-api.z.ai/v1)
//   ZAI_CHAT_ID (optional)
//   ZAI_USER_ID (optional)
//   ZAI_TOKEN (optional)

import fs from 'fs'
import path from 'path'

const config: any = {
  baseUrl: process.env.ZAI_BASE_URL || 'https://internal-api.z.ai/v1',
  apiKey: process.env.ZAI_API_KEY || '',
  chatId: process.env.ZAI_CHAT_ID || '',
  userId: process.env.ZAI_USER_ID || '',
  token: process.env.ZAI_TOKEN || '',
}

// If no ZAI_API_KEY, check if /etc/.z-ai-config exists (sandbox)
if (!config.apiKey) {
  try {
    const sandboxConfig = fs.readFileSync('/etc/.z-ai-config', 'utf-8')
    const parsed = JSON.parse(sandboxConfig)
    if (parsed.apiKey && parsed.baseUrl) {
      console.log('[setup-config] using /etc/.z-ai-config (sandbox)')
      process.exit(0)  // sandbox already has config, nothing to do
    }
  } catch {
    // no sandbox config
  }
  console.warn('[setup-config] ZAI_API_KEY not set and no /etc/.z-ai-config found')
  console.warn('[setup-config] z.ai providers will fail. Set LLM_PROVIDER/TTS_PROVIDER/ASR_PROVIDER to openai.')
  process.exit(0)  // don't crash — let server start, it will fail gracefully on first z.ai call
}

const configPath = path.join(process.cwd(), '.z-ai-config')
fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
console.log(`[setup-config] wrote ${configPath} (baseUrl=${config.baseUrl})`)
