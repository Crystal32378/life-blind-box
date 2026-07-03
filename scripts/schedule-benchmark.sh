#!/bin/bash
# 4 小時後自動跑 benchmark，結果存到 /tmp/benchmark-result.json
# 然後 commit + push 到 repo

set -e
SLEEP_SECONDS=$((4 * 60 * 60))  # 4 小時
RESULT_FILE="/tmp/benchmark-result.json"
REPO_DIR="/home/z/my-project"

echo "[$(date)] Benchmark scheduled. Sleeping ${SLEEP_SECONDS}s..."
sleep $SLEEP_SECONDS

echo "[$(date)] Waking up. Running benchmark..."
cd $REPO_DIR
timeout 600 bun run scripts/benchmark-latency.ts 10 > $RESULT_FILE 2>&1
echo "[$(date)] Benchmark done. Result:"
cat $RESULT_FILE

# 把結果 commit 到 repo（用 main branch）
cd $REPO_DIR
cp $RESULT_FILE scripts/benchmark-result-latest.json
git add scripts/benchmark-result-latest.json
git commit -m "chore(benchmark): auto-run after 4h cooldown

$(cat $RESULT_FILE)" 2>&1 || echo "nothing to commit"

# Push
git push "https://Crystal32378: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@github.com/Crystal32378/life-blind-box.git" main 2>&1 | tail -3

echo "[$(date)] Done."
