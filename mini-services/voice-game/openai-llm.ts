// OpenAI LLM fallback (official SDK, NOT via Z.ai gateway)
// P1: when z.ai LLM hits 429, fall back to OpenAI for narration generation
// Status: implemented, NOT environment-verified (sandbox 403 region blocked)
//
// API key only from server env (OPENAI_API_KEY), never in repo, frontend, or logs.

import OpenAI from 'openai'

const apiKey = process.env.OPENAI_API_KEY
const llmModel = process.env.OPENAI_LLM_MODEL || 'gpt-4o-mini'

let officialOpenAI: OpenAI | null = null

function getOfficialOpenAI(): OpenAI | null {
  if (!apiKey) {
    console.warn('[OpenAI LLM] OPENAI_API_KEY not set, LLM fallback unavailable')
    return null
  }
  if (!officialOpenAI) {
    officialOpenAI = new OpenAI({ apiKey })
  }
  return officialOpenAI
}

export function isOpenAILLMConfigured(): boolean {
  return !!apiKey
}

/**
 * Stream LLM via official OpenAI SDK.
 * Used as fallback when z.ai LLM hits 429.
 * Throws on failure (caller decides what to do).
 */
export async function streamLLMViaOpenAI(
  messages: Array<{ role: string; content: string }>,
  onText: (chunk: string) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  const client = getOfficialOpenAI()
  if (!client) {
    throw new Error('OPENAI_API_KEY not configured')
  }

  let fullText = ''
  const t0 = Date.now()
  console.log(`[LLM-OpenAI] starting stream, model=${llmModel}, messages=${messages.length}`)

  const stream = await client.chat.completions.create({
    model: llmModel,
    messages: messages as any,
    stream: true,
    temperature: 0.9,
  }, { signal: abortSignal })

  let chunkCount = 0
  for await (const part of stream) {
    if (abortSignal?.aborted) break
    chunkCount++
    const delta = part?.choices?.[0]?.delta?.content || ''
    if (delta) {
      fullText += delta
      onText(delta)
    }
  }
  console.log(`[LLM-OpenAI] stream ended after ${Date.now() - t0}ms, chunks=${chunkCount}, textLen=${fullText.length}`)

  return fullText
}
