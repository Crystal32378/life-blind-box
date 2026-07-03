// 快速測試 LLM 串流和 SSE 解析
import ZAI from 'z-ai-web-dev-sdk'

async function* parseSSEStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data === '[DONE]') return
          yield data
        } else if (line.startsWith('{') || line.startsWith('[')) {
          yield line
        } else {
          yield line
        }
      }
    }
    if (buffer.trim()) {
      const line = buffer.trim()
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        if (data !== '[DONE]') yield data
      } else {
        yield line
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function extractDelta(data: string): string {
  try {
    const obj = JSON.parse(data)
    const delta = obj?.choices?.[0]?.delta?.content
    if (typeof delta === 'string') return delta
    return ''
  } catch {
    return data
  }
}

async function main() {
  const zai = await ZAI.create()
  console.log('Creating stream...')
  const t0 = Date.now()
  const stream: ReadableStream<Uint8Array> = await zai.chat.completions.create({
    messages: [
      { role: 'assistant', content: '你是一個有聲書旁白。用 60 字內描述一個神秘的開場。' },
      { role: 'user', content: '開始' },
    ],
    thinking: { type: 'disabled' },
    stream: true,
  })
  console.log(`Stream returned in ${Date.now() - t0}ms, type=${typeof stream}, isReadable=${stream instanceof ReadableStream}`)

  let firstChunkTime = 0
  let fullText = ''
  let chunkCount = 0
  for await (const data of parseSSEStream(stream)) {
    if (!firstChunkTime) firstChunkTime = Date.now() - t0
    const delta = extractDelta(data)
    if (delta) {
      fullText += delta
      chunkCount++
      process.stdout.write(delta)
    }
  }
  console.log('\n---')
  console.log(`First chunk: ${firstChunkTime}ms, total chunks: ${chunkCount}, total time: ${Date.now() - t0}ms`)
  console.log('Full text:', fullText)
}

main().catch(err => {
  console.error('Test failed:', err)
  process.exit(1)
})
