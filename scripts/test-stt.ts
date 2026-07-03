// 測試 STT：拿先前 TTS 產生的 wav 檔餵回去
import ZAI from 'z-ai-web-dev-sdk'
import fs from 'fs'

async function main() {
  const zai = await ZAI.create()
  const audio = fs.readFileSync('/tmp/test-tts.wav')
  const base64 = audio.toString('base64')
  console.log(`Audio size: ${audio.length} bytes, base64 length: ${base64.length}`)
  
  const t0 = Date.now()
  const response = await zai.audio.asr.create({ file_base64: base64 })
  console.log(`STT done in ${Date.now() - t0}ms`)
  console.log('Text:', response.text)
  console.log('Full response:', JSON.stringify(response, null, 2))
}

main().catch(err => {
  console.error('Failed:', err)
  process.exit(1)
})
