import type { Command } from 'commander';

import { authenticateForPush } from '../auth.ts';
import { reporterModeFromGlobals } from '../cli.ts';
import { CupboardClient } from '../client.ts';
import { parseTtl } from '../duration.ts';
import { runPush } from '../push.ts';
import { createReporter } from '../reporter.ts';

interface PushOptions {
	readonly token?: string;
	readonly githubOidc?: boolean;
	readonly audience?: string;
	readonly root?: string;
	readonly ttl?: number;
	readonly cache?: string;
}

export function registerPushCommand(program: Command): void {
	program
		.command('push')
		.description(
			'Push one or more store paths to the configured cupboard cache.'
		)
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<paths...>', 'Nix store paths to push')
		.option('--token <token>', 'bootstrap secret')
		.option(
			'--github-oidc',
			'authenticate with a GitHub Actions OIDC token rather than a bootstrap secret'
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the Worker URL)'
		)
		.option(
			'--root <name>',
			'retain the pushed paths under this named channel (e.g. github:owner/repo/main)'
		)
		.option(
			'--ttl <duration>',
			'expire the retained paths after this duration (e.g. 7d, 12h); default permanent',
			parseTtl
		)
		.option('--cache <name>', 'push to a named cache rather than the default')
		.action(async (url: string, paths: string[], options: PushOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url, options.cache);
			const token = await authenticateForPush(client, {
				token: options.token,
				githubOidc: options.githubOidc,
				audience: options.audience ?? url
			});

			await runPush(paths, reporter, {
				client,
				token,
				...(options.root === undefined ? {} : { root: options.root }),
				...(options.ttl === undefined ? {} : { ttlSeconds: options.ttl })
			});
		});
}
