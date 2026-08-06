# Life Blind Box

> Voice-first AI micro-drama platform. 5 分鐘一局，用說的推進劇情，AI 即興演繹。

> **Current stage: 5–10 人 Trained Alpha (text + voice fallback)**
> 不是 voice beta。是 trained alpha：Z.ai TTS 為主、字幕 fallback 為輔。
> 詳見 [`docs/beta-stage-classification.md`](./docs/beta-stage-classification.md)

每次開局隨機生成一個極端、詭異或平凡的場景——你可能是即將被丟進鍋裡的大白菜、被合夥人掃出公司的創辦人、或被困在玻璃罐裡的螢火蟲。3-5 輪語音對話內，AI 會把劇情推向一個結局（好結局 / 壞結局 / 懸念結局）。

沒有存檔、沒有重來。體驗結束即銷毀。

---

## Tech Stack

**Frontend (Next.js app)**
- Next.js 16 (App Router)
- React 19 + TypeScript 5
- Tailwind CSS 4 + shadcn/ui
- socket.io-client (WebSocket connection to voice-game service)

**Backend (voice-game mini-service)**
- Bun runtime + socket.io server (`PORT`, local default 3003)
- OpenAI SDK for LLM streaming, speech-to-text, and text-to-speech

**AI models (Render default)**
- LLM: `gpt-4o-mini`
- STT: `gpt-4o-mini-transcribe`
- TTS: `gpt-4o-mini-tts` (voice: `fable`)

**Infrastructure**
- Two Render web services: Next.js frontend + public Socket.IO voice service
- In-memory game state; no database is required

---

## Repository Structure

```
life-blind-box/
├── src/
│   └── app/
│       ├── page.tsx          # Main UI: idle / narrating / recording / ended states
│       └── layout.tsx
├── mini-services/
│   └── voice-game/
│       ├── index.ts           # WebSocket server + game logic
│       ├── openai-client.ts   # OpenAI SDK wired to Z.ai gateway
│       ├── prompt.ts          # System prompt + sentence splitter + ending META parser
│       └── scene-templates.ts # 30 scene templates across 8 categories
├── scripts/
│   ├── test-e2e.ts           # End-to-end smoke test
│   ├── test-llm-stream.ts    # LLM streaming sanity check
│   ├── test-tts.ts           # TTS sanity check
│   └── test-stt.ts           # STT sanity check
├── prisma/
│   └── schema.prisma         # (empty, reserved)
├── public/
├── .env.example              # Template — copy and fill in
├── .gitignore
├── Caddyfile                 # Gateway config
├── package.json
└── README.md
```

---

## Quick Start

Start the voice service with server-side OpenAI configuration:

```bash
cd mini-services/voice-game
bun install
OPENAI_API_KEY=... bun run dev
```

Then start the frontend from the repo root. Its local fallback connects to
`http://localhost:3003`; set `NEXT_PUBLIC_VOICE_GAME_URL` to override it.

```bash
bun install
bun run dev
```

## Render deployment

The repository includes [`render.yaml`](./render.yaml). Existing services can
also be configured manually with these equivalent settings:

| Service | Root directory | Build command | Start command | Health check |
|---|---|---|---|---|
| `life-blind-box` | repository root | `bun install --frozen-lockfile && bun run build` | `bun run start` | `/` |
| `life-blind-box-voice` | `mini-services/voice-game` | `bun install --frozen-lockfile` | `bun run start` | `/health` |

Frontend build-time environment:

- `NEXT_PUBLIC_VOICE_GAME_URL=https://life-blind-box-voice.onrender.com`

Voice service environment:

- `OPENAI_API_KEY` (secret; set only in Render)
- `LLM_PROVIDER=openai`
- `ASR_PROVIDER=openai`
- `TTS_PROVIDER=openai`
- `CORS_ORIGIN=https://life-blind-box.onrender.com`

Render injects `PORT`; the service reads it automatically. The API key must
never be prefixed with `NEXT_PUBLIC_` or committed to the repository.

---

## Environment Variables

See [`.env.example`](./.env.example) for the full list. Summary:

| Variable | Used by | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | voice-game | Required server-side OpenAI API key |
| `OPENAI_LLM_MODEL` | voice-game | LLM model name (default `gpt-4o-mini`) |
| `OPENAI_ASR_MODEL` | voice-game | STT model (default `gpt-4o-mini-transcribe`) |
| `OPENAI_TTS_MODEL` | voice-game | TTS model (default `gpt-4o-mini-tts`) |
| `NEXT_PUBLIC_VOICE_GAME_URL` | Next.js | Public origin of the Socket.IO voice service |

---

## Main Flow

```
┌──────────────────────────────────────────────────────────────┐
│                       Player (browser)                        │
│  press & hold button → MediaRecorder → base64 audio           │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼ submit_audio event (socket.io)
┌──────────────────────────────────────────────────────────────┐
│                  voice-game service (port 3003)               │
│                                                               │
│  1. ASR  : z-ai ASR (base64 audio → text)                     │
│  2. LLM  : OpenAI SDK streaming (text → streaming narration)  │
│           - sentences split on 。！？, and 40-char boundary   │
│           - each sentence flushed immediately                 │
│  3. TTS  : parallel TTS per sentence (semaphore-limited)      │
│           - retry with exponential backoff on 429 / 5xx       │
│  4. emit : text_chunk (real-time subtitle)                    │
│           audio_chunk (wav, played in seq order on client)    │
│           turn_complete (LLM done, can start next round)      │
│           game_over + META (title / endingType / verdict)     │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼ socket.io events
┌──────────────────────────────────────────────────────────────┐
│                       Player (browser)                        │
│                                                               │
│  - text_chunk  → append to subtitle                           │
│  - audio_chunk → enqueue by seq, play sequentially            │
│  - if user starts recording mid-playback:                     │
│      interruptPlayback() → stop audio, clear queue            │
│      → immediately start new submit_audio                     │
│  - game_over   → show ending card (title / verdict / share)   │
└──────────────────────────────────────────────────────────────┘
```

