// 人生盲盒 Scene Templates
// 30 個 high-emotion 開場，分 8 種類型
// 用法：後端 start_game 時隨機抽一個，注入 LLM prompt 當開場引子
// LLM 會根據 template 即興展開，每次都不一樣

export interface SceneTemplate {
  id: string
  category: SceneCategory
  roleSetup: string      // 玩家角色設定（你是一個...）
  openingHook: string    // 開場引子（場景 + 衝突點）
  tone: string           // 風格調性
  endingTendency: 'good' | 'bad' | 'open'  // 預期結局傾向（僅供 LLM 參考，非強制）
}

export type SceneCategory =
  | 'absurd_survival'    // 荒誕生存
  | 'identity_reversal'  // 身份反轉
  | 'revenge_drama'      // 復仇劇
  | 'high_stakes_romance' // 高張力愛情
  | 'workplace_betrayal' // 職場背叛
  | 'family_secret'      // 家庭秘密
  | 'fantasy_rebellion'  // 奇幻反抗
  | 'social_humiliation' // 社會羞辱逆轉

export const SCENE_TEMPLATES: SceneTemplate[] = [
  // ===== 1. 荒誕生存 absurd_survival (4) =====
  {
    id: 'absurd_1',
    category: 'absurd_survival',
    roleSetup: '你是一顆即將被丟進鍋裡的大白菜',
    openingHook: '廚房的燈亮著，你聽見主婦哼著歌走來，刀已經磨好。',
    tone: '黑色幽默，帶一點存在主義的荒謬感',
    endingTendency: 'open',
  },
  {
    id: 'absurd_2',
    category: 'absurd_survival',
    roleSetup: '你是一隻誤入貓群的機器老鼠',
    openingHook: '五隻貓圍著你，其中一隻正用爪子輕拍你的金屬外殼。',
    tone: '緊張但帶喜感，節奏快',
    endingTendency: 'open',
  },
  {
    id: 'absurd_3',
    category: 'absurd_survival',
    roleSetup: '你是被困在電梯裡的婚禮司儀',
    openingHook: '電梯停在十二樓，外面是三十分鐘後要開始的婚禮，新郎剛剛傳訊息說他想逃婚。',
    tone: '慌張喜劇，充滿時限壓力',
    endingTendency: 'good',
  },
  {
    id: 'absurd_4',
    category: 'absurd_survival',
    roleSetup: '你是一隻被困在玻璃罐裡的螢火蟲',
    openingHook: '罐子外是一個孩子的臉，正貼著玻璃觀察你，他的手指正準備擰開蓋子。',
    tone: '詩意但緊繃，帶童話感',
    endingTendency: 'open',
  },

  // ===== 2. 身份反轉 identity_reversal (4) =====
  {
    id: 'identity_1',
    category: 'identity_reversal',
    roleSetup: '你是裝窮三年的首富之子',
    openingHook: '今天是大學同學會，他們還在笑你穿假名牌，但你口袋裡有一張父親剛簽的繼承書。',
    tone: '爽感打臉，節奏明快',
    endingTendency: 'good',
  },
  {
    id: 'identity_2',
    category: 'identity_reversal',
    roleSetup: '你是豪門養女，真千金突然回來了',
    openingHook: '全家坐在客廳，母親看著你說：「孩子，我們覺得你該讓位了。」你的行李箱在腳邊。',
    tone: '虐心但帶反擊張力',
    endingTendency: 'open',
  },
  {
    id: 'identity_3',
    category: 'identity_reversal',
    roleSetup: '你是上市集團的清潔工，董事長剛過世',
    openingHook: '律師在公司大廳宣讀遺囑，所有人都在等誰接班，他念出你的名字。',
    tone: '戲劇化反轉，帶懸疑',
    endingTendency: 'open',
  },
  {
    id: 'identity_4',
    category: 'identity_reversal',
    roleSetup: '你是現代法醫，穿越成古代仵作',
    openingHook: '縣太爺剛送來一具「假死」的屍體，你的手機還在口袋裡震動，螢幕顯示現代時間。',
    tone: '懸疑推理，跨時空錯置感',
    endingTendency: 'good',
  },

  // ===== 3. 復仇劇 revenge_drama (4) =====
  {
    id: 'revenge_1',
    category: 'revenge_drama',
    roleSetup: '你是被丈夫和小三聯手陷害入獄的妻子',
    openingHook: '三年了，今天你出獄。他們以為你會消失，但你站在他們的婚禮會場門口。',
    tone: '冷靜復仇，戲劇張力強',
    endingTendency: 'bad',
  },
  {
    id: 'revenge_2',
    category: 'revenge_drama',
    roleSetup: '你是被合夥人掃出公司的創辦人',
    openingHook: '三年後，你的舊公司快倒了，他坐在你對面，求你回來救他。',
    tone: '冷面打臉，帶勝利感',
    endingTendency: 'good',
  },
  {
    id: 'revenge_3',
    category: 'revenge_drama',
    roleSetup: '你是被霸凌三年的高中轉學生',
    openingHook: '畢業典禮上，霸凌你的那個人跪在台上領獎，你手裡有他作弊的鐵證。',
    tone: '青春復仇，情緒濃烈',
    endingTendency: 'open',
  },
  {
    id: 'revenge_4',
    category: 'revenge_drama',
    roleSetup: '你是被師門背叛的修仙弟子',
    openingHook: '你師父剛把你的金丹挖走，丟下懸崖。你睜眼發現自己還活著，腳邊有一把不認得的劍。',
    tone: '武俠復仇，古風沉重',
    endingTendency: 'open',
  },

  // ===== 4. 高張力愛情 high_stakes_romance (4) =====
  {
    id: 'romance_1',
    category: 'high_stakes_romance',
    roleSetup: '你是總裁的契約妻子，合約明天到期',
    openingHook: '他剛剛帶白月光回家，說要離婚。但今晚他突然推開你的房門，眼神複雜。',
    tone: '高張力情感，欲擒故縱',
    endingTendency: 'open',
  },
  {
    id: 'romance_2',
    category: 'high_stakes_romance',
    roleSetup: '你是頂流偶像的青梅竹馬',
    openingHook: '他出道十年第一次回老家找你，門口的狗仔已經架好鏡頭。',
    tone: '青春愛情，禁忌感',
    endingTendency: 'good',
  },
  {
    id: 'romance_3',
    category: 'high_stakes_romance',
    roleSetup: '你是古代和親公主，剛抵達敵國',
    openingHook: '你的未婚夫君——那位傳說中殘暴的王——親自來迎接，他掀開簾子時說了一句你沒想到的話。',
    tone: '古風宮鬥，愛恨交織',
    endingTendency: 'open',
  },
  {
    id: 'romance_4',
    category: 'high_stakes_romance',
    roleSetup: '你是 18 線小演員，金主爸爸剛砸五億點名要你演女主角',
    openingHook: '開鏡記者會上，男主角當眾摔劇本走人，金主爸爸坐在第一排看著你。',
    tone: '娛樂圈爽感，話題性強',
    endingTendency: 'good',
  },

  // ===== 5. 職場背叛 workplace_betrayal (3) =====
  {
    id: 'work_1',
    category: 'workplace_betrayal',
    roleSetup: '你是公司最資深的工程師，剛被新人搶了晉升',
    openingHook: '新人站在你面前，笑著說：「前輩，那個 bug 你修不好，交給我吧。」你打開他寫的程式碼。',
    tone: '職場暗戰，冷調寫實',
    endingTendency: 'open',
  },
  {
    id: 'work_2',
    category: 'workplace_betrayal',
    roleSetup: '你是連續加班一個月的業務',
    openingHook: '客戶簽約了，功勞被主管搶走。你打開電腦，發現他留了一封辭退信要你簽。',
    tone: '現代職場悲劇，情緒壓抑',
    endingTendency: 'bad',
  },
  {
    id: 'work_3',
    category: 'workplace_betrayal',
    roleSetup: '你是銀行櫃員，剛發現主管在做假帳',
    openingHook: '主管把一疊現金推到你面前：「你什麼都沒看見。」監視器剛好壞了。',
    tone: '道德兩難，懸疑緊繃',
    endingTendency: 'open',
  },

  // ===== 6. 家庭秘密 family_secret (3) =====
  {
    id: 'family_1',
    category: 'family_secret',
    roleSetup: '你剛在父親葬禮上發現一本日記',
    openingHook: '日記寫著：「這孩子不是我的。」你母親站在靈堂前，看著你。',
    tone: '家庭懸疑，情感衝擊強',
    endingTendency: 'open',
  },
  {
    id: 'family_2',
    category: 'family_secret',
    roleSetup: '你是長女，父親剛把公司留給弟弟',
    openingHook: '律師私下告訴你：「你父親知道弟弟不是親生的。」你手裡握著這個秘密。',
    tone: '家庭倫理，道德兩難',
    endingTendency: 'open',
  },
  {
    id: 'family_3',
    category: 'family_secret',
    roleSetup: '你回到老家奔喪，發現全家都在說謊',
    openingHook: '奶奶的死因寫著心臟病，但你看到她枕頭下的紙條：「他們要我的房子。」',
    tone: '家庭驚悚，層層揭開',
    endingTendency: 'bad',
  },

  // ===== 7. 奇幻反抗 fantasy_rebellion (4) =====
  {
    id: 'fantasy_1',
    category: 'fantasy_rebellion',
    roleSetup: '你是修仙界的廢柴，師門被滅',
    openingHook: '魔尊收你為徒，說要親自調教你。他遞給你一杯酒，眼神卻不像敵人。',
    tone: '仙俠反轉，師徒禁忌感',
    endingTendency: 'open',
  },
  {
    id: 'fantasy_2',
    category: 'fantasy_rebellion',
    roleSetup: '你是穿越成惡毒女配的現代女孩',
    openingHook: '原劇本你會在第三章被毒死，現在是第二章最後一行，男主正端著茶走來。',
    tone: '穿越爽感，自我救贖',
    endingTendency: 'good',
  },
  {
    id: 'fantasy_3',
    category: 'fantasy_rebellion',
    roleSetup: '你是末日世界的最後一個 AI',
    openingHook: '人類都死了，你守著一個冷凍艙，裡面是最後一個胚胎。你的電量警示燈亮了。',
    tone: '末日詩意，哲學思辨',
    endingTendency: 'open',
  },
  {
    id: 'fantasy_4',
    category: 'fantasy_rebellion',
    roleSetup: '你是無限流小說的 NPC',
    openingHook: '主角發現了你的存在，要你幫他通關。下一個副本是「所有人只能活一個」。',
    tone: '無限流懸疑，生存壓力',
    endingTendency: 'open',
  },

  // ===== 8. 社會羞辱逆轉 social_humiliation (4) =====
  {
    id: 'social_1',
    category: 'social_humiliation',
    roleSetup: '你是被婆婆當眾羞辱的媳婦',
    openingHook: '年夜飯上，婆婆把你做的菜倒進垃圾桶，全家人低頭吃飯。你站起來。',
    tone: '家庭霸凌逆襲，爽感強',
    endingTendency: 'good',
  },
  {
    id: 'social_2',
    category: 'social_humiliation',
    roleSetup: '你是被同學網暴的高中生',
    openingHook: '一條誣陷你的影片在網路上瘋傳，今天你走進教室，所有人都安靜了。',
    tone: '青春逆襲，社會議題',
    endingTendency: 'open',
  },
  {
    id: 'social_3',
    category: 'social_humiliation',
    roleSetup: '你是被丈母娘嫌棄的女婿',
    openingHook: '年夜飯上，她當著全家說：「你配不上我女兒。」你的妻子低頭不語。',
    tone: '社會階級衝突，情緒爆發',
    endingTendency: 'open',
  },
  {
    id: 'social_4',
    category: 'social_humiliation',
    roleSetup: '你是餐廳服務生，被客人當眾潑水',
    openingHook: '那位客人是上市公司總裁，他揚言要讓你失業。你抬起頭，發現他是你失聯多年的父親。',
    tone: '身份反轉 + 社會羞辱，雙重衝擊',
    endingTendency: 'open',
  },
]

