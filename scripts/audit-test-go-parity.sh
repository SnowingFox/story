#!/usr/bin/env bash
# audit-test-go-parity.sh — Phase 测试纪律 grep 套件
#
# 强制 testing-discipline.md §5 的「测试反向 audit」可执行 / 可 gate：
# 检查 src/<dir>/*.ts 中每个声明 "Mirrors Go" 的 export function 是否在
# tests/unit/<dir>/*.test.ts 中有 `// Go: <go-file>:<line>` 溯源注释。
#
# 灵感来源：Phase 5.1 复盘 — 25 个 Go 对齐 bug 在测试全绿 + 91% coverage 下
# 藏住，因为测试都基于 TS 实施者推断（不是 Go 实测）。详见
# [testing-discipline.md §1](docs/ts-rewrite/impl/references/testing-discipline.md)。
#
# Usage:
#   bash apps/cli/scripts/audit-test-go-parity.sh <src-dir> [test-dir]
#   bash apps/cli/scripts/audit-test-go-parity.sh <src-dir> [test-dir] --strict
#
# Examples:
#   bash apps/cli/scripts/audit-test-go-parity.sh apps/cli/src/strategy
#   bash apps/cli/scripts/audit-test-go-parity.sh apps/cli/src/strategy apps/cli/tests/unit/strategy --strict
#   bash apps/cli/scripts/audit-test-go-parity.sh apps/cli/src/checkpoint
#
# 默认 test-dir = "apps/cli/tests/unit/$(basename src-dir)".
#
# Exit codes:
#   0 — all src files with `Mirrors Go` JSDoc have ≥1 `// Go:` test annotation
#   1 — strict mode + audit failed
#
# See docs/ts-rewrite/impl/references/testing-discipline.md §5 for the full audit.

set -e
cd "$(git rev-parse --show-toplevel)"

SRC_DIR="$1"
TEST_DIR="$2"
STRICT="${3:-}"

# Allow the strict flag in second position when test-dir defaults
if [ "$TEST_DIR" = "--strict" ]; then
	STRICT="--strict"
	TEST_DIR=""
fi

if [ -z "$SRC_DIR" ]; then
	echo "Usage: bash apps/cli/scripts/audit-test-go-parity.sh <src-dir> [test-dir] [--strict]"
	echo ""
	echo "Examples:"
	echo "  bash apps/cli/scripts/audit-test-go-parity.sh apps/cli/src/strategy"
	echo "  bash apps/cli/scripts/audit-test-go-parity.sh apps/cli/src/strategy apps/cli/tests/unit/strategy --strict"
	exit 2
fi

if [ -z "$TEST_DIR" ]; then
	TEST_DIR="apps/cli/tests/unit/$(basename "$SRC_DIR")"
fi

if [ ! -d "$SRC_DIR" ]; then
	echo "FAIL: src-dir '$SRC_DIR' does not exist"
	exit 2
fi
if [ ! -d "$TEST_DIR" ]; then
	echo "FAIL: test-dir '$TEST_DIR' does not exist"
	exit 2
fi

echo "=== Test-Go-parity audit: $SRC_DIR vs $TEST_DIR ==="
echo ""

# ─── Check 1: file-level pairing ─────────────────────────────────────────────
# Every src file with `Mirrors Go ` in JSDoc must have a corresponding test
# file with ≥1 `// Go:` annotation pointing at the *same* Go file.

declare -a MISSING_TEST_FILES
declare -a TESTS_WITHOUT_GO_REF
declare -a TESTS_WITH_WRONG_GO_REF

ALL_GO_REFS=0
ALL_SRC_FILES=0
ALL_SRC_WITH_GO=0

