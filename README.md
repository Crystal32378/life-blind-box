# Life Blind Box

> Voice-first AI micro-drama platform. 5 分鐘一局，用說的推進劇情，AI 即興演繹。

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
- Bun runtime + socket.io server (port 3003)
- OpenAI SDK (chat.completions streaming)
- z-ai-web-dev-sdk (TTS / ASR)

**AI models (current)**
- LLM: `glm-4-plus` (via Z.ai internal gateway, OpenAI-compatible API)
- STT: Z.ai ASR (Whisper-style)
- TTS: Z.ai TTS (voice: `tongtong`)

> The voice-game service uses OpenAI SDK pointed at the Z.ai internal gateway
> (`internal-api.z.ai/v1`) configured in `/etc/.z-ai-config`. This avoids
> OpenAI's region block on HK and gives us GLM-4-plus with OpenAI-compatible
> streaming. TTS/ASR still go through the Z.ai SDK because their API shape
> differs slightly from OpenAI's.

**Infrastructure**
- Caddy gateway (port 81 → routes to Next.js 3000 and voice-game 3003 via `?XTransformPort=` query)
- SQLite + Prisma (currently unused, reserved for future user data)

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

## Quick Start (in the Z.ai sandbox)

The sandbox already has:
- Next.js dev server running on port 3000
- Caddy gateway on port 81
- Z.ai config at `/etc/.z-ai-config`

You only need to start the voice-game service:

```bash
cd mini-services/voice-game
bun install
bun run dev
# → voice-game service on port 3003
```

Then open the app via the Caddy gateway (port 81), not localhost:3000 directly,
because socket.io needs `?XTransformPort=3003` to route through Caddy.

### Quick Start (outside the sandbox)

1. Clone the repo
2. `bun install` in both root and `mini-services/voice-game/`
3. Create `.env.local` (root) and `mini-services/voice-game/.env` based on `.env.example`
4. Set up an OpenAI-compatible gateway (the sandbox uses `internal-api.z.ai/v1`;
   you can use OpenAI directly, Azure OpenAI, or any OpenAI-compatible endpoint)
5. Start voice-game service: `cd mini-services/voice-game && bun run dev`
6. Start Next.js: `bun run dev`
7. Open http://localhost:3000

---

## Environment Variables

See [`.env.example`](./.env.example) for the full list. Summary:

| Variable | Used by | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | voice-game | OpenAI API key (only if calling OpenAI directly) |
| `OPENAI_LLM_MODEL` | voice-game | LLM model name (default `gpt-4o-mini`) |
| `LLM_MODEL` | voice-game | Override LLM model when using Z.ai gateway (default `glm-4-plus`) |
| `TTS_VOICE` | voice-game | TTS voice (default `tongtong`) |
| `DATABASE_URL` | Next.js | SQLite path for Prisma (currently unused) |

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
- Semaphore(2) for concurrent TTS calls
- 300ms minimum interval between TTS starts
- Exponential backoff retry (1.5s → 3s → 6s)

Under heavy load, some audio chunks may still fail and the user will see
text without audio for that sentence.

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
