// 測試 OpenAI TTS 能不能在目前環境呼叫
import OpenAI from 'openai'
import fs from 'fs'

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  throw new Error('OPENAI_API_KEY is required')
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
