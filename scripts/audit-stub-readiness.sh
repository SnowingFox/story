#!/usr/bin/env bash
# audit-stub-readiness.sh — Phase 完成纪律 stub 假设依赖审计
#
# 防的反模式：实施者标 `// DEFER(phase-X.Y)` 时凭印象认为依赖在 Phase X.Y，
# 没去 grep 验证。
#
# Phase 5.3 audit-4（2026-04-19）真实案例：
#   `writeTaskMetadataV2IfEnabled` 标 `// DEFER(phase-5.4)` 假设需要 5.4 helper，
#   但实际所需 API 全在 Phase 4.4 已 ship（updateSubtree / MergeMode.MergeKeepExisting /
#   V2GitStore.getRefState / createCommit）。这种"标 DEFER 就停"反模式在原有 audit
#   下完全不可见 —— audit-deferrals 只检查 marker 文本格式，audit-test-go-parity
#   只检查测试有 // Go: 注释。
#
# 本 audit 强制每个 DEFER marker 紧邻附一条 `// blocked-by: <人话解释>` 行，
# 让实施者必须主动写下"为什么 Phase X.Y 之前不能做"。审计本身不验证文本内容
# （自由文本约定 — 实施者可写任何阻塞原因），只验证行存在。把"DEFER 是空头支票"
# 这个反模式从隐式假设变成显式契约。
#
# Usage:
#   bash apps/cli/scripts/audit-stub-readiness.sh                     # 列所有 DEFER + blocked-by 状态
#   bash apps/cli/scripts/audit-stub-readiness.sh phase-X.Y           # 过滤到 phase-X.Y
#   bash apps/cli/scripts/audit-stub-readiness.sh phase-X.Y --strict  # 缺 blocked-by → exit 1
#   bash apps/cli/scripts/audit-stub-readiness.sh --strict            # 任何 marker 缺 blocked-by → exit 1
#
# 自由文本约定示例：
#   // DEFER(phase-6.x): per-agent prepareTranscript dispatch
#   // blocked-by: agent registry (Phase 6.1) + Cursor agent (Phase 6.3) not shipped
#
#   // DEFER(phase-11): replace body with LLM call
#   // blocked-by: src/strategy/summarize/* (Phase 11 subsystem not yet started)
#
# Marker 检测窗口：DEFER marker 行的下一行。即 blocked-by 必须紧跟 DEFER。
# 这避免 "blocked-by 漂在文件别处" 的混乱模式。
#
# Exit codes:
#   0 — 所有 DEFER marker 都有 blocked-by（或非 strict 模式）
#   1 — strict + 至少一个 marker 缺 blocked-by
#   2 — 用法错误
#
# 见 docs/ts-rewrite/impl/references/testing-discipline.md §9 (Phase 5.3 audit-4 复盘) 完整设计。

set -e
cd "$(git rev-parse --show-toplevel)"

TARGET="$1"
STRICT="$2"

# Allow `--strict` in first position when no target given
if [ "$TARGET" = "--strict" ]; then
	STRICT="--strict"
	TARGET=""
fi

# Find every real `// DEFER(phase-...)` marker line, output `<file>:<line>:<text>`.
# Anchors `//` to start-of-line (after only whitespace) so JSDoc references like
# `* \`// DEFER(phase-8):\` ...` (literal documentation of the marker syntax) are
# not counted as actual markers. Filters: optional `phase-X.Y` target.
list_markers() {
	if [ -n "$TARGET" ]; then
		git grep -nE "^[[:space:]]*// DEFER\\(${TARGET}" -- 'apps/cli/src/*' 2>/dev/null || true
	else
		git grep -nE "^[[:space:]]*// DEFER\\(phase-" -- 'apps/cli/src/*' 2>/dev/null || true
	fi
}

# For a given `<file>:<line>:<text>` match, check whether the very next line
# (or same line, in single-line `// foo // blocked-by: ...` cases) contains
# `// blocked-by:`. Returns 0 if blocked-by present, 1 otherwise.
has_blocked_by() {
	local file="$1"
	local lineno="$2"
	# Check same line
	local same_line
	same_line=$(sed -n "${lineno}p" "$file" 2>/dev/null || true)
	if echo "$same_line" | grep -qE "// blocked-by:"; then
		return 0
	fi
	# Check next line
	local next_lineno=$((lineno + 1))
	local next_line
	next_line=$(sed -n "${next_lineno}p" "$file" 2>/dev/null || true)
	if echo "$next_line" | grep -qE "// blocked-by:"; then
		return 0
	fi
	return 1
}

# Collect markers + status into two arrays.
declare -a HAS_BLOCKED
declare -a MISSING_BLOCKED

while IFS= read -r match; do
	[ -z "$match" ] && continue
	# Format: <file>:<line>:<text>
	file=$(echo "$match" | cut -d: -f1)
	lineno=$(echo "$match" | cut -d: -f2)
	text=$(echo "$match" | cut -d: -f3-)
	if has_blocked_by "$file" "$lineno"; then
		HAS_BLOCKED+=("$file:$lineno: $text")
	else
		MISSING_BLOCKED+=("$file:$lineno: $text")
	fi
done <<< "$(list_markers)"

# ─── Report ────────────────────────────────────────────────────────────

if [ -n "$TARGET" ]; then
	echo "=== Stub readiness audit for ${TARGET} ==="
else
	echo "=== Stub readiness audit (all DEFER markers in apps/cli/src/) ==="
fi
echo ""

TOTAL=$((${#HAS_BLOCKED[@]} + ${#MISSING_BLOCKED[@]}))
echo "Summary: $TOTAL DEFER marker(s) found, ${#HAS_BLOCKED[@]} with blocked-by, ${#MISSING_BLOCKED[@]} without"
echo ""

if [ ${#HAS_BLOCKED[@]} -gt 0 ]; then
	echo "OK — markers with // blocked-by: line:"
	for m in "${HAS_BLOCKED[@]}"; do
		echo "  + $m"
	done
	echo ""
fi

if [ ${#MISSING_BLOCKED[@]} -gt 0 ]; then
	echo "MISSING — markers without adjacent // blocked-by: line:"
	for m in "${MISSING_BLOCKED[@]}"; do
		echo "  - $m"
	done
	echo ""
	echo 'Fix: append a "// blocked-by: <human explanation>" line on the SAME or NEXT'
	echo '     line as each DEFER marker, e.g.:'
	echo ''
	echo '       // DEFER(phase-6.6): replace with agent.calculateTokenUsage'
	echo '       // blocked-by: agent registry (Phase 6.1) + Copilot agent (Phase 6.6)'
	echo ""
fi

if [ "$STRICT" = "--strict" ]; then
	if [ ${#MISSING_BLOCKED[@]} -gt 0 ]; then
		echo "Audit RED (strict): ${#MISSING_BLOCKED[@]} DEFER marker(s) missing // blocked-by:"
		exit 1
	fi
	echo "Audit GREEN (strict): every DEFER marker has // blocked-by:"
fi
