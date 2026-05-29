import type { Command } from 'commander';

import { reporterModeFromGlobals } from '../cli.ts';
import { CupboardClient } from '../client.ts';
import { createReporter } from '../reporter.ts';

export function registerPubkeyCommand(program: Command): void {
	program
		.command('pubkey')
		.description(
			'Print the current public signing key for this cupboard deployment.'
		)
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.action(async (url: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);
			const publicKey = await reporter.phase('Reading public key', () =>
				client.publicKey()
			);

			reporter.info(publicKey.trimEnd());
		});
}
