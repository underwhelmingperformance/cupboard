import type { Command } from 'commander';

import { reporterModeFromGlobals } from '../cli.ts';
import { CupboardClient } from '../client.ts';
import { createReporter } from '../reporter.ts';

interface InitOptions {
	readonly token: string;
}

export function registerInitCommand(program: Command): void {
	program
		.command('init')
		.description('Initialise a cupboard Worker and print its write token.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.requiredOption(
			'--token <token>',
			'bootstrap token configured on the Worker'
		)
		.action(async (url: string, options: InitOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);
			const { token } = options;

			const result = await reporter.phase('Initialising cupboard', (ctx) => {
				ctx.fact('url', url);
				return client.init(token);
			});

			const writeToken =
				result.token === '' ? '(already initialised)' : result.token;

			reporter.result([
				{ label: 'Cache URL', value: result.url },
				{ label: 'Public key', value: result.publicKey },
				{ label: 'Write token', value: writeToken }
			]);
		});
}
