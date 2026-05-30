import type { Command } from 'commander';

import { reporterModeFromGlobals } from '../cli.ts';
import { CupboardClient } from '../client.ts';
import { parseTtl } from '../duration.ts';
import { runPush } from '../push.ts';
import { createReporter } from '../reporter.ts';

interface PushOptions {
	readonly token: string;
	readonly root?: string;
	readonly ttl?: number;
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
		.option(
			'--root <name>',
			'retain the pushed paths under this named channel (e.g. github:owner/repo/main)'
		)
		.option(
			'--ttl <duration>',
			'expire the retained paths after this duration (e.g. 7d, 12h); default permanent',
			parseTtl
		)
		.action(async (url: string, paths: string[], options: PushOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});

			await runPush(paths, reporter, {
				client: CupboardClient.fromUrl(url),
				token: options.token,
				...(options.root === undefined ? {} : { root: options.root }),
				...(options.ttl === undefined ? {} : { ttlSeconds: options.ttl })
			});
		});
}
