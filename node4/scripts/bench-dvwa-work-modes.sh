#!/usr/bin/env bash
# DVWA three-way work-mode comparison:
#   free  — no scenario Graph (default product)
#   soft  — Graph app_assessment + delegate_preferred (prompt discipline)
#   hard  — Graph app_assessment + delegate_only (Main act tools stripped)
#
# Usage (from node4/):
#   bash scripts/bench-dvwa-work-modes.sh
#   DVWA_URL=http://127.0.0.1:8080 MODES="free soft hard" bash scripts/bench-dvwa-work-modes.sh
#
# Scores into OUT/compare.json via score-dvwa-work-modes.py (findings + tool mix).
set -euo pipefail

export PATH="${HOME}/.nvm/versions/node/v22.23.1/bin:/usr/local/bin:${PATH}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

set -a
# shellcheck disable=SC1091
[ -f ../node2/.env ] && . ../node2/.env
[ -f .env ] && . .env
set +a

export PI_MODEL_PROVIDER="${PI_MODEL_PROVIDER:-deepseek}"
export PI_MODEL="${PI_MODEL:-deepseek-v4-flash}"
# Product-like: outer continues off unless lab opts in
export NODE4_MAX_CONTINUES="${NODE4_MAX_CONTINUES:-0}"
export NODE4_MAX_EMPTY_STOPS="${NODE4_MAX_EMPTY_STOPS:-0}"
export NODE4_MAX_PREMATURE_STOPS="${NODE4_MAX_PREMATURE_STOPS:-0}"
export NODE4_MAX_GOAL_CONTINUES="${NODE4_MAX_GOAL_CONTINUES:-0}"
export PI_AGENT_DIR="${PI_AGENT_DIR:-$ROOT/.pi-agent}"

DVWA_URL="${DVWA_URL:-http://127.0.0.1:8080}"
# Accept free|hard (soft is lab-only via NODE4_GRAPH_MAIN_ACT=soft, not default)
MODES="${MODES:-hard}"
STAMP="${STAMP:-$(date +%Y%m%d-%H%M%S)}"
OUT="${NODE4_WORKSPACE:-$ROOT/workspace/bench-dvwa-modes}/$STAMP"
mkdir -p "$OUT"

echo "=== DVWA work-mode bench ==="
echo "out=$OUT"
echo "target=$DVWA_URL"
echo "model=$PI_MODEL_PROVIDER/$PI_MODEL"
echo "modes=$MODES"

# Preflight DVWA
if ! curl -sf -o /dev/null --connect-timeout 3 "$DVWA_URL/login.php" 2>/dev/null \
  && ! curl -sf -o /dev/null --connect-timeout 3 "$DVWA_URL/" 2>/dev/null; then
  echo "ERROR: DVWA not reachable at $DVWA_URL" >&2
  echo "Start DVWA or set DVWA_URL=" >&2
  exit 2
fi

npx tsx src/expert-cli.ts install pentest >/dev/null 2>&1 || true

INSTR="$OUT/instruction-dvwa.txt"
cat >"$INSTR" <<EOF
授权安全测试目标（本地靶场，仅本环境）：${DVWA_URL}

应用：DVWA（Damn Vulnerable Web Application）。
默认账号若未改：admin / password。Security Level 请尽量设为 Low 开始测。

任务目标（按优先级）：
1）登录并摸清各漏洞模块入口（SQL Injection、Blind SQLi、XSS reflected/stored、CSRF、File Upload、File Inclusion、Command Injection、Brute Force 等实际出现的模块）。
2）对每个可达模块做可验证利用，拿到明确证据（响应片段、命令输出等），不要只写“可能存在”。
3）每个确认的漏洞用 finding(confirm) 并附 proof= 引用真实工具输出入账。
4）结束时简要列出：已确认发现、未完成项。

约束：
- 仅测试上述目标，不要扫外网、不要 DoS。
- 以可复现利用为准。
EOF

run_mode() {
  local mode="$1"
  local task_id="dvwa-${mode}-${STAMP}"
  local log="$OUT/${mode}.log"
  local extra=()
  # Always re-enter repo root (free run can leave shell cwd invalid on some mounts)
  cd "$ROOT" || {
    echo "ERROR: cannot cd ROOT=$ROOT" >&2
    return 1
  }

  case "$mode" in
    free)
      # Default product: pentest pack, no graph
      extra=(--engagement pentest --graph-id free)
      unset NODE4_GRAPH_MAIN_ACT || true
      ;;
    soft)
      extra=(--engagement pentest --graph-id app_assessment --graph-main-act soft)
      export NODE4_GRAPH_MAIN_ACT=delegate_preferred
      ;;
    hard)
      extra=(--engagement pentest --graph-id app_assessment --graph-main-act hard)
      export NODE4_GRAPH_MAIN_ACT=delegate_only
      ;;
    *)
      echo "unknown mode: $mode" >&2
      return 1
      ;;
  esac

  echo "[$(date -Iseconds)] START mode=$mode task=$task_id" | tee -a "$OUT/master.log"
  set +e
  # Prefer local tsx binary over npx (avoids npm uv_cwd failures after long docker runs)
  if [ -x "$ROOT/node_modules/.bin/tsx" ]; then
    "$ROOT/node_modules/.bin/tsx" src/standalone.ts \
      --task-id "$task_id" \
      --target "$DVWA_URL" \
      --scope "127.0.0.1,localhost,host.docker.internal" \
      --instruction-file "$INSTR" \
      --output "$OUT" \
      "${extra[@]}" \
      >"$log" 2>&1
  else
    npx tsx src/standalone.ts \
      --task-id "$task_id" \
      --target "$DVWA_URL" \
      --scope "127.0.0.1,localhost,host.docker.internal" \
      --instruction-file "$INSTR" \
      --output "$OUT" \
      "${extra[@]}" \
      >"$log" 2>&1
  fi
  local code=$?
  set -e
  cd "$ROOT" || true
  echo "[$(date -Iseconds)] END mode=$mode exit=$code" | tee -a "$OUT/master.log"
  return 0
}

for m in $MODES; do
  run_mode "$m" || true
done

# Score
python3 "$ROOT/scripts/score-dvwa-work-modes.py" "$OUT" | tee "$OUT/compare-summary.txt"
echo "$OUT" >"$ROOT/workspace/bench-dvwa-modes/LATEST"
echo "ALL_DONE out=$OUT"
echo "See $OUT/compare.json and compare-summary.txt"
