import type { Command } from 'commander';

import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { tenantUrlArgument } from '../url-argument.ts';

export function registerPubkeyCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('pubkey')
		.description(
			'Print the current public signing key for this cupboard deployment.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const reporter = commandUi(program, programOptions).reporter();
			const client = CupboardClient.fromUrl(url, {
				cache: { kind: 'default' },
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
