# QA Log — Life Blind Box

## 2026-07-06 — Railway / OpenAI Staging

**Environment**: Railway (voice-game + frontend services)
**Provider**: OpenAI (LLM: gpt-4o-mini, ASR: gpt-4o-mini-transcribe, TTS: gpt-4o-mini-tts voice=fable)
**Branch**: `fix-alpha-p0-recovery`
**Commit**: `2d38195` (badge fix) / `a555aed` (Bug E fix)

### Test Result: ✅ FULL PASS

| Check | Status |
|---|---|
| CONNECTED | ✅ |
| Founder mode | ✅ |
| TURN 5/5 reached | ✅ |
| 100/100 quota | ✅ |
| Full 5-turn run completed | ✅ |
| Ending card appeared | ✅ |
| No ASR / LLM / TTS stuck | ✅ |
| Bug E (ending timing) | ✅ PASS (narration completed before card) |

### Story coherence
餐廳羞辱 → 父子身份揭露 → 詢問父親期待 → ending card「父子之約」

### Bug E verification
- Turn 5 旁白完整播完
- 停頓 ~400ms
- Ending card 才彈出
- 沒有殘留聲音
- **Bug E: PASS in this run / needs one more confirmation**

### Remaining issue
- UI badge 顯示 `QA · 0bc951f · founder`（舊 commit hash）
- 已修：badge 改為 `QA READY · founder · OpenAI`
- Hover tooltip 顯示 frontend/voice-game commit + provider + env

### Commits in this session
- `0bc951f` — OpenAI providers (ASR + LLM + TTS switching)
- `0453f08` — openai-client graceful degradation (no crash without .z-ai-config)
- `1b849d0` — openai-client fix + ending-timing partial fix
- `a555aed` — Bug E fix: delay ending card until audio drains
- `2d38195` — Badge fix: show "QA READY · founder · OpenAI"

### Fixes verified working
1. ✅ P0 quota refund + founder mode + LLM fallback
2. ✅ Audio queue fix (no choppy playback)
3. ✅ META/ending parser fix (no META in subtitles/TTS)
4. ✅ Postgame audio fix (no residual audio after ending)
5. ✅ Hard-gated C (turn 5/5 only, no early ending)
6. ✅ ASR circuit breaker (429 handling)
7. ✅ OpenAI providers (stable, no z.ai dependency)
8. ✅ Bug E fix (ending card timing)

### Next steps
- Bug E: one more confirmation run to fully close
- Consider: 5-person trained alpha test
- Consider: public showcase edition update

## 2026-07-06 — Bug E Final Verification

**Commit**: `2d38195` (badge fix, includes `a555aed` Bug E fix)
**Railway running**: `2d38195` (both voice-game + frontend)

### Bug E: ✅ PASS — ending card delayed until final narration playback completes

Second confirmation run result:
- CONNECTED ✅
- founder mode ✅
- TURN 5/5 ✅
- 完整一局走完 ✅
- 最後旁白完整播完後，ending card 才出現 ✅
- ending card 出現後沒有殘留聲音 ✅
- quota 正常 ✅
- Badge: `QA READY · founder · OpenAI` ✅

### Checkpoint: OpenAI Railway playable checkpoint after Bug E fix

All bugs PASS:
- Bug A (turn 4 提前結束): PASS
- Bug B (ending 後殘留聲音): PASS
- Bug C (ASR 429 重試地獄): PASS
- Bug D (舊 generation 未 abort): PASS (OpenAI stable)
- Bug E (ending card 太早): PASS

Status: PLAYABLE CHECKPOINT READY
