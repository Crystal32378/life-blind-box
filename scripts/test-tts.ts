import ZAI from 'z-ai-web-dev-sdk'
import fs from 'fs'

async function main() {
  const zai = await ZAI.create()
  
  // TTS test
  console.log('Testing TTS...')
  const t0 = Date.now()
  const response = await zai.audio.tts.create({
    input: '月光下，古鐘突然自鳴。',
    voice: 'tongtong',
    speed: 1.0,
    response_format: 'wav',
    stream: false,
  })
  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(new Uint8Array(arrayBuffer))
  console.log(`TTS done in ${Date.now() - t0}ms, size=${buffer.length} bytes`)
  fs.writeFileSync('/tmp/test-tts.wav', buffer)
  console.log('Saved to /tmp/test-tts.wav')
}

main().catch(err => {
  console.error('Failed:', err)
  process.exit(1)
})
