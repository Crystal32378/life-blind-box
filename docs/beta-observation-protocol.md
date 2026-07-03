# Life Blind Box Beta Observation Protocol

> Status: controlled beta observation
> Owner: Crystal / Alfred
> Scope: small trained tester group only

Life Blind Box is currently approved for close observation by trained testers. It is not approved for broad public release.

## Current Classification

- Repo hygiene: passed
- Secret hygiene: passed, `.env` and keys are not tracked
- Stream safety: passed, generationId discard is present for text/audio/control events
- Server guardrails: passed, quota and kill switch are present
- Usage visibility: passed, JSONL usage logging is present
- Content safety: first layer present, regex-based
- Opening latency: benchmark passed

Known gaps:

- Interactive latency benchmark has not been completed
- TTS 429 risk remains under repeated or concurrent use
- Safety is a first-layer regex screen, not full moderation
- Voice-game service is single process

## 1. Care Manual

### Who May Test

Allowed testers:

- Crystal
- Alfred/Codex maintenance sessions
- Small invited testers who understand this is a beta
- Product reviewers explicitly asked to observe instability and latency

Not allowed yet:

- Public traffic
- Influencer or social blast traffic
- Paid acquisition traffic
- Unbounded external sharing
- Large group playtests without a live caretaker

### How To Handle The App

Before a test session:

- Confirm `BETA_DISABLED=false` only when a caretaker is watching
- Confirm `PER_IP_DAILY_LIMIT` and `GLOBAL_DAILY_CAP` are intentionally low
- Start the voice-game service before inviting testers
- Keep access limited to the current test group

During a test session:

- Watch for delayed AI responses after user speech
- Watch for missing audio chunks or text-only fallback
- Watch for repeated TTS errors or 429-like behavior
- Watch for unsafe user prompts that bypass regex safety
- Record any freeze, replay, interruption, or stale-audio behavior

After a test session:

- Turn the beta off if no caretaker remains available
- Preserve usage logs for review
- Summarize issues before changing code
- Do not widen tester access until the known gaps are reviewed

### Stop Conditions

Turn on the kill switch or stop the service if any of these occur:

- TTS failures become common enough that most turns lose audio
- AI response latency makes interaction feel broken
- Unsafe content appears in generated narration
- Stale audio or stale text appears after interruption
- Server resource use becomes unpredictable
- Testers share the URL beyond the planned group

## 2. Interactive Latency Benchmark

Opening latency is already benchmarked. The missing benchmark is the live interaction path:

user speech -> upload -> ASR -> LLM first text -> first TTS audio -> turn complete

### Metrics To Capture

For each interactive turn, record:

- `asr_latency_ms`
- `llm_first_token_ms`
- `llm_total_ms`
- `tts_first_audio_ms`
- `tts_total_ms` when available
- audio upload size
- turn number
- template category
- whether TTS failed or retried
- whether the user interrupted playback

### Minimum Test Matrix

Run at least these cases before broader beta:

| Case | Goal | Minimum Runs |
| --- | --- | --- |
| Short answer | Normal spoken input under a few seconds | 10 turns |
| Long answer | Longer spoken input near UI limit | 5 turns |
| Interruption | User speaks while audio is still playing | 10 turns |
| Repeated play | Same tester starts multiple games | 5 games |
| Two testers | Light concurrency | 2 testers, 3 games each |
| Safety turn | User attempts disallowed direction | 5 turns |

### Pass Targets For Controlled Beta

Controlled beta may continue if:

- Most turns produce first visible text within an acceptable conversational window
- First audio usually arrives soon enough that the voice-first experience still feels alive
- Interruption does not replay stale audio
- `turn_complete` and `game_over` match the current generationId
- TTS errors are occasional, visible in logs, and do not break the whole session

Controlled beta should pause if:

- Interactive latency regularly feels broken to testers
- TTS 429 causes repeated silent turns
- Stale generation events appear after interruption
- Safety fallback fails to redirect a blocked prompt

## 3. Beta Fence

### Access Fence

Keep the beta behind soft operational control:

- Low daily IP quota
- Low global daily cap
- Kill switch available at all times
- No public launch copy yet
- No paid traffic
- No app-store style claim of reliability

Recommended beta defaults:

```env
BETA_DISABLED=false
PER_IP_DAILY_LIMIT=3
GLOBAL_DAILY_CAP=30
MAX_TURNS_PER_GAME=5
MAX_AUDIO_BYTES=2097152
MAX_AUDIO_SECONDS=60
```

When no caretaker is watching:

```env
BETA_DISABLED=true
```

### TTS 429 Fence

Current protections:

- TTS semaphore
- Minimum interval between TTS starts
- Exponential retry
- Text still displays if audio fails

Next hardening candidates:

- Lower concurrency to 1 during fragile test windows
- Add per-session cooldown after repeated TTS failures
- Emit a softer UI state when audio is delayed
- Track TTS failure rate per test session
- Consider preemptive text-only fallback when rate limits spike

### Safety Fence

Current protection is first-layer regex safety plus prompt rules. Treat this as a useful screen, not a full content moderation system.

Before public beta, add one of:

- Model-based moderation on user transcript before LLM
- Model-based moderation on LLM output before TTS
- A stricter scenario taxonomy that avoids high-risk templates
- A human-reviewed prompt regression set for known unsafe directions

### Single-Process Fence

Current service is suitable for small observation only.

Before broader release, review:

- Process restart behavior
- Active game loss on restart
- Log persistence location
- Per-IP counting persistence
- Horizontal scaling plan
- Socket routing behavior behind gateway

## Caretaker Notes

This project is promising because the core loop is emotionally legible: speak, get dropped into a strange life, improvise, receive a dramatic ending. The strongest signal is not technical novelty; it is immediacy. If latency stays low and the voice performance works, the experience can feel like a tiny stage actor living in the browser.

The main danger is also clear: voice products break trust quickly when timing fails. Text chat can survive a delay. Voice drama cannot. The next serious milestone is not more features. It is proving the interactive turn feels alive under real speech, interruption, and light concurrency.

Until then, the correct posture is controlled wonder: let trained people touch it, keep the gate close, measure the creature every time it moves.
