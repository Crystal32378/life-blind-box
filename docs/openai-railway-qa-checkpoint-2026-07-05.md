# OpenAI Railway QA Checkpoint

Date: 2026-07-05
Status: checkpoint safe in cage
Canonical checkpoint commit: `1b849d0`
Branch: `fix-alpha-p0-recovery`
Current test URL: https://frontend-production-9b60.up.railway.app/

## Purpose

This note prevents future agent confusion between:

- the GitHub canonical repo
- imported local workspace archives
- Railway running deployment state
- recorded bug evidence that still needs re-test
- historical Z.ai preview links versus the current Railway test link

Do not treat this checkpoint as a clean product pass. It is a major stability checkpoint with one known remaining bug.

## 1. Branch And Commit

| Item | Value |
| --- | --- |
| Branch | `fix-alpha-p0-recovery` |
| Commit hash | `1b849d0` |
| Commit message | `fix(openai-client+ending-timing): graceful z.ai degradation + wait TTS before game_over` |
| GitHub remote | `1b849d0`, confirmed matching local |

## 2. Railway Running Commit

| Service | Status | Commit |
| --- | --- | --- |
| voice-game | SUCCESS | `1b849d0` |
| frontend | SUCCESS | same branch |
| three-body-game | SUCCESS | separate repo |

Railway running commit equals GitHub commit equals `1b849d0`.

Current Railway frontend test URL:

```txt
https://frontend-production-9b60.up.railway.app/
```

Historical Z.ai preview URLs should be treated as evidence context only unless Crystal explicitly says to test them again.

## 3. Changed Files In Commit `1b849d0`

```txt
mini-services/voice-game/index.ts         | 15 +++++++++++++--
mini-services/voice-game/openai-client.ts | 28 ++++++++++++++--------------
2 files changed, 27 insertions(+), 16 deletions(-)
```

## 4. Secret Hygiene

`.gitignore` confirmed to exclude:

```txt
.env
.env.local
.env.production
.env.*.local
.z-ai-config
node_modules
*.log
usage*.jsonl
```

Commit `1b849d0` scan found no committed secrets:

- no `OPENAI_API_KEY=sk-...`
- no `FOUNDER_TOKEN=<hex>`
- no `ghp_` GitHub PAT
- no Railway token
- no `.env` file

## 5. Public Repo Boundary

`voice-microdrama-engine` was not in the workspace and was not touched.

## 6. Included Fix Stack

| Fix | Commit | Status |
| --- | --- | --- |
| P0 quota refund + founder mode + LLM fallback | `3a75db8` | Done |
| Audio queue fix | `01c093f` | Done |
| META/ending parser fix | `b31f536` | Done |
| Postgame audio fix | `0babc86` | Done |
| Hard-gated C, turn 5/5 only | `55708fe` | Done |
| ASR circuit breaker | `bb60823` | Done |
| OpenAI providers, ASR + LLM + TTS | `0bc951f` | Done |
| openai-client graceful degradation | `1b849d0` | Done |
| Ending-timing fix | `1b849d0` | Partial, Bug E remains |

## 7. Current Product State

Major progress confirmed:

- moved from unstable sandbox behavior to Railway stable environment
- moved from Z.ai TTS 429 risk toward OpenAI-controlled credits
- moved from stuck around turn 2 or 3 to reaching turn 5
- founder mode, quota refund, and circuit breaker are present
- OpenAI `fable` male voice is clear and dramatic enough for controlled beta observation

## 8. Known Remaining Bug

### Bug E: ending card appears before final voice finishes

Observed behavior:

- Game can reach turn 5.
- Ending card still appears early and interrupts the fifth-turn narration payoff.

Current interpretation:

- The `1b849d0` ending-timing fix added backend wait behavior, including TTS wait and a short delay.
- The fix is not complete.
- A likely remaining cause is frontend behavior: the UI may switch to the ending card when it receives `turn_complete` with `isEnding=true`, before final audio playback is fully drained.

Next likely fix:

- Add a frontend final-narration state or client-side audio-drain gate before rendering the ending card.
- Ensure `game_over` / ending-card presentation lands after the final spoken story finishes.

## 9. Agent Instructions

Future agents should treat this as the latest engineering checkpoint, not as final QA pass.

Use these rules:

- GitHub repo remains canonical.
- Current test URL is `https://frontend-production-9b60.up.railway.app/`.
- Do not use older Z.ai preview links as the active test target unless Crystal explicitly asks.
- Do not commit imported tar archives or extracted `imported-workspaces` folders.
- Preserve `docs/bug-triage-2026-07-04-recorded-flow-bugs.md` as evidence history.
- Do not mark Bug E fixed until re-tested after the frontend sequencing fix.
- Do not call the 2026-07-05 evening recording a clean pass, because final voice/card sequencing still failed.
- Next implementation should focus on Bug E, not re-opening already completed checkpoint work unless new evidence requires it.

## Bottom Line

Small creature is safely in cage at checkpoint `1b849d0`.

It can reach turn 5 and speak with a usable OpenAI `fable` voice. The remaining product blocker is final-turn ending-card timing.
