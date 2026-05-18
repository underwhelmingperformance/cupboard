import type { Command } from 'commander';

import { reporterModeFromGlobals } from '../cli.ts';
import { createReporter } from '../reporter.ts';

export function registerConfigCommand(program: Command): void {
	program
		.command('config')
		.description(
			"Print Nix substituter configuration suitable for a user's nix.conf."
		)
		.action(() => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			reporter.info('config command not yet implemented');
			throw new Error('config not yet implemented');
		});
}
