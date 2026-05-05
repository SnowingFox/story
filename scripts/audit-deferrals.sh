#!/usr/bin/env bash
# audit-deferrals.sh — Phase 完成纪律 grep 套件
#
# Usage:
#   bash apps/cli/scripts/audit-deferrals.sh                   # list all forward markers in apps/cli/src/
#   bash apps/cli/scripts/audit-deferrals.sh phase-X.Y         # also show markers targeting phase-X.Y
#   bash apps/cli/scripts/audit-deferrals.sh phase-X.Y --strict  # exit 1 if phase-X.Y still has unresolved markers
#
# See docs/ts-rewrite/impl/references/phase-completion-discipline.md for the full protocol.

set -e
cd "$(git rev-parse --show-toplevel)"

TARGET="$1"
STRICT="$2"

list_all() {
	echo "=== All forward deferral markers in apps/cli/src/ ==="
	# git grep returns 1 when no match; that's not an error for us.
	{
		git grep -nF "throw NOT_IMPLEMENTED(" -- 'apps/cli/src/*' || true
		git grep -n  "DEFER(phase-" -- 'apps/cli/src/*' || true
		git grep -n  "TODO(phase-" -- 'apps/cli/src/*' || true
	} | sort -u
}

list_for_target() {
	local target_dot
	target_dot="${TARGET#phase-}"   # e.g. "4.2"
	echo ""
	echo "=== Markers targeting ${TARGET} (Phase ${target_dot}) ==="
	{
		# Phase 5.1 onwards: descriptive stubs use the form
		#   throw NOT_IMPLEMENTED('Phase 5.X: <method> — see <go-file>:<line>')
		# so we match the prefix `'Phase 5.X` without requiring the closing `')`.
		# Pre-5.1 terse form (`'Phase 5.X')`) still matches this prefix.
		git grep -nF "throw NOT_IMPLEMENTED('Phase ${target_dot}" -- 'apps/cli/src/*' || true
		git grep -n  "DEFER(${TARGET}" -- 'apps/cli/src/*' || true
		git grep -n  "TODO(${TARGET}" -- 'apps/cli/src/*' || true
	} | sort -u
}

assert_strict() {
	local target_dot
	target_dot="${TARGET#phase-}"
	echo ""
	echo "=== STRICT: assert no unresolved markers for ${TARGET} ==="
	local hits
	hits=$({
		git grep -nF "throw NOT_IMPLEMENTED('Phase ${target_dot}" -- 'apps/cli/src/*' || true
		git grep -n  "DEFER(${TARGET}"  -- 'apps/cli/src/*' || true
		git grep -n  "TODO(${TARGET}"   -- 'apps/cli/src/*' || true
	} | sort -u)
	if [ -n "$hits" ]; then
		echo "FAIL: unresolved markers for ${TARGET}:"
		echo "$hits"
		exit 1
	fi
	echo "OK: no unresolved markers for ${TARGET}"
}

list_all

if [ -n "$TARGET" ]; then
	list_for_target
	if [ "$STRICT" = "--strict" ]; then
		assert_strict
	fi
fi
