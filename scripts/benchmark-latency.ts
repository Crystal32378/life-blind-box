#!/usr/bin/env bun
// P0-5: latency benchmark
// 跑 N 局（只測開場，不測互動），輸出 p50 / p95 各項 latency
//
// 用法：
//   bun run scripts/benchmark-latency.ts [局數]
//   預設跑 20 局
//
// 量測指標：
//   - start_game → first text_chunk
//   - start_game → first audio_chunk
//   - start_game → turn_complete
//   - ending meta parse success rate（只測開場，這項不適用，但保留欄位）

import { io } from 'socket.io-client'

const NUM_GAMES = parseInt(process.argv[2] || '20', 10)
const SERVER_URL = 'http://localhost:3003/'

interface GameLatency {
  gameIndex: number
  startToFirstText: number | null
  startToFirstAudio: number | null
  startToTurnComplete: number | null
  textChunks: number
  audioChunks: number
  error?: string
}

async function runOneGame(index: number): Promise<GameLatency> {
  return new Promise((resolve) => {
    const socket = io(SERVER_URL, {
      transports: ['websocket'],
      forceNew: true,
      timeout: 30000,
    })

    const result: GameLatency = {
      gameIndex: index,
      startToFirstText: null,
      startToFirstAudio: null,
      startToTurnComplete: null,
      textChunks: 0,
      audioChunks: 0,
    }

    let startTime = 0
    let resolved = false

    const finish = (err?: string) => {
      if (resolved) return
      resolved = true
      if (err) result.error = err
      socket.disconnect()
      resolve(result)
    }

    socket.on('connect', () => {
      startTime = Date.now()
      socket.emit('start_game', {})
    })

    socket.on('text_chunk', () => {
      if (result.startToFirstText === null) {
        result.startToFirstText = Date.now() - startTime
      }
      result.textChunks++
    })

    socket.on('audio_chunk', () => {
      if (result.startToFirstAudio === null) {
        result.startToFirstAudio = Date.now() - startTime
      }
      result.audioChunks++
    })

    socket.on('turn_complete', () => {
      result.startToTurnComplete = Date.now() - startTime
      finish()
    })

    socket.on('error_msg', (data: any) => {
      finish(`error_msg: ${data.message}`)
    })

    socket.on('connect_error', () => {
      finish('connect_error')
    })

    // timeout: 60s
    setTimeout(() => finish('timeout'), 60000)
  })
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))]
}

function stats(values: Array<number | null>): { p50: number; p95: number; count: number; fails: number } {
  const valid = values.filter((v): v is number => v !== null && v > 0).sort((a, b) => a - b)
  return {
    p50: percentile(valid, 50),
    p95: percentile(valid, 95),
    count: valid.length,
    fails: values.length - valid.length,
  }
}

async function main() {
  console.log(`\n=== Latency Benchmark: ${NUM_GAMES} games ===\n`)

  const results: GameLatency[] = []
  for (let i = 0; i < NUM_GAMES; i++) {
    process.stdout.write(`Game ${i + 1}/${NUM_GAMES}...`)
    const r = await runOneGame(i)
    results.push(r)
    if (r.error) {
      console.log(` ❌ ${r.error}`)
    } else {
      console.log(` ✓ text=${r.startToFirstText}ms audio=${r.startToFirstAudio}ms complete=${r.startToTurnComplete}ms`)
    }
    // 間隔 1 秒避免撞限流
    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  // 計算統計
  const firstTextStats = stats(results.map(r => r.startToFirstText))
  const firstAudioStats = stats(results.map(r => r.startToFirstAudio))
  const turnCompleteStats = stats(results.map(r => r.startToTurnComplete))

  console.log(`\n=== Results ===\n`)
  console.log(`start_game → first text_chunk:`)
  console.log(`  p50: ${firstTextStats.p50}ms, p95: ${firstTextStats.p95}ms (${firstTextStats.count}/${NUM_GAMES} ok, ${firstTextStats.fails} failed)`)
  console.log(`\nstart_game → first audio_chunk:`)
  console.log(`  p50: ${firstAudioStats.p50}ms, p95: ${firstAudioStats.p95}ms (${firstAudioStats.count}/${NUM_GAMES} ok, ${firstAudioStats.fails} failed)`)
  console.log(`\nstart_game → turn_complete:`)
  console.log(`  p50: ${turnCompleteStats.p50}ms, p95: ${turnCompleteStats.p95}ms (${turnCompleteStats.count}/${NUM_GAMES} ok, ${turnCompleteStats.fails} failed)`)

  const errors = results.filter(r => r.error)
  if (errors.length > 0) {
    console.log(`\n=== Errors (${errors.length}) ===`)
    errors.forEach(r => console.log(`  Game ${r.gameIndex + 1}: ${r.error}`))
  }

  // 平均 chunk 數
  const avgTextChunks = results.reduce((sum, r) => sum + r.textChunks, 0) / NUM_GAMES
  const avgAudioChunks = results.reduce((sum, r) => sum + r.audioChunks, 0) / NUM_GAMES
  console.log(`\n=== Chunk counts ===`)
  console.log(`  avg text chunks per game: ${avgTextChunks.toFixed(1)}`)
  console.log(`  avg audio chunks per game: ${avgAudioChunks.toFixed(1)}`)

  // 輸出 JSON summary 給大G 看
  const summary = {
    timestamp: new Date().toISOString(),
    numGames: NUM_GAMES,
    firstText: firstTextStats,
    firstAudio: firstAudioStats,
    turnComplete: turnCompleteStats,
    avgTextChunks,
    avgAudioChunks,
    errors: errors.map(r => ({ game: r.gameIndex + 1, error: r.error })),
  }
  console.log(`\n=== JSON summary ===`)
  console.log(JSON.stringify(summary, null, 2))

  process.exit(0)
}

main().catch(err => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
