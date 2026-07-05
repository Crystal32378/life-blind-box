# Life Blind Box Bug Triage: Recorded Flow Bugs

Date: 2026-07-04
Last updated: 2026-07-05
Source thread: `019f2aee-2354-7b73-ac95-eb76a6299bce`
Status: active bug triage
Priority: P0/P1 before broader trained-tester expansion

## Preview Under Test

https://preview-chat-ee6d98a4-ca67-4526-b626-44c9cb958846.space-z.ai/

## Test Environment

- Mac + Chrome
- macOS built-in screen recording
- Recording flow confirmed:
  - `Command + Shift + 5` to start recording
  - Microphone set to MacBook microphone
  - `Command + Control + Esc` to stop recording
- If the recording frame remains visible, use `killall screencaptureui` to clear the macOS screenshot/recording UI residue.

## Evidence Files

Do not rename, move, compress, or transform these original video files unless Crystal explicitly asks for archival work.

### Evidence 1: Early Ending After Turn 4

Delegated path:

```txt
/Users/crystalchang/Desktop/螢幕錄影 2026-07-04 中午12.26.40.mov
```

Delegated metadata:

- Approximate size: 131 MB
- Approximate duration: 3 minutes 44 seconds
- Format: QuickTime `.mov`
- Video track present
- Audio track present, AAC/mp4a

Evidence content:

- The game entered `THE END` after turn 4 instead of progressing into turn 5.
- The screen showed `TURN 4/5 · 5/5 LEFT`, but an ending card was already displayed.
- Ending card title: `天台求婚`.

Current local re-check note:

- The exact delegated path was not found during this Life Blind Box handoff pass.
- Keep this evidence item in triage because it was already reviewed in the source thread, but re-confirm the local file path before any archival or export work.

### Evidence 2: Stuck On Turn 3

Delegated path:

```txt
/Users/crystalchang/Desktop/螢幕錄影 2026-07-04 下午1.13.36.mov
```

Delegated metadata:

- Approximate size: 165 MB
- Approximate duration: 4 minutes 42 seconds
- Format: QuickTime `.mov`
- Video track present
- Audio track present, AAC/mp4a

Current local re-check note:

- File exists at the delegated Desktop path during this Life Blind Box handoff pass.

Evidence content:

- The game became stuck at turn 3.
- The flow did not progress normally.

### Evidence 3: Stuck On Turn 2

New path:

```txt
/Users/crystalchang/Desktop/螢幕錄影 2026-07-05 下午5.49.23.mov
```

Local re-check metadata:

- File exists at the delegated Desktop path during the 2026-07-05 Life Blind Box pass.
- File size: 2,768,883 bytes, approximately 2.64 MB.
- File timestamp: 2026-07-05 17:49:37 local time.
- Original video was not renamed, moved, compressed, or transformed.

Evidence content:

- Crystal reported the game stuck on turn 2 during a new small-creature test.
- This expands the stuck-flow bug line from a single turn-3 case into a broader early-turn progression stability issue.

## Important Correction

Do not record the earlier `third successful run` as a successful completion.

Crystal corrected the interpretation: that run ended after turn 4 and jumped into an ending card early. It is a bug, not a pass.

## Formal Bug Lines

### 1. Early End Condition At Turn 4

Expected behavior:

- Rounds 1-3 must not end.
- Round 4 may only end if product rules intentionally allow it.
- If current product expectation is to reach turn 5, the app should not show `THE END` immediately after turn 4.
- UI turn counter, backend turn count, and LLM ending policy must agree.

Observed behavior:

- The app displayed `THE END` after turn 4.
- The UI still showed `TURN 4/5`.
- The ending card appeared before a visible turn 5.

Likely areas to inspect:

- `MAX_TURNS` and `allowEnding` logic in `mini-services/voice-game/index.ts`
- Prompt rule that allows optional ending on round 4
- Whether frontend `turn` is one behind backend `turnCount`
- Whether `game_over` is emitted before the UI receives or renders the expected final turn state
- Whether stale generation events can still produce an ending card despite discard checks

### 2. Early-Turn Stuck State

