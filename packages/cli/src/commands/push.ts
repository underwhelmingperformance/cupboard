import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Nix } from '@cupboard/nix';
import {
	type RootName,
	selectorForCache,
	storePathSchema,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
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
import {
	parseTtl,
	parseWaitTimeout,
	type WaitTimeoutSeconds
} from '../duration.ts';
import {
	AttestationsDisabledError,
	InvalidUploadConcurrencyError,
	NoRetainConflictError,
	OidcRetentionChoiceRequiredError,
	ReceiptFileRequiresStoreError,
	ReferenceSourcePairError,
	RunRootTtlWithoutRunRootError
} from '../errors.ts';
import { PublicationCollection } from '../push/publication.ts';
import { runPush } from '../push/push.ts';
import { pushClientFor } from '../push/push-client.ts';
import { parseRootName } from '../root-name.ts';
import { parseStoreUri } from '../store-uri.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface PushOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
	readonly root?: RootName;
	readonly ttl?: TtlSeconds;
	readonly closure?: boolean;
	readonly intermediatePathsFile?: string;
	readonly referencePathsFile?: string;
	readonly referenceSource?: URL;
	readonly runRoot?: RootName;
	readonly runRootTtl?: TtlSeconds;
	readonly cache?: string;
	readonly store?: string;
	readonly receiptFile?: string;
	readonly wait?: boolean;
	readonly waitTimeout?: WaitTimeoutSeconds;
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
		| 'retain'
		| 'root'
		| 'ttl'
		| 'githubOidc'
		| 'dryRun'
		| 'runRoot'
		| 'runRootTtl'
	>
): void {
	if (options.retain === false && options.root !== undefined) {
		throw new NoRetainConflictError('--root');
	}

	if (options.retain === false && options.ttl !== undefined) {
		throw new NoRetainConflictError('--ttl');
	}

	// The run root is independent of the target-root choice: an unretained
	// push may still bind one, its commits joining the run root while the
	// push declares no target root. Only a TTL with no run root to carry it
	// is refused.
	if (options.runRootTtl !== undefined && options.runRoot === undefined) {
		throw new RunRootTtlWithoutRunRootError();
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
 * The build store a push records a receipt against, or nothing when the push
 * writes no receipt. A receipt attributes every subject to the store the run
 * selected, so a push reading the store Nix itself would use has no selection
 * to record and is refused.
 */
export function receiptBuildStore(
	options: Pick<PushOptions, 'receiptFile' | 'store'>
): string | undefined {
	if (options.receiptFile === undefined) {
		return undefined;
	}

	if (options.store === undefined) {
		throw new ReceiptFileRequiresStoreError();
	}

	return options.store;
}

/**
 * The authority a push's token exchange requests. A CI exchange must name
 * what it wants; a dry run publishes nothing, so it requests only the
 * read-only preview operation, never a push's full upload grant.
 */
export function pushCommandAuthorizationDetails(
	options: Pick<PushOptions, 'dryRun' | 'attest' | 'root' | 'runRoot'>,
	cacheSelector: string
): AuthorizationDetails {
	if (options.dryRun === true) {
		return previewAuthorizationDetails({ cacheSelector });
	}

	return pushAuthorizationDetails({
		cacheSelector,
		attest: options.attest !== false,
		...(options.root !== undefined && { root: options.root }),
		...(options.runRoot !== undefined && { runRoot: options.runRoot })
	});
}

function collect(value: string, previous: readonly string[]): string[] {
	return [...previous, value];
}

/**
 * Splits a newline-delimited path file into its lines: each is trimmed and
 * blank lines are dropped. The file is transport only; the publication
 * collection validates every line as a store path.
 */
export function parsePathFile(contents: string): string[] {
	return contents
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line !== '');
}

/**
 * Resolves one CLI-supplied path to the store path it names, the way
 * `nix path-info` does: a store path passes through untouched, and anything
 * else resolves through the filesystem, with a `result` symlink and a file
 * inside a store path both landing on the containing store path. The command
 * layer parses; the domain gets store paths, so a location that still is not
 * one is returned as resolved and refused by the publication collection's
 * typed error.
 */
export function resolvePushPath(
	path: string,
	realpath: (path: string) => string = realpathSync
): string {
	if (storePathSchema.safeParse(path).success) {
		return path;
	}

	let resolved: string;
	try {
		resolved = realpath(path);
	} catch {
		return path;
	}

	return containingStorePath(resolved) ?? resolved;
}

function resolvePushPaths(values: readonly string[]): string[] {
	return values.map((value) => resolvePushPath(value));
}

// The store path containing a resolved location: the shortest leading run of
// segments that parses as a store path, which is the entry directly under the
// store directory.
function containingStorePath(resolved: string): string | undefined {
	const segments = resolved.split('/');

	for (let end = 2; end <= segments.length; end += 1) {
		const candidate = segments.slice(0, end).join('/');

		if (storePathSchema.safeParse(candidate).success) {
			return candidate;
		}
	}

	return undefined;
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
			'retain the pushed paths under this named channel (e.g. github:owner/repo/main)',
			parseRootName
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
		.option(
			'--closure',
			'publish the complete realised closure of the requested paths (default: exactly the requested paths)'
		)
		.option(
			'--intermediate-paths-file <path>',
			'newline-delimited store paths to publish alongside the targets without retaining them as targets'
		)
		.option(
			'--reference-paths-file <path>',
			'newline-delimited store paths the tenant already holds, published from the reference source with no local store read or NAR upload'
		)
		.option(
			'--reference-source <url>',
			'served cache endpoint the reference paths are read from (required with --reference-paths-file)',
			parseWorkerUrl
		)
		.option(
			'--run-root <name>',
			'bind a run root: every pushed path also joins this root as it commits. Independent of --root, and valid with --no-retain (the commits join the run root while the push declares no target root)',
			parseRootName
		)
		.option(
			'--run-root-ttl <duration>',
			'expire the run root after this duration (e.g. 7d, 12h); default per the tenant retention policy, else permanent',
			parseTtl
		)
		.option('--cache <name>', 'push to a named cache rather than the default')
		.option(
			'--store <uri>',
			'read path metadata and NAR bytes from this remote ssh-ng store (default: the store Nix itself would use)',
			parseStoreUri
		)
		.option(
			'--receipt-file <path>',
			'write a build receipt (JSON) for the published paths to this file, attributing each subject to the store --store names'
		)
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
				'    --no-retain',
				'',
				'  # Publish the complete realised closure of the result',
				'  cupboard push https://cache.example.workers.dev/t/acme ./result \\',
				'    --root github:acme/infra/main --closure',
				'',
				'  # Publish build-time intermediates alongside the target, unrooted',
				'  cupboard push https://cache.example.workers.dev/t/acme ./result \\',
				'    --root github:acme/infra/main --intermediate-paths-file intermediates.txt'
			].join('\n')
		)
		.action(async (url: URL, paths: string[], options: PushOptions) => {
			if (options.attest === false && options.attestation.length > 0) {
				throw new AttestationsDisabledError();
			}

			validateRetentionChoice(options);

			const buildStore = receiptBuildStore(options);

			if (
				(options.referencePathsFile === undefined) !==
				(options.referenceSource === undefined)
			) {
				throw new ReferenceSourcePairError();
			}

			// The files are transport; the collection is the type. An argument or
			// file line may name a store path through a symlink, so each resolves
			// through the filesystem first; entries are store paths at the domain
			// boundary, so a location that still is not one fails here, before any
			// token is requested.
			const intermediatePaths =
				options.intermediatePathsFile === undefined
					? undefined
					: parsePathFile(
							await readFile(options.intermediatePathsFile, 'utf8')
						);
			const referencePaths =
				options.referencePathsFile === undefined
					? undefined
					: parsePathFile(await readFile(options.referencePathsFile, 'utf8'));
			const publication = PublicationCollection.of({
				targets: resolvePushPaths(paths),
				...(intermediatePaths !== undefined && {
					intermediatePaths: resolvePushPaths(intermediatePaths)
				}),
				...(referencePaths !== undefined && {
					referencePaths: resolvePushPaths(referencePaths)
				})
			});
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

			const receipt = await runPush(publication, reporter, {
				client: pushClientFor(url, token, {
					cache: options.cache,
					signal: programOptions.signal
				}),
				...(options.store !== undefined && {
					nix: Nix.openDaemon(undefined, { storeUri: options.store })
				}),
				...(options.closure !== undefined && { closure: options.closure }),
				...(options.referenceSource !== undefined && {
					referenceSource: { url: options.referenceSource }
				}),
				wait: options.wait,
				signal: programOptions.signal,
				attest: options.attest,
				attestations: options.attestation.map((path) => ({ path })),
				...(options.root !== undefined && { root: options.root }),
				...(options.ttl !== undefined && { ttlSeconds: options.ttl }),
				...(options.runRoot !== undefined && {
					runRoot: {
						name: options.runRoot,
						...(options.runRootTtl !== undefined && {
							ttlSeconds: options.runRootTtl
						})
					}
				}),
				...(options.retain !== undefined && { retain: options.retain }),
				...(options.waitTimeout !== undefined && {
					waitTimeoutSeconds: options.waitTimeout
				}),
				...(options.uploadConcurrency !== undefined && {
					uploadConcurrency: options.uploadConcurrency
				}),
				...(options.dryRun !== undefined && { dryRun: options.dryRun }),
				...(buildStore !== undefined && { buildStore })
			});

			if (receipt === undefined || options.receiptFile === undefined) {
				return;
			}

			await mkdir(path.dirname(options.receiptFile), { recursive: true });
			await writeFile(
				options.receiptFile,
				`${JSON.stringify(receipt, undefined, '\t')}\n`
			);
		});
}
