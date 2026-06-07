import type { Command } from 'commander';

import { authenticateForPush } from '../auth/auth.ts';
import { reporterModeFromGlobals } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';
import { parseTtl } from '../duration.ts';
import { AttestationsDisabledError } from '../errors.ts';
import { runPush } from '../push/push.ts';
import { createReporter } from '../reporter.ts';

interface PushOptions {
	readonly githubOidc?: boolean;
	readonly audience?: string;
	readonly root?: string;
	readonly ttl?: number;
	readonly cache?: string;
	readonly wait?: boolean;
	readonly waitTimeout?: number;
	readonly attest?: boolean;
	readonly attestation: readonly string[];
}

function collect(value: string, previous: readonly string[]): string[] {
	return [...previous, value];
}

export function registerPushCommand(program: Command): void {
	program
		.command('push')
		.description(
			'Push one or more store paths to the configured cupboard cache.'
		)
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<paths...>', 'Nix store paths to push')
		.option(
			'--github-oidc',
			'authenticate with a GitHub Actions OIDC token (default: the cached owner login)'
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
		.option(
			'--attestation <bundle>',
			'attach a Sigstore DSSE bundle whose in-toto subject matches a pushed path',
			collect,
			[]
		)
		.option('--no-attest', 'skip attestation attachment for this push')
		.option(
			'--no-wait',
			'return once uploaded without waiting for deferred blobs to become servable (records no retention over still-pending paths)'
		)
		.option(
			'--wait-timeout <duration>',
			'how long to wait for deferred blobs to become servable (e.g. 10m, 1h); default 10m',
			parseTtl
		)
		.action(async (url: string, paths: string[], options: PushOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url, options.cache);
			if (options.attest === false && options.attestation.length > 0) {
				throw new AttestationsDisabledError();
			}

			const token = await authenticateForPush(client, {
				githubOidc: options.githubOidc,
				audience: options.audience ?? url
			});

			await runPush(paths, reporter, {
				client,
				token,
				wait: options.wait,
				attest: options.attest,
				attestations: options.attestation.map((path) => ({ path })),
				...(options.root === undefined ? {} : { root: options.root }),
				...(options.ttl === undefined ? {} : { ttlSeconds: options.ttl }),
				...(options.waitTimeout === undefined
					? {}
					: { waitTimeoutSeconds: options.waitTimeout })
			});
		});
}
