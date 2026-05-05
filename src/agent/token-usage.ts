/**
 * Framework-side token usage dispatcher. Prefers {@link SubagentAwareExtractor}
 * (includes subagent tokens) over {@link TokenCalculator} (main transcript
 * only). Returns `null` when the agent doesn't support either calculation.
 *
 * Errors are debug-logged because callers treat `null` as "no data available"
 * and the framework cannot distinguish an error from genuinely missing data.
 *
 * Mirrors Go `cmd/entire/cli/agent/token_usage.go`.
 *
 * @packageDocumentation
 */

import * as log from '@/log';
import { asSubagentAwareExtractor, asTokenCalculator } from './capabilities';
import type { Agent } from './interfaces';
import type { TokenUsage } from './session';

/**
 * Compute token usage for an agent's transcript. Returns `null` for
 * unsupported agents OR on calculation error (debug-logged).
 *
 * **Dispatch order** (matches Go):
 * 1. {@link asSubagentAwareExtractor} → calls `calculateTotalTokenUsage`
 * 2. {@link asTokenCalculator} → calls `calculateTokenUsage`
 * 3. neither → returns `null`
 *
 * @example
 * ```ts
 * await calculateTokenUsage(agent, transcript, 0, '');
 * // returns: TokenUsage { inputTokens: 100, ... } | null
 *
 * await calculateTokenUsage(null, transcript, 0, '');
 * // returns: null
 *
 * await calculateTokenUsage(agentWithoutTokenSupport, transcript, 0, '');
 * // returns: null
 *
 * // Side effects: log.debug when agent's calculation throws (otherwise none).
 * ```
 */
export async function calculateTokenUsage(
	ag: Agent | null,
	transcriptData: Uint8Array,
	transcriptLinesAtStart: number,
	subagentsDir: string,
): Promise<TokenUsage | null> {
	if (ag === null) {
		return null;
	}

	const [sae, hasSae] = asSubagentAwareExtractor(ag);
	if (hasSae) {
		try {
			return await sae.calculateTotalTokenUsage(
				transcriptData,
				transcriptLinesAtStart,
				subagentsDir,
			);
		} catch (e) {
			log.debug({ component: 'agent.token-usage' }, 'failed subagent aware token extraction', {
				error: (e as Error).message,
			});
			return null;
		}
	}

	const [calc, hasCalc] = asTokenCalculator(ag);
	if (hasCalc) {
		try {
			return await calc.calculateTokenUsage(transcriptData, transcriptLinesAtStart);
		} catch (e) {
			log.debug({ component: 'agent.token-usage' }, 'failed token extraction', {
				error: (e as Error).message,
			});
			return null;
		}
	}

	return null;
}