// 隨機抽一個 template
export function pickRandomTemplate(): SceneTemplate {
  const idx = Math.floor(Math.random() * SCENE_TEMPLATES.length)
  return SCENE_TEMPLATES[idx]
}

// 根據類別隨機抽
export function pickTemplateByCategory(category: SceneCategory): SceneTemplate {
  const filtered = SCENE_TEMPLATES.filter(t => t.category === category)
  if (filtered.length === 0) return pickRandomTemplate()
  return filtered[Math.floor(Math.random() * filtered.length)]
}

// 把 template 轉成給 LLM 的開場指示
export function templateToOpeningPrompt(template: SceneTemplate): string {
  const endingHint = template.endingTendency === 'good' ? '好結局' :
                     template.endingTendency === 'bad' ? '壞結局' : '懸念結局'
  return `請用以下設定開場（這是這一局的設定，請融入你的開場白中，但不要逐字背誦，要即興展開）：

【場景設定】
${template.roleSetup}。${template.openingHook}

【風格調性】
${template.tone}

【結局傾向】
這一局建議走向「${endingHint}」（但若玩家選擇明顯衝突，可彈性調整）

請根據以上設定，即興寫一個 50-100 字的開場白，建立場景、引導玩家行動。記得不要使用 [[END]] 標記。`
}

// 類別中文名稱（給前端顯示用）
export const CATEGORY_NAMES: Record<SceneCategory, { zh: string; en: string }> = {
  absurd_survival: { zh: '荒誕生存', en: 'Absurd Survival' },
  identity_reversal: { zh: '身份反轉', en: 'Identity Reversal' },
  revenge_drama: { zh: '復仇劇', en: 'Revenge Drama' },
  high_stakes_romance: { zh: '高張力愛情', en: 'High-Stakes Romance' },
  workplace_betrayal: { zh: '職場背叛', en: 'Workplace Betrayal' },
  family_secret: { zh: '家庭秘密', en: 'Family Secret' },
  fantasy_rebellion: { zh: '奇幻反抗', en: 'Fantasy Rebellion' },
  social_humiliation: { zh: '社會逆襲', en: 'Social Humiliation' },
}
