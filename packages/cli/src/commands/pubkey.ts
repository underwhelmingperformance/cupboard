import { createCliUi } from '@cupboard/cli-ui';
import type { Command } from 'commander';

import { type ProgramOptions, reporterModeFromGlobals } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';

export function registerPubkeyCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('pubkey')
		.description(
			'Print the current public signing key for this cupboard deployment.'
		)
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.action(async (url: string) => {
			const reporter = createCliUi({
				mode: reporterModeFromGlobals(program)
			}).reporter();
			const client = CupboardClient.fromUrl(url, {
				signal: programOptions.signal
			});
			const publicKey = await reporter.phase('Reading public key', () =>
				client.publicKey()
			);

			// The key is the command's payload: write it to stdout so
			// `cupboard pubkey <url> > key.txt` captures it.
			reporter.data(publicKey.trimEnd());
		});
}
