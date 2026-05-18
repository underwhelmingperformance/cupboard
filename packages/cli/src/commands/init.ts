import type { Command } from 'commander';

import { reporterModeFromGlobals } from '../cli.ts';
import { createReporter } from '../reporter.ts';

interface InitOptions {
	token?: string;
}

export function registerInitCommand(program: Command): void {
	program
		.command('init')
		.description('Initialise local config against a Worker URL.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.option('--token <token>', 'write token (prompted if omitted)')
		.action(async (url: string, options: InitOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});

			await reporter.phase('Connecting to cupboard', (ctx) => {
				ctx.fact('url', url);
				throw new Error('init not yet implemented');
			});

			await reporter.phase('Saving config', (ctx) => {
				ctx.fact(
					'token',
					options.token === undefined ? 'prompted' : 'provided'
				);
				throw new Error('init not yet implemented');
			});

			reporter.result([
				{ label: 'Cache URL', value: url },
				{ label: 'Public key', value: '(not yet implemented)' },
				{ label: 'Config file', value: '(not yet implemented)' }
			]);
		});
}
