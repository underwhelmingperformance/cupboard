import { createReporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import { reporterModeFromGlobals } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';

export function registerInitCommand(program: Command): void {
	program
		.command('init')
		.description(
			'Initialise a cupboard Worker and print its substituter config.'
		)
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.action(async (url: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);

			// Reading the public key creates the signing key on first call, so this
			// both initialises the Worker and prints what a client needs. No token
			// is required: the public key is unauthenticated.
			const publicKey = await reporter.phase('Initialising cupboard', (ctx) => {
				ctx.fact('url', url);
				return client.publicKey();
			});

			reporter.result([
				{ label: 'Cache URL', value: url },
				{ label: 'Public key', value: publicKey }
			]);
		});
}
