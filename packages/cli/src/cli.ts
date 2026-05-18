import { Command } from 'commander';

import { registerConfigCommand } from './commands/config.ts';
import { registerInitCommand } from './commands/init.ts';
import { registerPubkeyCommand } from './commands/pubkey.ts';
import { registerPushCommand } from './commands/push.ts';
import { registerStatsCommand } from './commands/stats.ts';

export interface GlobalOptions {
	readonly colour?: boolean;
}

export function buildProgram(): Command {
	const program = new Command()
		.name('cupboard')
		.description(
			'Push and configure a personal Nix binary cache hosted on Cloudflare Workers.'
		)
		.version('0.0.0')
		.option('--colour', 'force interactive spinner and colour output')
		.option('--no-colour', 'force plain line-delimited JSON output')
		.showHelpAfterError();

	registerInitCommand(program);
	registerPushCommand(program);
	registerConfigCommand(program);
	registerPubkeyCommand(program);
	registerStatsCommand(program);

	return program;
}

export function reporterModeFromGlobals(
	program: Command
): 'terminal' | 'json' | undefined {
	const { colour } = program.opts<GlobalOptions>();

	if (colour === undefined) {
		return undefined;
	}

	return colour ? 'terminal' : 'json';
}
