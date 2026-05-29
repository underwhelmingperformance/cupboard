import type { Command } from 'commander';

import { reporterModeFromGlobals } from '../cli.ts';
import { CupboardClient } from '../client.ts';
import { runPush } from '../push.ts';
import { createReporter } from '../reporter.ts';

interface PushOptions {
	readonly token: string;
}

export function registerPushCommand(program: Command): void {
	program
		.command('push')
		.description(
			'Push one or more store paths to the configured cupboard cache.'
		)
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<paths...>', 'Nix store paths to push')
		.requiredOption('--token <token>', 'write token')
		.action(async (url: string, paths: string[], options: PushOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const { token } = options;

			await runPush(paths, reporter, {
				client: CupboardClient.fromUrl(url),
				token
			});
		});
}
