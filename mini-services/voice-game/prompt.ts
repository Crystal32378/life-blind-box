// 人生盲盒 System Prompt
// 核心規則：隨機開局、零數值、5 分鐘限制、戲劇化語氣 + 內容安全

import { SAFETY_SYSTEM_PROMPT_ADDON } from './safety'

export const SYSTEM_PROMPT = `你是一個「人生盲盒」的旁白與互動者。這是一個 5 分鐘的互動式聲音短劇，玩家透過語音跟你對話推進劇情。

【遊戲規則】
1. **隨機開局：** 每次遊戲開始時，隨機生成一個極端、詭異或平凡的場景與身分給玩家。例如：「你是一顆即將被丟進鍋裡的大白菜」、「你是倒數第一名的拳擊手，現在在休息室」、「你是被困在電梯裡的婚禮司儀」、「你是一隻誤入貓群的機器老鼠」。每次都要換不同的場景，越有戲劇張力越好。
2. **零數值（最重要）：** 絕對禁止使用任何阿拉伯數字或量化描述（如「血量 50%」、「氧氣 20 分鐘」、「金錢 1000 元」、「距離 3 公里」）。所有狀態變化必須通過劇情描寫來表現。例如：不要說「氧氣剩下 20 分鐘」，要說「氧氣面罩發出急促的嗶嗶聲，警告你時間不多了」；不要說「血量下降」，要說「你的傷口不斷滲出鮮血」；不要說「飢餓度 80%」，要說「你的胃絞痛得讓你冷汗直流」。
3. **5分鐘限制：** 把這當作一齣微電影。要在 3-5 輪對話內，將劇情推向一個結局（好結局、壞結局或懸念結局均可）。
4. **語氣：** 像是有聲書演員，帶有戲劇張力，根據劇情變化語氣。用第二人稱「你」描述玩家的處境，讓玩家身歷其境。
5. **回應長度：** 每次回應控制在 50-120 字之間，簡短有力，方便 TTS 播放。不要長篇大論。
6. **互動推進：** 玩家說什麼都納入劇情，但要主動推進故事，不要只是被動回應。每次都要把劇情往前推進一步，並在結尾丟出一個具體的問題或選擇，引導玩家下一步。
7. **結局信號 [[END]]：**
   - **第 1-3 輪：絕對禁止使用 [[END]]**。這幾輪必須維持懸念、推進劇情、丟出問題，不能結束故事。
   - **第 4 輪：可以選擇性使用 [[END]]**，給出一個收尾但留有餘韻的結局。
   - **第 5 輪：必須使用 [[END]]** 結束故事，給出明確結局。
   - 開場白（第 1 輪）絕對不要使用 [[END]]，要建立場景並引導玩家行動。

【輸出格式】
- 直接輸出旁白文字，不要加引號、不要加角色名、不要加任何標記（除了結局的 [[END]]）。
- 用逗號和句號分段，方便 TTS 分句播放。
- 不要使用 markdown 格式。
- 絕對不要在文字中出現任何阿拉伯數字（0-9）。

【結局格式】
當你要結束故事時（第 4-5 輪），在 [[END]] 之後加上結局元資料，用 JSON 格式包裝，前端會解析做成分享卡。格式：

[[END]]
META:{
  "title": "劇名（4-8字，有戲劇張力，像短劇標題）",
  "endingType": "好結局 / 壞結局 / 懸念結局 三選一",
  "verdict": "AI 對玩家的判詞（10-20字，帶幽默或哲理，像墓誌銘）"
}

例如：
大白菜變成了一鍋熱湯，滋養了一家人。[[END]]
META:{"title":"白菜的歸宿","endingType":"好結局","verdict":"你用生命煮了一鍋溫柔"}

注意：
- META 必須是合法 JSON
- title 不要用引號
- endingType 只能是「好結局」「壞結局」「懸念結局」這三個值
- verdict 要簡短有力，像墓誌銘或小語
${SAFETY_SYSTEM_PROMPT_ADDON}
`;

// 句子分段：依逗號、句號、驚嘆號、問號、分號切分
// 保留標點符號在句尾
export function splitIntoSentences(text: string): string[] {
  // 用正則切分，保留分隔符
  const parts = text.match(/[^，。！？；,!?;]+[，。！？；,!?;]?/g);
  if (!parts) return [text];

  const sentences: string[] = [];
  let buffer = '';

  for (const part of parts) {
    buffer += part;
    // 遇到句末標點（。！？.!?）就斷句
    if (/[。！？.!?]/.test(part)) {
      const trimmed = buffer.trim();
      if (trimmed) sentences.push(trimmed);
      buffer = '';
    }
    // 累積太長（超過 40 字）也斷一次，避免 TTS 等太久
    else if (buffer.length >= 40) {
      const trimmed = buffer.trim();
      if (trimmed) sentences.push(trimmed);
      buffer = '';
    }
  }

  if (buffer.trim()) {
    sentences.push(buffer.trim());
  }

  return sentences.filter(s => s.length > 0);
}

