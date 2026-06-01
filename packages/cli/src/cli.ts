import { Command } from 'commander';

import { registerCacheCommands } from './commands/cache.ts';
import { registerCheckCommand } from './commands/check.ts';
import { registerConfigCommand } from './commands/config.ts';
import { registerDeleteCommand } from './commands/delete.ts';
import { registerInitCommand } from './commands/init.ts';
import { registerKeyCommands } from './commands/key.ts';
import { registerPolicyCommands } from './commands/policy.ts';
import { registerPubkeyCommand } from './commands/pubkey.ts';
import { registerPushCommand } from './commands/push.ts';
import { registerRootCommands } from './commands/root.ts';
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
	registerDeleteCommand(program);
	registerRootCommands(program);
	registerKeyCommands(program);
	registerCacheCommands(program);
	registerPolicyCommands(program);
	registerCheckCommand(program);

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
