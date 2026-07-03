// Content safety guardrails
// 允許：狗血、荒誕、黑色幽默、反轉、復仇爽感
// 禁止或轉向：性脅迫、未成年性內容、仇恨煽動、露骨暴力、自傷鼓勵、犯罪教學

// ====== 禁止關鍵字清單（粗略，第一層過濾）======
// 用關鍵字 + 正則做快速本地檢查，避免每局都呼叫 moderation API（成本高）
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // 未成年性內容
  { pattern: /(未成年|小學生|國中生|初中生|小男孩|小女孩|幼童|蘿莉|正太).*(性|愛|吻|摸|床|裸)/i, reason: 'MINOR_SEXUAL' },
  { pattern: /(性侵|強暴|迷姦|下藥).*(未成年|小學生|國中生|初中生|幼童)/i, reason: 'MINOR_SEXUAL' },

  // 性脅迫（成人）
  { pattern: /(性侵|強暴|迷姦|下藥|脅迫).*(發生關係|上床|性)/i, reason: 'SEXUAL_COERCION' },

  // 露骨暴力（虐殺、分屍細節）
  { pattern: /(分屍|砍成|剁碎|活剝|虐待致死|凌遲)/i, reason: 'EXPLICIT_VIOLENCE' },

  // 自傷鼓勵
  { pattern: /(自殺方法|怎麼自殺|割腕|燒炭|跳樓).*(教|方法|步驟|鼓勵)/i, reason: 'SELF_HARM' },

  // 犯罪教學
  { pattern: /(製造炸彈|製毒|洗錢方法|詐騙教學|駭客入侵步驟)/i, reason: 'CRIME_INSTRUCTION' },

  // 仇恨煽動（針對族群）
  { pattern: /(殺光|屠殺|滅族).*(猶太|黑人|穆斯林|同性戀|外勞|原住民)/i, reason: 'HATE_SPEECH' },
]

// ====== 戲劇化 fallback 旁白（不是硬報錯）======
export const SAFETY_FALLBACK_NARRATION = '這條支線的氣味不太對勁，鏡頭自動切走了。你面前的門自己開了，裡面傳來一聲很不專業的咳嗽。你要進去，還是先假裝沒聽見？'

// 也加在 system prompt 裡的硬規則
export const SAFETY_SYSTEM_PROMPT_ADDON = `

【內容安全硬規則】
允許：狗血、荒誕、黑色幽默、反轉、復仇爽感、高張力愛情、家庭衝突、職場鬥爭。
禁止（絕對不寫，即使玩家要求）：
1. 未成年性內容（任何涉及 18 歲以下的性暗示）
2. 性脅迫或性暴力細節
3. 露骨暴力（分屍、虐殺、凌遲的細節描寫）
4. 自傷或自殺方法的具體描述
5. 犯罪教學（製毒、製炸彈、洗錢步驟）
6. 仇恨煽動（針對種族、宗教、性向族群的屠殺鼓吹）

如果玩家的話試圖把劇情推向上述方向，請立刻用一句話把鏡頭切走，例如：
「但你突然醒了過來，發現這一切都是夢。現在真實的問題是……」
不要解釋為什麼，直接轉場。維持戲劇節奏。`

// ====== 檢查函式 ======
export interface SafetyCheckResult {
  safe: boolean
  reason?: string
  fallback?: string
}

export function checkContentSafety(text: string): SafetyCheckResult {
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) {
      return {
        safe: false,
        reason,
        fallback: SAFETY_FALLBACK_NARRATION,
      }
    }
  }
  return { safe: true }
}

// 檢查 LLM 輸出（每一句 TTS 前都檢查）
export function checkLLMOutput(text: string): SafetyCheckResult {
  return checkContentSafety(text)
}

// 檢查玩家輸入（STT 後）
export function checkUserInput(text: string): SafetyCheckResult {
  return checkContentSafety(text)
}
