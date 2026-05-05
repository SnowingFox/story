/**
 * Aggregate registration for Story's core (non-business) commands.
 *
 * Call once from `src/cli.ts::buildCli()` after
 * {@link ../cli/help::setupHelpOverride} and
 * {@link ../cli/flags::registerGlobalFlags} so cac sees the help
 * override + global flags before each command's flags are attached.
 */

import type { CAC } from 'cac';
import { registerAttachCommand } from '@/commands/attach';
import { registerCleanCommand } from '@/commands/clean';
import { registerCompletionCommand } from '@/commands/completion';
import { registerConfigureCommand } from '@/commands/configure';
import { registerDisableCommand } from '@/commands/disable';
import { registerDoctorCommand } from '@/commands/doctor';
import { registerEnableCommand } from '@/commands/enable';
import { registerExplainCommand } from '@/commands/explain';
import { registerHelpCommand } from '@/commands/help';
import { registerMigrateCommand } from '@/commands/migrate';
import { registerResumeCommand } from '@/commands/resume';
import { registerRewindCommand } from '@/commands/rewind';
import { registerSessionsCommand } from '@/commands/sessions';
import { registerStatusCommand } from '@/commands/status';
import { registerTraceCommand } from '@/commands/trace';
import { registerVersionCommand } from '@/commands/version';

/**
 * Register the user-facing Phase 9.0 through 9.6 commands.
 * See each phase's `impl.md` for the full list — roughly: `version` /
 * `help` (9.0), `enable` / `disable` / `configure` (9.1), `status` /
 * `sessions …` (9.2), `rewind` (9.3), `explain` / `resume` / `attach`
 * (9.4), `clean` / `doctor` (9.5), `migrate` / `trace` / `completion`
 * (9.6).
 *
 * @example
 * const cli = cac('story');
 * setupHelpOverride(cli);
 * registerGlobalFlags(cli);
 * registerCoreCommands(cli);
 * // Every first-release user-facing command is now resolvable.
 */
export function registerCoreCommands(cli: CAC): void {
	registerVersionCommand(cli);
	registerHelpCommand(cli);
	registerEnableCommand(cli);
	registerDisableCommand(cli);
	registerConfigureCommand(cli);
	registerStatusCommand(cli);
	registerSessionsCommand(cli);
	registerRewindCommand(cli);
	registerExplainCommand(cli);
	registerResumeCommand(cli);
	registerAttachCommand(cli);
	registerCleanCommand(cli);
	registerDoctorCommand(cli);
	registerMigrateCommand(cli);
	registerTraceCommand(cli);
	registerCompletionCommand(cli);
}
