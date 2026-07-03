# Founder Feedback: Quota Friction

Date: 2026-07-03
Status: actionable product feedback
Priority: P1 before next trained-tester round

## Observation

The founder naturally used all three daily plays during hands-on testing and then felt annoyed when the app blocked further use.

This is not a vanity complaint. It reveals a real operating problem:

- The core loop has enough pull that the founder wants repeated sessions.
- The current daily-limit UX turns active product care into friction.
- The app treats a caretaker like a public free user.
- This makes continued founder testing harder at exactly the moment when repeated observation is needed.

## Product Reading

Using the full quota is a positive signal. Feeling blocked afterward is a product operations problem.

For public users, scarcity can be acceptable.
For founders and trained testers, hard local blocking is harmful because it prevents debugging, latency observation, TTS fallback checks, and scenario review.

## Required Fix

Add a controlled caretaker quota path. Do not simply remove the limit.

The correct behavior:

- Public users remain under normal daily quota.
- Trained testers may receive a larger quota during scheduled test windows.
- Founder/caretaker sessions may bypass or raise quota using a server-validated token or environment-controlled allowlist.
- Caretaker usage must still be logged.
- The UI should clearly distinguish public quota from caretaker/test mode.

## Suggested Implementation

### Backend

Add environment variables:

```env
CARETAKER_TOKEN=
CARETAKER_DAILY_LIMIT=30
TRAINED_TESTER_DAILY_LIMIT=10
```

Add optional client payload on connection or `start_game`:

```ts
{ caretakerToken?: string }
```

Server behavior:

- If `CARETAKER_TOKEN` is empty, caretaker mode is disabled.
- If provided token matches, classify session as `caretaker`.
- Apply `CARETAKER_DAILY_LIMIT` instead of public `PER_IP_DAILY_LIMIT`.
- Still respect `BETA_DISABLED` unless a separate explicit emergency override is added later.
- Log `quota_tier: caretaker | tester | public` on `connected`, `game_start`, and `quota_blocked`.

### Frontend

Add a hidden caretaker activation route or query parameter for internal use only:

```txt
?caretaker=<token>
```

Frontend behavior:

- Store token in localStorage only after user explicitly visits the caretaker URL.
- Send token to server in socket auth or `start_game` payload.
- Display `CARETAKER MODE` subtly in the header when active.
- Do not show public `0/3 LEFT` copy when caretaker quota is active.
- If caretaker token is rejected, fall back to public quota and show a quiet warning.

### UX Copy

Current exhausted copy feels final and slightly frustrating for a founder:

```txt
今日免費額度已用完
明天再來，或之後解鎖更多劇情包
```

Better public copy:

```txt
今天的三段人生已用完
明天再開一盒
```

Better caretaker copy when internal access exists but quota is exhausted:

```txt
照護額度已用完
請提高 caretaker quota 或先暫停測試
```

## Acceptance Criteria

- Founder can continue controlled testing without clearing localStorage manually.
- Public users still cannot bypass quota by ordinary UI interaction.
- Quota state shown in UI matches the server quota, not only localStorage.
- Caretaker sessions appear distinctly in usage logs.
- The daily limit remains a beta fence, not a founder obstacle.

## Decision

Keep scarcity for public beta. Add keys for caretakers.

The creature should still have a fence. The caretaker should have a gate.
