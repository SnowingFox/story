/**
 * SubagentStart handler — fires when the main agent spawns a subagent
 * (claude-code `pre-task`). Captures a per-tool-use pre-task snapshot so
 * the paired `SubagentEnd` handler can diff the file set that changed
 * during the subagent task.
 *
 * Mirrors Go `cmd/entire/cli/lifecycle.go`
 * (`handleLifecycleSubagentStart`).
 *
 * @packageDocumentation
 */

import type { Event } from '@/agent/event';
import type { Agent } from '@/agent/interfaces';
import * as log from '@/log';
import { capturePreTaskState } from '../pre-task-state';

/**
 * Capture the pre-task state for a new subagent invocation (Task tool).
 *
 * Non-fail-open: `capturePreTaskState` rejection is wrapped and re-thrown
 * so the hook returns non-zero. `SubagentEnd` depends on the snapshot to
 * compute `untrackedFiles` + `modifiedFiles`; silently swallowing the
 * failure here would produce a ghost subagent-task checkpoint at the
 * paired `SubagentEnd`.
 *
 * @throws Error('failed to capture pre-task state: ...') when the snapshot
 *   write fails. The wrapping `Error` carries the original cause via the
 *   `cause` option (Node 16.9+ standard) so `errors.Is`-style inspection
 *   remains possible (equivalent to Go's `fmt.Errorf %w`).
 *
 * @example
 * await handleSubagentStart(claudeAgent, {
 *   type: 'SubagentStart',
 *   sessionId: 'sid-1',
 *   toolUseId: 'toolu_abc',
 *   sessionRef: '/path/transcript.jsonl',
 *   // ...zero-value other fields
 * } as Event);
 *
 * // Side effects:
 * //   <repoRoot>/.story/tmp/pre-task-toolu_abc.json ← new JSON (mode 0o600)
 * //   stdout / Git refs / HEAD / worktree / index: unchanged
 */
export async function handleSubagentStart(ag: Agent, event: Event): Promise<void> {
	const logCtx = { component: 'lifecycle', hook: 'subagent-start', agent: ag.name() };
	// Go parity: `lifecycle.go` logs `slog.String("event", event.Type.String())`
	// alongside session / tool / transcript. Review 2 found the TS version
	// was missing this first key, breaking structured-log correlation.
	log.info(logCtx, 'subagent started', {
		event: event.type,
		sessionId: event.sessionId,
		toolUseId: event.toolUseId,
		transcript: event.sessionRef,
	});

	try {
		await capturePreTaskState(event.toolUseId);
	} catch (err) {
		throw new Error(`failed to capture pre-task state: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}
}
