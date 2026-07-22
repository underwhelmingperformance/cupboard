import { selectorForCache } from '@cupboard/nix-store/scalars';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import type { Command } from 'commander';

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import {
	previewAuthorizationDetails,
	pushAuthorizationDetails
} from '../auth/attenuate.ts';
import { authenticateForPush } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient, storedCacheFor } from '../client/client.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { parseTtl, parseWaitTimeout } from '../duration.ts';
import {
	AttestationsDisabledError,
	InvalidUploadConcurrencyError,
	NoRetainConflictError,
	OidcRetentionChoiceRequiredError
} from '../errors.ts';
import { runPush } from '../push/push.ts';
import { pushClientFor } from '../push/push-client.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface PushOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
	readonly root?: string;
	readonly ttl?: number;
	readonly cache?: string;
	readonly wait?: boolean;
	readonly waitTimeout?: number;
	readonly attest?: boolean;
	readonly attestation: readonly string[];
	readonly uploadConcurrency?: number;
	readonly dryRun?: boolean;
	readonly retain?: boolean;
}

/**
 * The retention plan a push must resolve before authenticating: `--no-retain`
 * clashes with either `--root` or `--ttl`, and a mutating GitHub OIDC push must
 * commit to a named root or explicit unretained publication before requesting a
 * token, so a CI run never authenticates for a plan it cannot express. A dry run
 * publishes nothing, so it is exempt from the OIDC choice.
 */
export function validateRetentionChoice(
	options: Pick<
		PushOptions,
		'retain' | 'root' | 'ttl' | 'githubOidc' | 'dryRun'
	>
): void {
	if (options.retain === false && options.root !== undefined) {
		throw new NoRetainConflictError('--root');
	}

	if (options.retain === false && options.ttl !== undefined) {
		throw new NoRetainConflictError('--ttl');
	}

	if (
		options.githubOidc === true &&
		options.dryRun !== true &&
		options.root === undefined &&
		options.retain !== false
	) {
		throw new OidcRetentionChoiceRequiredError();
	}
}

/**
 * The authority a push's token exchange requests. A CI exchange must name
 * what it wants; a dry run publishes nothing, so it requests only the
 * read-only preview operation, never a push's full upload grant.
 */
export function pushCommandAuthorizationDetails(
	options: Pick<PushOptions, 'dryRun' | 'attest' | 'root'>,
	cacheSelector: string
): AuthorizationDetails {
	if (options.dryRun === true) {
		return previewAuthorizationDetails({ cacheSelector });
	}

	return pushAuthorizationDetails({
		cacheSelector,
		attest: options.attest !== false,
		...(options.root !== undefined && { root: options.root })
	});
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
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<paths...>', 'Nix store paths to push')
		.option(
			'--github-oidc',
			'authenticate with a GitHub Actions OIDC token (default: the cached owner login)'
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)',
			parseAudience
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
		.option(
			'--no-retain',
			"publish without any retention root or pin; kept only by the cache's retention grace policy, if one matches"
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
			'return once uploaded and committed, without waiting for deferred blobs to become servable (retention is still recorded)'
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
				'  cupboard push --github-oidc https://cache.example.workers.dev/t/acme ./result \\',
				'    --root github:acme/infra/main',
				'',
				'  # Push a shared intermediate without pinning it',
				'  cupboard push --github-oidc https://cache.example.workers.dev/t/acme ./result \\',
				'    --no-retain'
			].join('\n')
		)
		.action(async (url: URL, paths: string[], options: PushOptions) => {
			if (options.attest === false && options.attestation.length > 0) {
				throw new AttestationsDisabledError();
			}

			validateRetentionChoice(options);

			const reporter = commandUi(program, programOptions).reporter();
			const raw = CupboardClient.fromUrl(url, {
				cache: options.cache,
				signal: programOptions.signal
			});

			const cacheSelector = selectorForCache(storedCacheFor(options.cache));
			const token = await authenticateForPush(raw, {
				githubOidc: options.githubOidc,
				audience: options.audience ?? audienceSchema.parse(url),
				authorizationDetails: pushCommandAuthorizationDetails(
					options,
					cacheSelector
				)
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
				...(options.root !== undefined && { root: options.root }),
				...(options.ttl !== undefined && { ttlSeconds: options.ttl }),
				...(options.retain !== undefined && { retain: options.retain }),
				...(options.waitTimeout !== undefined && {
					waitTimeoutSeconds: options.waitTimeout
				}),
				...(options.uploadConcurrency !== undefined && {
					uploadConcurrency: options.uploadConcurrency
				}),
				...(options.dryRun !== undefined && { dryRun: options.dryRun })
			});
		});
}