### Key technical decisions

- **LLM streaming + sentence-flush**: We don't wait for the full LLM response.
  As soon as a complete sentence is formed, we fire TTS for it in parallel.
  This keeps first-audio latency under ~3s.
- **`turn_complete` fires when LLM finishes, NOT when TTS finishes**.
  The user can start talking again immediately; TTS chunks keep arriving
  in the background.
- **Interrupt**: When the user presses the talk button during playback,
  we resolve the current `audio.play()` promise via `interruptResolverRef`,
  clear the queue, and immediately enter recording state.
- **Ending META**: The LLM is prompted to emit `[[END]]` followed by a JSON
  block with `title / endingType / verdict`. The backend parses this and
  sends it as part of `game_over`, which the frontend renders as a share card.

### Game rules (enforced in prompt + backend)

- **No numbers / no stats**: All state changes described through narration
  ("your stomach growls loudly" not "hunger -50").
- **3-5 turn limit**: rounds 1-3 cannot end; round 4 may end; round 5 must end.
- **Daily free limit**: 3 games/day per browser (localStorage).
- **Scene templates**: 30 templates across 8 categories. Random by default,
  or user can pick a category.

---

## Scene Templates

30 high-emotion scene templates, organized into 8 categories:

| Category | Count | Example |
|----------|-------|---------|
| 🌀 Absurd Survival | 4 | 即將被丟進鍋裡的大白菜 |
| 🎭 Identity Reversal | 4 | 裝窮三年的首富之子 |
| ⚔️ Revenge Drama | 4 | 出獄妻子現身前夫婚禮 |
| 💔 High-Stakes Romance | 4 | 總裁契約妻合約明天到期 |
| 💼 Workplace Betrayal | 3 | 新人搶晉升 |
| 🏚️ Family Secret | 3 | 父親日記寫「這孩子不是我的」 |
| 🔮 Fantasy Rebellion | 4 | 修仙廢柴被魔尊收徒 |
| 🎪 Social Humiliation | 4 | 婆婆年夜飯倒菜 |

See [`mini-services/voice-game/scene-templates.ts`](./mini-services/voice-game/scene-templates.ts).

---

## Known Issues

### 1. TTS rate limiting (429)
The Z.ai TTS API has aggressive rate limits. We mitigate with:
- TTS circuit breaker (per-session + global, see `tts-circuit-breaker.ts`)
- Semaphore(1) for concurrent TTS calls (reduced from 2 for beta fragile window)
- 1500ms minimum interval between TTS starts (increased from 300ms)
- When circuit opens: auto-switch to text-only fallback UI ("AI 嗆聲中，先用字幕模式演出")

**OpenAI TTS fallback**: `implemented, not environment-verified`
- Code complete (`openai-tts.ts` with official SDK)
- Logic correct (TTS_PROVIDER=auto: Z.ai → 429 → OpenAI → both fail → text-only)
- Cannot be tested in current sandbox (OpenAI API 403 region blocked)
- Will be verified after deploying to Railway / Render / Fly.io

### 2. Single-process voice-game service
The voice-game service runs as a single Bun process. No clustering,
no horizontal scaling. Suitable for ~50 concurrent users, not more.

### 3. No persistence
Game state is in-memory only. If the voice-game service restarts,
all active games are lost. No user accounts, no history, no analytics.

### 4. No authentication
Anyone with the URL can play. No rate limiting per IP, no abuse protection.
The daily free limit is enforced client-side via localStorage (trivially bypassable).

### 5. No content moderation
The LLM is prompted to avoid explicit content, but there is no programmatic
moderation layer. User speech and LLM output are not filtered.

### 6. Audio quality depends on browser
MediaRecorder uses `audio/webm;codecs=opus` when available, falling back
to other formats. Safari has the most compatibility issues.

### 7. Share card is text-only
No AI-generated illustration yet. Planned: use image generation API
to create a scene illustration for the ending card.

### 8. No multi-language UI
Game content is in Traditional Chinese. UI labels are mixed Chinese/English.
Full localization is planned but not yet implemented.

---

## Roadmap (next 4-6 weeks)

1. **Beta test** — 50 users, collect completion rate / D1 retention / share rate
2. **Content expansion** — grow template library to 100+, add user-submitted templates
3. **Ending card illustration** — AI-generated scene image per ending
4. **Multi-language** — English / Japanese / Korean support
5. **Creator studio** — let writers submit their own scene templates
6. **OpenAI migration** — switch to GPT-4o-mini + OpenAI TTS for better quality
   (blocked by region; needs proxy or self-hosted gateway)

---

## License

Private project. All rights reserved.

## Contact

Built by Crystal (@Crystal32378) with Z.ai assistant.