Expected behavior:

- After player speech is submitted, the app should move through ASR, LLM text, optional TTS audio, and `turn_complete`.
- If a provider fails, the app should show a recoverable subtitle/text-only fallback, not remain stuck.
- Turns 2 and 3 should both resolve into a visible next state without requiring reload or manual reset.

Observed behavior:

- A 2026-07-04 recording shows the game stuck at turn 3.
- A 2026-07-05 recording shows the game stuck at turn 2.
- The stuck state is therefore not isolated to a single late-game turn.

Likely areas to inspect:

- ASR failure path and empty transcript handling
- TTS circuit breaker and text-only fallback path
- `turn_complete` emission timing relative to TTS background tasks
- Frontend phase transitions for `recording`, `transcribing`, `narrating`, and `idle`
- Socket disconnect/reconnect handling
- Whether an error event was discarded due to generationId mismatch
- Whether `currentGenerationIdRef` can advance while the visible UI still waits on an older turn
- Whether `setPhaseSafe('idle')` is skipped when LLM/TTS/provider logic throws after partial output

### 3. Intermittent Voice / Audio Observation

Status: secondary observation

Earlier testing began with intermittent voice/audio behavior, but current strongest evidence points to flow stability bugs.

Keep voice/audio instability in the observation log, but prioritize:

1. early ending after turn 4
2. early-turn stuck state on turn 2 or turn 3
3. only then TTS/audio intermittency as contributing evidence

## Suggested Investigation Order

1. Reproduce with logging enabled for one full session.
2. Capture per-event timeline:
   - `start_game`
   - `turn_start`
   - `status`
   - `user_text`
   - `text_chunk`
   - `audio_chunk`
   - `tts_status`
   - `tts_error`
   - `turn_complete`
   - `game_over`
   - `error_msg`
3. Compare backend `game.turnCount` against frontend `turn` after every event.
4. Decide whether round 4 ending is allowed for this product phase. If not, remove or gate `allowEnding` before turn 5.
5. Ensure stuck paths always emit either `turn_complete`, a recoverable error, or a visible text-only fallback.
6. Confirm stale generation events cannot end a newer or still-running game.
7. For turn-2 and turn-3 stuck cases, inspect whether the failure happens before ASR result, after ASR result, during LLM stream, during TTS background work, or during frontend phase reset.

## Proposed Issue Drafts

### Issue A: Game can enter THE END after turn 4 while UI shows TURN 4/5

Priority: P0

Evidence: `/Users/crystalchang/Desktop/螢幕錄影 2026-07-04 中午12.26.40.mov` once path is re-confirmed.

Summary:
The game showed an ending card titled `天台求婚` after turn 4. The UI still indicated `TURN 4/5`, so the game flow ended earlier than the visible turn contract implied.

Acceptance criteria:

- Backend ending rules match the visible turn contract.
- If the UI says `TURN 4/5`, the game does not show `THE END` unless round 4 ending is explicitly intended and clearly represented.
- `game_over` events are generation-safe and turn-consistent.

### Issue B: Game can get stuck on early turns without normal progression

Priority: P0/P1

Evidence:

- `/Users/crystalchang/Desktop/螢幕錄影 2026-07-04 下午1.13.36.mov`
- `/Users/crystalchang/Desktop/螢幕錄影 2026-07-05 下午5.49.23.mov`

Summary:
Recorded sessions show the game can get stuck on turn 3 and turn 2. The player cannot complete the normal flow, and the failure is not limited to one specific turn count.

Acceptance criteria:

- Every submitted audio turn resolves into a visible next state.
- Provider failures trigger a recoverable user-visible fallback.
- The app does not remain indefinitely in a stuck recording/transcribing/narrating state.
- The UI exposes enough status to tell whether it is waiting on ASR, LLM, TTS, reconnect, or fallback.

## Custody Notes

- Preserve the original recordings as evidence.
- Do not modify the video files.
- Do not mark the 2026-07-04 test as pass.
- Do not mark the 2026-07-05 turn-2 stuck test as pass.
- This triage note is for bug routing and project memory, not final root-cause analysis.
