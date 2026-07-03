# Beta Stage Classification

> **Last updated**: 2026-07-03
> **Owner**: Crystal / Alfred / Z

Life Blind Box 目前所處的測試階段，命名必須精準，不可混淆。

---

## 目前狀態：5–10 人 Trained Alpha（text + voice fallback）

不是 voice beta。
不是 closed beta。
是 **trained alpha**：少數受邀、了解這是 alpha 的測試者，在 Z.ai TTS 為主、字幕 fallback 為輔的狀態下測試。

### 這一輪可以測的

- 劇情毒性（開場是否讓人想繼續）
- 完局率（5 輪玩到底的比例）
- replay intent（完局後是否想再開一局）
- share intent（結局卡是否讓人想分享）
- 字幕 fallback 是否還保得住體感（TTS 掛掉時，純字幕模式是否仍可玩）

### 這一輪不能宣稱已驗證的

- voice-first retention（純語音模式的留存）
- first-audio reliability（首音延遲穩定度）
- OpenAI TTS fallback effectiveness（OpenAI 備用喉嚨實際效果）

---

## 為什麼不是 voice beta

因為以下三項都還沒驗證：

1. **OpenAI TTS**：`implemented, not environment-verified`
   - 程式碼完成（`mini-services/voice-game/openai-tts.ts`）
   - 程式碼邏輯正確（circuit breaker + provider fallback）
   - 但 sandbox 對 OpenAI API 403 region blocked，無法實測
   - 不要寫成 passed

2. **Z.ai TTS reliability**：間歇性 429
   - 額度冷卻時可用，密集使用會撞限流
   - circuit breaker 可緩解，但不是根治

3. **首音延遲穩定度**：未通過 80% 成功率門檻
   - benchmark 10 局中，first-audio 成功率 0/10（Z.ai 429）
   - 必須 first-audio p50 < 3000ms 且成功率 > 80% 才算 voice beta ready

---

## Trained Alpha 配置

```bash
# 預設配置（Z.ai 為主，字幕 fallback）
TTS_PROVIDER=auto              # Z.ai first, fallback OpenAI（但 OpenAI 在 sandbox 403）
PER_IP_DAILY_LIMIT=5           # 每 IP 每日 5 局
GLOBAL_DAILY_CAP=200           # 全站每日 200 局
BETA_DISABLED=false            # kill switch off
```

如果 Z.ai TTS 又 429：
- circuit breaker 觸發 → 自動切字幕模式
- 玩家看到「AI 嗆聲中，先用字幕模式演出」
- 遊戲可繼續完成，字幕放大加亮

---

## 升級到 Voice Beta 的條件

以下三項全部達成才升級：

1. **部署到可合規呼叫 OpenAI API 的 server**
   - Railway / Render / Fly.io 任一
   - 設定 `OPENAI_API_KEY` + `TTS_PROVIDER=auto`

2. **Opening benchmark 通過**
   - first-audio p50 < 3000ms
   - first-audio 成功率 > 80%
   - 跑 10 局，至少 8 局有聲音

3. **Interactive benchmark 通過**
   - submit_audio → first-audio p50 < 3000ms
   - 搶話中斷穩定（舊 generation audio 不污染新局）
   - 跑 5 局完整對話，每局 3-5 輪

---

## Voice 配置（升級後才用）

```bash
TTS_PROVIDER=auto
OPENAI_API_KEY=<your key>
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_VOICE=coral              # emergency fallback voice; not Chinese primary
# Future English version candidate: fable
OPENAI_TTS_RESPONSE_FORMAT=wav
# 中文主聲音仍用 Z.ai tongtong（OpenAI 中文偏英文腔，不搶中文主聲音）
```

### Voice 選擇策略

- **中文主聲音**：Z.ai `tongtong`（中文自然度優先）
- **OpenAI fallback**：`coral` 或 `fable`（emergency backup，避免完全失聲）
- **英文版未來**：可考慮 `fable`（Crystal 試聽後選的，"a dash of calm and ready to take you to the journey"）

### 為什麼 OpenAI TTS 不是中文主聲音

Crystal 在 OpenAI Playground 試聽後發現：
- OpenAI 中文聲音偏英文腔
- Z.ai 中文自然度明顯較好
- 所以 OpenAI TTS 定位為 **emergency fallback**，不是中文主聲音

主聲音仍以 Z.ai 中文自然度為優先；OpenAI 是避免完全失聲的備用喉嚨。

---

## 30 人 Closed Beta 條件

升級到 Voice Beta 後，再跑一輪 5-10 人 voice beta：
- voice-first retention > 30%
- share rate > 20%
- D1 retention > 20%

三項有兩項達標，才擴到 30 人 closed beta。
