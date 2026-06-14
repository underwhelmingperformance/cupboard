import type { Command } from 'commander';

import { authenticateForPush } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';
import { parseTtl, parseWaitTimeout } from '../duration.ts';
import {
	AttestationsDisabledError,
	InvalidUploadConcurrencyError
} from '../errors.ts';
import { runPush } from '../push/push.ts';
import { pushClientFor } from '../push/push-client.ts';
import { tenantUrlArgument } from '../url-argument.ts';

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
	readonly uploadConcurrency?: number;
	readonly dryRun?: boolean;
}

function collect(value: string, previous: readonly string[]): string[] {
	return [...previous, value];
}

function parseUploadConcurrency(value: string): number {
	if (!/^\d+$/.test(value) || Number(value) < 1) {
		throw new InvalidUploadConcurrencyError(value);
	}

	return Number(value);
}

export function registerPushCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('push')
		.description(
			'Push one or more store paths to the configured cupboard cache.'
		)
		.argument('<url>', tenantUrlArgument)
		.argument('<paths...>', 'Nix store paths to push')
		.option(
			'--github-oidc',
			'authenticate with a GitHub Actions OIDC token (default: the cached owner login)'
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)'
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
			'file a Sigstore DSSE bundle whose in-toto subject matches a pushed path',
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
			parseWaitTimeout
		)
		.option(
			'--upload-concurrency <n>',
			'how many blob uploads to run at once (default 6)',
			parseUploadConcurrency
		)
		.option(
			'--dry-run',
			'show what would be uploaded, reused, and retained without changing anything'
		)
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  # Push a build result to a tenant, pinning it under a named root',
				'  cupboard push https://cache.example.workers.dev/t/acme ./result \\',
				'    --root github:acme/infra/main',
				'',
				'  # Preview a push without uploading anything',
				'  cupboard push https://cache.example.workers.dev/t/acme ./result --dry-run',
				'',
				'  # Push from CI with a GitHub Actions OIDC token',
				'  cupboard push --github-oidc https://cache.example.workers.dev/t/acme ./result'
			].join('\n')
		)
		.action(async (url: string, paths: string[], options: PushOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const raw = CupboardClient.fromUrl(url, {
				cache: options.cache,
				signal: programOptions.signal
			});
			if (options.attest === false && options.attestation.length > 0) {
				throw new AttestationsDisabledError();
			}

			const token = await authenticateForPush(raw, {
				githubOidc: options.githubOidc,
				audience: options.audience ?? url
			});

			await runPush(paths, reporter, {
				client: pushClientFor(url, token, {
					cache: options.cache,
					signal: programOptions.signal
				}),
				wait: options.wait,
				signal: programOptions.signal,
				attest: options.attest,
				attestations: options.attestation.map((path) => ({ path })),
				...(options.root === undefined ? {} : { root: options.root }),
				...(options.ttl === undefined ? {} : { ttlSeconds: options.ttl }),
				...(options.waitTimeout === undefined
					? {}
					: { waitTimeoutSeconds: options.waitTimeout }),
				...(options.uploadConcurrency === undefined
					? {}
					: { uploadConcurrency: options.uploadConcurrency }),
				...(options.dryRun === undefined ? {} : { dryRun: options.dryRun })
			});
		});
}
