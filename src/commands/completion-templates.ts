/**
 * Static shell completion script templates for `story completion <shell>`.
 *
 * Mirrors the user-visible effect of Go `cobra.CompletionOptions`
 * (cobra auto-generates at runtime); TS hand-writes because cac has no
 * equivalent introspection. Scripts cover the 18 visible Story commands
 * + the `sessions` subcommand namespace.
 *
 * **Story-side rebrand**: every literal `entire` / `_entire_` / `.entire/`
 * is replaced with `story` / `_story_` / `.story/`. Scripts explicitly
 * exclude `reset` / `trail` / `search` / `login` / `logout` (the first
 * is Go-deprecated; the other four are first-release-deferred SaaS
 * commands, see `docs/ts-rewrite/impl/references/saas-deferred-commands.md`).
 *
 * @packageDocumentation
 */

import { match } from 'ts-pattern';
import { SilentError } from '@/errors';

/** Supported shells. Matches Go's cobra auto-generation surface area. */
export type SupportedShell = 'bash' | 'zsh' | 'fish';

/** The 3 shells `story completion` will emit scripts for. */
export const SUPPORTED_SHELLS: readonly SupportedShell[] = ['bash', 'zsh', 'fish'] as const;

/** Top-level commands surfaced in every completion script (in display order). */
const TOP_LEVEL_COMMANDS: readonly { name: string; desc: string }[] = [
	{ name: 'enable', desc: 'Enable Story in this repository' },
	{ name: 'disable', desc: 'Disable or uninstall Story' },
	{ name: 'configure', desc: 'Change Story configuration for this repo' },
	{ name: 'status', desc: 'Show enablement + active session' },
	{ name: 'sessions', desc: 'Manage sessions' },
	{ name: 'rewind', desc: 'Browse checkpoints and roll back' },
	{ name: 'explain', desc: 'Explain a file or line by replaying the prompt history' },
	{ name: 'resume', desc: 'Resume a prior session on a new branch' },
	{ name: 'attach', desc: 'Attach a session to the last commit' },
	{ name: 'clean', desc: 'Clean up Story session data' },
	{ name: 'doctor', desc: 'Diagnose and fix Story state' },
	{ name: 'trace', desc: 'Show hook performance traces' },
	{ name: 'version', desc: 'Show build information' },
	{ name: 'help', desc: 'Print help for a command' },
	{ name: 'completion', desc: 'Generate shell completion script' },
];

const SESSIONS_SUBCOMMANDS = ['list', 'info', 'stop'] as const;

/**
 * bash completion — single function `_story_completions` registered
 * with `complete -F`. Matches Go cobra's bash output spirit minus the
 * cobra-specific metadata.
 */
export const BASH_TEMPLATE = `# story bash completion — source this from your shell init.
# Copy to ~/.bash_completion.d/story or eval into .bashrc.

_story_completions() {
    local cur prev words cword
    cur="\${COMP_WORDS[COMP_CWORD]}"

    if [[ $COMP_CWORD -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "${TOP_LEVEL_COMMANDS.map((c) => c.name).join(' ')}" -- "$cur") )
        return
    fi

    case "\${COMP_WORDS[1]}" in
        sessions)
            COMPREPLY=( $(compgen -W "${SESSIONS_SUBCOMMANDS.join(' ')}" -- "$cur") ) ;;
        enable|configure)
            COMPREPLY=( $(compgen -W "--agent --local --project --force" -- "$cur") ) ;;
        disable)
            COMPREPLY=( $(compgen -W "--agent --uninstall --force" -- "$cur") ) ;;
        rewind)
            COMPREPLY=( $(compgen -W "--list --to --logs-only --reset" -- "$cur") ) ;;
        clean)
            COMPREPLY=( $(compgen -W "--all --dry-run --session --force" -- "$cur") ) ;;
        doctor)
            COMPREPLY=( $(compgen -W "--force" -- "$cur") ) ;;
        trace)
            COMPREPLY=( $(compgen -W "--last --hook" -- "$cur") ) ;;
        completion)
            COMPREPLY=( $(compgen -W "${SUPPORTED_SHELLS.join(' ')}" -- "$cur") ) ;;
    esac
}
complete -F _story_completions story
`;

/**
 * zsh completion — `#compdef` header + `_story` function using
 * `_describe` for top-level commands and `_arguments` delegations for
 * the few sub-command namespaces.
 */
export const ZSH_TEMPLATE = `#compdef story
# story zsh completion — source this from your zshrc.

_story() {
    local -a commands
    commands=(
${TOP_LEVEL_COMMANDS.map((c) => `        '${c.name}:${c.desc}'`).join('\n')}
    )

    if (( CURRENT == 2 )); then
        _describe 'command' commands
        return
    fi

    case "$words[2]" in
        sessions)
            local -a sub
            sub=(
                'list:List sessions'
                'info:Show session details'
                'stop:Stop a session'
            )
            _describe 'sessions subcommand' sub
            ;;
        completion)
            local -a shells
            shells=(
                'bash:bash shell'
                'zsh:zsh shell'
                'fish:fish shell'
            )
            _describe 'shell' shells
            ;;
    esac
}
compdef _story story
`;

/**
 * fish completion — one `complete -c story` statement per top-level
 * command + a `__fish_seen_subcommand_from` rule for `sessions`.
 */
export const FISH_TEMPLATE = `# story fish completion — save to ~/.config/fish/completions/story.fish

complete -c story -f
${TOP_LEVEL_COMMANDS.map(
	(c) => `complete -c story -n '__fish_use_subcommand' -a '${c.name}' -d '${c.desc}'`,
).join('\n')}
complete -c story -n '__fish_seen_subcommand_from sessions' -a 'list info stop'
complete -c story -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'
`;

/**
 * Return the chosen shell's completion script as a single string.
 * Throws {@link SilentError} on unsupported shells (powershell, tcsh,
 * typos) so the CLI can route the error to stderr + exit 1 without
 * polluting stdout.
 *
 * Mirrors Go `cobra.CompletionOptions` auto-dispatch.
 *
 * @example
 * renderCompletionScript('bash');
 * // returns: BASH_TEMPLATE
 *
 * renderCompletionScript('powershell');
 * // throws: SilentError("Unsupported shell: powershell. Supported shells: bash, zsh, fish.")
 */
export function renderCompletionScript(shell: string): string {
	return match(shell)
		.with('bash', () => BASH_TEMPLATE)
		.with('zsh', () => ZSH_TEMPLATE)
		.with('fish', () => FISH_TEMPLATE)
		.otherwise((raw) => {
			throw new SilentError(
				new Error(`Unsupported shell: ${raw} | Supported shells: ${SUPPORTED_SHELLS.join(', ')}.`),
			);
		});
}
