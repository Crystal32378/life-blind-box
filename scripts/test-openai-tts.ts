// 測試 OpenAI TTS 能不能在這個 sandbox 呼叫
import OpenAI from 'openai'
import fs from 'fs'

// API key must come from the environment — no hard-coded fallback.
// (A fallback key is a live credential in git history.)
const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set. Export it before running this script.')
  process.exit(1)
}

const client = new OpenAI({ apiKey })

const testText = '你說一句話，另一個人生就開始呼吸。'

// 測 3 個 voice：onyx, fable, coral
const voices = ['onyx', 'fable', 'coral']

for (const voice of voices) {
  console.log(`\n=== Testing voice: ${voice} ===`)
  const t0 = Date.now()
  try {
    const response = await client.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: voice as any,
      input: testText,
      response_format: 'wav',
    })
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(new Uint8Array(arrayBuffer))
    const elapsed = Date.now() - t0
    console.log(`✓ Success: ${elapsed}ms, size=${buffer.length} bytes`)
    fs.writeFileSync(`/tmp/test-tts-${voice}.wav`, buffer)
    console.log(`  saved to /tmp/test-tts-${voice}.wav`)
  } catch (err: any) {
    const elapsed = Date.now() - t0
    console.error(`✗ Failed after ${elapsed}ms:`, err?.message || err)
    if (err?.status) console.error(`  status: ${err.status}`)
  }
}

console.log('\n=== Done ===')