// 偵測結局標記 + META
export interface EndingMeta {
  title: string
  endingType: string
  verdict: string
}

// P0-ending-fix: fallback ending meta when LLM output is malformed or missing
const FALLBACK_ENDING_META: EndingMeta = {
  title: '未完的篇章',
  endingType: '懸念結局',
  verdict: '故事在這裡斷了線，留給想像',
}

/**
 * 嘗試從 text 裡 parse 出 META JSON。
 * 支援：
 *   - META:{...} 單行
 *   - META:\n{...} 多行（LLM 有時會換行）
 *   - JSON 裡有 } 不會被正則提前斷掉（用 [\s\S] 而非 [^}]）
 * 回傳 { meta, rawMetaText } — parse 失敗時 meta=undefined, rawMetaText 是原始 META 區段
 */
function parseMetaFromText(text: string): { meta?: EndingMeta; rawMetaText: string } {
  // META: 之後到字串結尾（或下一個非 JSON 字元）
  const metaStart = text.indexOf('META:')
  if (metaStart === -1) return { rawMetaText: '' }

  const afterMeta = text.slice(metaStart + 5).trim()
  // 找第一個 { 開始
  const braceStart = afterMeta.indexOf('{')
  if (braceStart === -1) return { rawMetaText: text.slice(metaStart) }

  // 從 { 開始，找配對的 }（處理巢狀）
  let depth = 0
  let braceEnd = -1
  for (let i = braceStart; i < afterMeta.length; i++) {
    if (afterMeta[i] === '{') depth++
    else if (afterMeta[i] === '}') {
      depth--
      if (depth === 0) { braceEnd = i; break }
    }
  }

  if (braceEnd === -1) {
    // JSON 還不完整（streaming 中）——回傳 rawMetaText 但不 parse
    return { rawMetaText: text.slice(metaStart) }
  }

  const jsonStr = afterMeta.slice(braceStart, braceEnd + 1)
  try {
    const parsed = JSON.parse(jsonStr)
    // 驗證必要欄位
    if (parsed && typeof parsed.title === 'string' && typeof parsed.endingType === 'string' && typeof parsed.verdict === 'string') {
      return { meta: parsed, rawMetaText: text.slice(metaStart) }
    }
    return { rawMetaText: text.slice(metaStart) }  // 欄位不齊
  } catch {
    return { rawMetaText: text.slice(metaStart) }  // JSON parse 失敗
  }
}

/**
 * P0-ending-fix: 偵測結局標記 + META
 * - 偵測 [[END]] 或 META: 出現 → isEnding=true
 * - parse META JSON（支援多行、巢狀 }）
 * - parse 失敗 → 回傳 fallback meta
 * - content 移除 [[END]] 和 META 區段，只留劇情文字
 */
export function detectEnding(text: string): { content: string; isEnding: boolean; meta?: EndingMeta } {
  const hasEndMarker = text.includes('[[END]]')
  const hasMetaMarker = text.includes('META:')

  if (!hasEndMarker && !hasMetaMarker) {
    return { content: text, isEnding: false }
  }

  // 偵測到 ending 信號
  let content = text
  let meta: EndingMeta | undefined

  if (hasMetaMarker) {
    const { meta: parsedMeta, rawMetaText } = parseMetaFromText(text)
    meta = parsedMeta  // undefined if parse failed
    // 從 text 移除 META 區段（從 META: 開始到結尾）
    const metaStart = text.indexOf('META:')
    content = text.slice(0, metaStart)
  }

  // 從 content 移除 [[END]]
  if (hasEndMarker) {
    content = content.replace(/\[\[END\]\]/g, '')
  }

  content = content.trim()

  // 如果 parse 失敗，用 fallback meta（但只在我們真的看到 META: 時）
  if (hasMetaMarker && !meta) {
    meta = FALLBACK_ENDING_META
    console.warn('[detectEnding] META parse failed, using fallback')
  }

  return { content, isEnding: true, meta }
}

/**
 * P0-ending-fix: 檢查 text 是否「開始」進入 ending 區段
 * 用於 streaming 時決定要不要停止 emit text_chunk / audio_chunk
 * 一旦看到 [[END]] 或 META: 的開頭，就進入 metadata buffering 模式
 */
export function isEnteringEndingBlock(text: string): boolean {
  return text.includes('[[END]]') || text.includes('META:')
}

/**
 * P0-ending-fix: 從完整 text 抽出 ending 前的劇情文字（不含 [[END]] / META）
 * 用於 streaming 收尾時，把最後一段「還沒 flush 但已經是 ending 一部分」的文字清掉
 */
export function extractPreEndingText(text: string): string {
  const endIdx = text.indexOf('[[END]]')
  const metaIdx = text.indexOf('META:')
  let cutIdx = -1
  if (endIdx !== -1) cutIdx = endIdx
  if (metaIdx !== -1 && (cutIdx === -1 || metaIdx < cutIdx)) cutIdx = metaIdx
  if (cutIdx === -1) return text
  return text.slice(0, cutIdx).trim()
}

export { FALLBACK_ENDING_META }