for src_file in "$SRC_DIR"/*.ts; do
	[ -f "$src_file" ] || continue
	ALL_SRC_FILES=$((ALL_SRC_FILES + 1))

	src_basename=$(basename "$src_file" .ts)
	test_file="$TEST_DIR/${src_basename}.test.ts"

	# Extract `Mirrors Go <go-file>` references from src file's JSDoc
	go_refs_in_src=$(grep -oE 'Mirrors Go `?[a-zA-Z_/.-]+\.go' "$src_file" 2>/dev/null \
		| sed -E 's/^Mirrors Go `?//' | sort -u || true)

	if [ -z "$go_refs_in_src" ]; then
		continue
	fi

	ALL_SRC_WITH_GO=$((ALL_SRC_WITH_GO + 1))

	if [ ! -f "$test_file" ]; then
		MISSING_TEST_FILES+=("$src_file (claims to mirror Go but no test file at $test_file)")
		continue
	fi

	# Count `// Go:` annotations in the test file
	go_annotations=$(grep -cE '// Go: ' "$test_file" 2>/dev/null || echo 0)
	go_annotations=${go_annotations//[^0-9]/}
	ALL_GO_REFS=$((ALL_GO_REFS + go_annotations))

	if [ "$go_annotations" -eq 0 ]; then
		TESTS_WITHOUT_GO_REF+=("$test_file (src claims Go parity but test has 0 // Go: annotations)")
		continue
	fi

	# Cross-check: each Go file referenced by src JSDoc should appear in at
	# least one `// Go:` annotation. Accept either the impl file (e.g.
	# `common.go`) OR its test counterpart (`common_test.go`) — Go-aligned
	# test ports often point at the Go test file rather than the impl.
	# Dedupe to avoid noise when src references the same Go file twice.
	while IFS= read -r ref; do
		[ -z "$ref" ] && continue
		ref_basename=$(basename "$ref")
		ref_stem="${ref_basename%.go}"   # strip .go suffix
		# Match either `<stem>.go` OR `<stem>_test.go` — both are valid
		# Go-source references. Use ERE so the (...) grouping works.
		if ! grep -qE "// Go: .*${ref_stem}(_test)?\\.go" "$test_file" 2>/dev/null; then
			# Dedupe: only report each (test_file, ref_basename) pair once
			pair="$test_file:$ref_basename"
			already_reported=false
			for existing in "${TESTS_WITH_WRONG_GO_REF[@]}"; do
				if [[ "$existing" == *"$test_file missing reference to $ref_basename"* ]]; then
					already_reported=true
					break
				fi
			done
			if [ "$already_reported" = false ]; then
				TESTS_WITH_WRONG_GO_REF+=("$test_file missing reference to $ref_basename (or ${ref_stem}_test.go)")
			fi
		fi
	done <<< "$go_refs_in_src"
done

# ─── Report ──────────────────────────────────────────────────────────────────

echo "Summary:"
echo "  src files scanned: $ALL_SRC_FILES"
echo "  src files claiming 'Mirrors Go ...': $ALL_SRC_WITH_GO"
echo "  total // Go: annotations in tests: $ALL_GO_REFS"
echo ""

FAILS=0

if [ ${#MISSING_TEST_FILES[@]} -gt 0 ]; then
	echo "FAIL — src files with 'Mirrors Go' JSDoc but no test file:"
	for f in "${MISSING_TEST_FILES[@]}"; do
		echo "  - $f"
	done
	echo ""
	FAILS=$((FAILS + ${#MISSING_TEST_FILES[@]}))
fi

if [ ${#TESTS_WITHOUT_GO_REF[@]} -gt 0 ]; then
	echo "FAIL — test files exist but have 0 // Go: annotations:"
	for f in "${TESTS_WITHOUT_GO_REF[@]}"; do
		echo "  - $f"
	done
	echo ""
	FAILS=$((FAILS + ${#TESTS_WITHOUT_GO_REF[@]}))
fi

if [ ${#TESTS_WITH_WRONG_GO_REF[@]} -gt 0 ]; then
	echo "WARN — test files missing reference to a Go file the src declares it mirrors:"
	for f in "${TESTS_WITH_WRONG_GO_REF[@]}"; do
		echo "  - $f"
	done
	echo ""
fi

# Coverage ratio: total // Go: annotations should be ≥ total src files claiming Go parity
RATIO_OK=true
if [ "$ALL_SRC_WITH_GO" -gt 0 ] && [ "$ALL_GO_REFS" -lt "$ALL_SRC_WITH_GO" ]; then
	echo "WARN — annotation count ($ALL_GO_REFS) < src-with-Go-claim count ($ALL_SRC_WITH_GO)"
	echo "       Each src file with 'Mirrors Go' JSDoc should have multiple // Go: tests."
	echo ""
	RATIO_OK=false
fi

if [ "$FAILS" -gt 0 ]; then
	echo "Audit RED: $FAILS pairing failure(s)."
	echo ""
	echo "Fix by:"
	echo "  1. Open the Go source file referenced by the src JSDoc"
	echo "  2. Read 5 minutes — note inputs / outputs / error paths"
	echo "  3. Add tests with '// Go: <go-file>:<line> <TestName>' annotation"
	echo "  4. See docs/ts-rewrite/impl/references/testing-discipline.md §3 (templates)"
	if [ "$STRICT" = "--strict" ]; then
		exit 1
	fi
	exit 0
fi

if [ "$RATIO_OK" = false ]; then
	echo "Audit YELLOW: structural coverage OK but annotation density low."
	echo "Consider whether each src function has at least one Go-parity test."
	exit 0
fi

echo "Audit GREEN: every Go-mirroring src file has Go-aligned test coverage."
