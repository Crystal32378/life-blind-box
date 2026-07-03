// 端對端測試：模擬客戶端送音訊給 voice-game 服務
import { io } from 'socket.io-client'
import fs from 'fs'

function connect() {
  return io('http://localhost:3003/', {
    transports: ['websocket'],
    forceNew: true,
  })
}

async function main() {
  const socket = connect()
  const audioFile = '/tmp/test-tts.wav' // 「月光下，古鐘突然自鳴。」
  const audio = fs.readFileSync(audioFile)
  const base64 = audio.toString('base64')

  await new Promise<void>((resolve) => socket.on('connect', resolve))
  console.log('✓ connected')

  // 收集事件
  const textChunks: any[] = []
  const audioChunks: any[] = []
  socket.on('text_chunk', (d) => { console.log('[text]', d); textChunks.push(d) })
  socket.on('audio_chunk', (d) => { console.log(`[audio] seq=${d.seq} size=${d.audio.length}`); audioChunks.push(d) })
  socket.on('user_text', (d) => console.log('[user_text]', d))
  socket.on('turn_start', (d) => console.log('[turn_start]', d))
  socket.on('turn_complete', (d) => console.log('[turn_complete]', d))
  socket.on('status', (d) => console.log('[status]', d))
  socket.on('error_msg', (d) => console.log('[error_msg]', d))
  socket.on('game_over', (d) => console.log('[game_over]', d))

  // 1. start_game
  console.log('\n=== START GAME ===')
  socket.emit('start_game')
  await new Promise<void>((resolve) => {
    socket.once('turn_complete', () => resolve())
  })

  console.log(`\n=== After start: text chunks=${textChunks.length}, audio chunks=${audioChunks.length} ===\n`)

  // 2. submit audio
  console.log('=== SUBMIT AUDIO ===')
  socket.emit('submit_audio', { audio: base64, format: 'audio/wav' })

  await new Promise<void>((resolve) => {
    socket.once('turn_complete', () => resolve())
  })

  console.log(`\n=== Final: text chunks=${textChunks.length}, audio chunks=${audioChunks.length} ===`)
  console.log('\n--- Full narration ---')
  console.log(textChunks.map(t => t.text).join(''))

  socket.disconnect()
  process.exit(0)
}

main().catch(err => {
  console.error('Failed:', err)
  process.exit(1)
})
