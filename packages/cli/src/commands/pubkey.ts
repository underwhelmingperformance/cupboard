import type { Command } from 'commander';

import { reporterModeFromGlobals } from '../cli.ts';
import { createReporter } from '../reporter.ts';

export function registerPubkeyCommand(program: Command): void {
	program
		.command('pubkey')
		.description(
			'Print the current public signing key for this cupboard deployment.'
		)
		.action(() => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			reporter.info('pubkey command not yet implemented');
			throw new Error('pubkey not yet implemented');
		});
}
