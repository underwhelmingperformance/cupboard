import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Nix } from '@cupboard/nix';
import { InvalidStorePathError } from '@cupboard/nix-store/errors';
import {
	type CacheAccessMode,
	type CacheScope,
	type RootName,
	storePathSchema,
	type StorePathString,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import {
	type NixStoreUri,
	observedCopiesSchema
} from '@cupboard/protocol/build';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import { rootSetMaxTargets } from '@cupboard/protocol/retention';
import type { ReadUser } from '@cupboard/shared/http';
import { type Command, Option } from 'commander';

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import {
	contentReadAuthorizationDetails,
	type ContentReadGrantIntent,
	previewAuthorizationDetails,
	pushAuthorizationDetails
} from '../auth/attenuate.ts';
import { authenticateForPush } from '../auth/auth.ts';
import { resolveAuthorisedCachePositionals } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	parseTtl,
	parseWaitTimeout,
	type WaitTimeoutSeconds
} from '../duration.ts';
import {
	AttestationsDisabledError,
	CliUsageError,
	CupboardHttpError,
	EmptyPublicationError,
	InvalidUploadConcurrencyError,
	NoRetainConflictError,
	OidcRetentionChoiceRequiredError,
	ReadCredentialPairError,
	ReceiptFileRequiresStoreError,
	ReferenceSourcePairError,
	ReferenceSourceReadRefusedError,
	RootRetentionOptionConflictError,
	RunRootRetentionWithoutRunRootError,
	RunRootTtlWithoutRunRootError
} from '../errors.ts';
import { PublicationCollection } from '../push/publication.ts';
import { type PushStore, runPush } from '../push/push.ts';
import { pushClientFor } from '../push/push-client.ts';
import {
	parseReferenceManifest,
	type PreparedReference
} from '../push/reference-manifest.ts';
import {
	referenceSourceReadIntents,
	type ReferenceSourceReads
} from '../push/reference-source-read.ts';
import { parseReadUser } from '../read-user.ts';
import { parseRootName } from '../root-name.ts';
import { parseStoreUri } from '../store-uri.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { cacheAccessFetcher } from './github.ts';
import { rootRetentionChoice } from './retention-choice.ts';

interface PushOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
	readonly root?: RootName;
	readonly ttl?: TtlSeconds;
	readonly permanent?: boolean;
	readonly closure?: boolean;
	readonly pathsFile?: string;
	readonly intermediatePathsFile?: string;
	readonly referencePathsFile?: string;
	readonly referenceManifest?: string;
	readonly referenceSource?: URL;
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
	readonly runRoot?: RootName;
	readonly runRootTtl?: TtlSeconds;
	readonly runRootPermanent?: boolean;
	readonly store?: string;
	readonly receiptFile?: string;
	readonly referenceReceiptFile?: string;
	readonly alreadyHeld?: readonly string[] | false;
	readonly claimable?: readonly string[] | false;
	readonly copiedFromFile?: string;
	readonly wait?: boolean;
	readonly waitTimeout?: WaitTimeoutSeconds;
	readonly attest?: boolean;
	readonly attestation: readonly string[];
	readonly uploadConcurrency?: number;
	readonly dryRun?: boolean;
	readonly retain?: boolean;
}

export class ReferenceReceiptOptionError extends CliUsageError {
	constructor(reason: 'source' | 'conflict') {
		super(
			reason === 'source'
				? '--reference-receipt-file requires --reference-manifest or both --reference-paths-file and --reference-source'
				: '--reference-receipt-file cannot be combined with --receipt-file'
		);
		this.name = 'ReferenceReceiptOptionError';
	}
}

/**
 * Checks the retention options before a push authenticates. `--no-retain`
 * conflicts with `--root` and with `--ttl`. A mutating GitHub OIDC push must
 * choose either a named root or explicit unretained publication before it
 * requests a token, so a CI run never obtains a token for a retention plan it
 * cannot execute. A dry run publishes nothing, so it does not need that
 * choice.
 */
export function validateRetentionChoice(
	options: Pick<
		PushOptions,
		| 'retain'
		| 'root'
		| 'ttl'
		| 'permanent'
		| 'githubOidc'
		| 'dryRun'
		| 'runRoot'
		| 'runRootTtl'
		| 'runRootPermanent'
	>
): void {
	if (options.retain === false && options.root !== undefined) {
		throw new NoRetainConflictError('--root');
	}

	if (options.retain === false && options.ttl !== undefined) {
		throw new NoRetainConflictError('--ttl');
	}

	if (options.retain === false && options.permanent === true) {
		throw new NoRetainConflictError('--permanent');
	}

	if (options.ttl !== undefined && options.permanent === true) {
		throw new RootRetentionOptionConflictError();
	}

	// The run root is independent of the target root: an unretained push may
	// still bind a run root, and its commits join that root while the push
	// declares no target root. Only a `--run-root-ttl` with no `--run-root`
	// is refused.
	if (options.runRootTtl !== undefined && options.runRoot === undefined) {
		throw new RunRootTtlWithoutRunRootError();
	}

	if (options.runRootPermanent === true && options.runRoot === undefined) {
		throw new RunRootRetentionWithoutRunRootError('--run-root-permanent');
	}

	if (options.runRootTtl !== undefined && options.runRootPermanent === true) {
		throw new RootRetentionOptionConflictError(
			'--run-root-ttl',
			'--run-root-permanent'
		);
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
 * Returns the explicitly selected store for a publication receipt. The receipt
 * describes store metadata and does not establish current-run build execution.
 */
export function receiptBuildStore(
	options: Pick<
		PushOptions,
		'receiptFile' | 'store' | 'alreadyHeld' | 'claimable'
	>
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
 * Reads the copy observations written by a supervising build. The push runs in
 * a separate process after the build and cannot observe those copies itself.
 * Without this file, the receipt records no source for any published path.
 */
export async function observedCopiesFrom(
	copiedFromFile: string | undefined
): Promise<ReadonlyMap<StorePathString, readonly NixStoreUri[]> | undefined> {
	if (copiedFromFile === undefined) {
		return undefined;
	}

	const parsed = observedCopiesSchema.parse(
		JSON.parse(await readFile(copiedFromFile, 'utf8'))
	);
	const copies = new Map<StorePathString, readonly NixStoreUri[]>();

	for (const [storePath, sources] of Object.entries(parsed)) {
		copies.set(storePathSchema.parse(storePath), sources);
	}

	return copies;
}

/**
 * The authority requested by a push's token exchange. A CI exchange must
 * request its authorization_details explicitly. A dry run publishes nothing, so
 * it requests only the read-only preview operation and never a push's full
 * upload grant.
 */
export function pushCommandAuthorizationDetails(
	options: Pick<PushOptions, 'dryRun' | 'attest' | 'root' | 'runRoot'>,
	cache: CacheScope,
	sourceReads: readonly ContentReadGrantIntent[] = []
): AuthorizationDetails {
	if (options.dryRun === true) {
		return previewAuthorizationDetails({ cache });
	}

	return [
		...pushAuthorizationDetails({
			cache,
			attest: options.attest !== false,
			...(options.root !== undefined && { root: options.root }),
			...(options.runRoot !== undefined && { runRoot: options.runRoot })
		}),
		...sourceReads.flatMap((intent) => contentReadAuthorizationDetails(intent))
	];
}

function referenceSourceReads(
	options: Pick<
		PushOptions,
		'dryRun' | 'referencePathsFile' | 'referenceSource'
	>,
	references: readonly PreparedReference[],
	destination: { readonly tenantUrl: URL; readonly cache: CacheScope },
	fetchCacheAccess: (url: URL) => Promise<CacheAccessMode>
): Promise<ReferenceSourceReads> {
	if (options.dryRun === true) {
		return Promise.resolve({ intents: [], sources: [] });
	}

	return referenceSourceReadIntents(
		[
			...(options.referencePathsFile === undefined ||
			options.referenceSource === undefined
				? []
				: [options.referenceSource]),
			...references.map((reference) => reference.source)
		],
		destination,
		fetchCacheAccess
	);
}

// The token service refuses the whole request without saying which grant
// failed, so a refusal of a request with source read grants points at them.
function sourceReadRefusal(error: unknown, sources: readonly URL[]): unknown {
	if (
		sources.length === 0 ||
		!(error instanceof CupboardHttpError) ||
		error.oauthError?.error !== 'invalid_authorization_details' ||
		error.oauthError.problem !== 'not-permitted'
	) {
		return error;
	}

	return new ReferenceSourceReadRefusedError(sources, { cause: error });
}

function collect(
	value: string,
	previous: readonly string[] | undefined
): string[] {
	return [...(previous ?? []), value];
}

export function parsePathFile(contents: string): string[] {
	return contents
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line !== '');
}

/**
 * Resolves one path given on the command line to a store path, the way
 * `nix path-info` does. A store path is returned unchanged. Anything else is
 * resolved through the filesystem, so both a `result` symlink and a file inside
 * a store path resolve to the store path that contains them. A location that
 * still does not parse as a store path is returned as resolved. Each caller
 * rejects it with its own error.
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

function resolvePushStorePath(value: string): StorePathString {
	const resolved = resolvePushPath(value);
	const parsed = storePathSchema.safeParse(resolved);

	if (!parsed.success) {
		throw new InvalidStorePathError(resolved);
	}

	return parsed.data;
}

function resolvePushStorePaths(values: readonly string[]): StorePathString[] {
	return values.map((value) => resolvePushStorePath(value));
}

// A location inside a store path belongs to the shortest prefix that parses as
// a store path. That prefix is the entry directly under the store directory.
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

interface PushCommandDependencies {
	/**
	 * Returns the token provider for the push. Defaults to `authenticateForPush`,
	 * which uses GitHub Actions OIDC with `--github-oidc` and otherwise the owner
	 * session cached by `cupboard login`.
	 */
	readonly authenticate?: typeof authenticateForPush;
	/**
	 * Opens the system store when `--store` is omitted and the publication has
	 * local entries. When this dependency is not supplied, `runPush` opens the
	 * system store with `Nix.open`.
	 */
	readonly openStore?: () => PushStore;
	/**
	 * Reports whether a cache or reuse view URL is public or private. Defaults
	 * to an unauthenticated `nix-cache-info` request.
	 */
	readonly fetchCacheAccess?: (url: URL) => Promise<CacheAccessMode>;
}

export function registerPushCommand(
	program: Command,
	programOptions: ProgramOptions = {},
	dependencies: PushCommandDependencies = {}
): void {
	const authenticate = dependencies.authenticate ?? authenticateForPush;
	const fetchCacheAccess =
		dependencies.fetchCacheAccess ??
		cacheAccessFetcher({ signal: programOptions.signal });

	program
		.command('push')
		.description('Publish store paths to a cache.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument(
			'[paths...]',
			'an optional cache name, then the store paths to push'
		)
		.option(
			'--github-oidc',
			"sign in with the job's GitHub Actions OIDC token instead of your saved `cupboard login` session"
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)',
			parseAudience
		)
		.option(
			'--root <name>',
			`retain the pushed paths under this named retention root (e.g. github:owner/repo/main); one push can retain at most ${String(rootSetMaxTargets)} target paths`,
			parseRootName
		)
		.option(
			'--ttl <duration>',
			'expire the root or pins after this duration (e.g. 7d, 12h)',
			parseTtl
		)
		.option('--permanent', 'keep the root or pins permanently')
		.option(
			'--no-retain',
			"publish without a root or pins, so that only the cache's grace period keeps the paths"
		)
		.option(
			'--closure',
			'publish the whole closure of the given paths (by default, only the given paths)'
		)
		.option(
			'--paths-file <path>',
			'file of target store paths, one per line. These paths are published with any positional paths and retained under --root when specified.'
		)
		.option(
			'--intermediate-paths-file <path>',
			'file of extra store paths, one per line, to publish without adding them to the root'
		)
		.option(
			'--reference-paths-file <path>',
			'file of store paths, one per line, to publish by reference from --reference-source. Their content must already exist in this tenant; the command does not upload it from the local store.'
		)
		.option(
			'--reference-manifest <path>',
			'JSON file of paths to republish from another cache without downloading them. See the reference manifest format in the Pushing guide.'
		)
		.option(
			'--reference-source <url>',
			'source cache URL for the paths in --reference-paths-file (required with --reference-paths-file)',
			parseWorkerUrl
		)
		.option(
			'--read-user <user>',
			'user name of the read credential for a private --reference-source',
			parseReadUser
		)
		.option(
			'--read-password <password>',
			'password of the read credential for a private --reference-source'
		)
		.option(
			'--run-root <name>',
			'also add each pushed path to this run root as soon as the cache accepts it. This works independently of --root, and also with --no-retain.',
			parseRootName
		)
		.option(
			'--run-root-ttl <duration>',
			'expire the run root after this duration (e.g. 7d, 12h)',
			parseTtl
		)
		.option('--run-root-permanent', 'keep the run root permanently')
		.option(
			'--store <uri>',
			'read paths from auto or a remote ssh-ng store (default: the store that Nix uses)',
			(value: string) => (value === 'auto' ? value : parseStoreUri(value))
		)
		.option(
			'--receipt-file <path>',
			'write a publication receipt (JSON) from the selected store metadata. Requires --store. The receipt records publication, not a build.'
		)
		.option(
			'--reference-receipt-file <path>',
			'write a receipt for successfully published reference paths only. Requires --reference-manifest or both --reference-paths-file and --reference-source. The receipt records republished paths, not a build or download.'
		)
		.addOption(
			new Option(
				'--already-held <path>',
				'accepted for compatibility with older callers (repeatable); does not affect receipt origins.'
			)
				.argParser(collect)
				.hideHelp()
		)
		.addOption(
			new Option(
				'--no-already-held',
				'accepted for compatibility with older callers; does not affect receipt origins'
			).hideHelp()
		)
		.addOption(
			new Option(
				'--claimable <path>',
				'accepted for compatibility with older callers (repeatable); cannot authorise a current-run build claim.'
			)
				.argParser(collect)
				.hideHelp()
		)
		.addOption(
			new Option(
				'--no-claimable',
				'accepted for compatibility with older callers; a push never records current-run build claims'
			).hideHelp()
		)
		.option(
			'--copied-from-file <path>',
			'JSON file, written by the build, that lists the stores each path was copied from'
		)
		.option(
			'--bundle, --attestation <bundle>',
			'a Sigstore bundle file to attach to the pushed paths that it covers (repeatable; both option names are equivalent)',
			collect,
			[]
		)
		.option('--no-attest', 'do not attach any attestations')
		.option(
			'--no-wait',
			'return once the cache has accepted the paths and set the roots or pins, without waiting for it to verify the uploaded NARs'
		)
		.option(
			'--wait-timeout <duration>',
			'time limit for each of the two waits: for the cache to accept the push, and then for it to verify the uploaded NARs (e.g. 10m, 1h; default 10m)',
			parseWaitTimeout
		)
		.option(
			'--upload-concurrency <n>',
			'number of NAR uploads to run in parallel (default 6)',
			parseUploadConcurrency
		)
		.option(
			'--dry-run',
			'show what would be uploaded, reused and retained, without changing anything'
		)
		.addHelpText(
			'after',
			[
				'',
				'If some paths fail, the rest are still published, and the push fails.',
				'When a path fails before the cache accepts it (while the push resolves,',
				'uploads or commits it), the push publishes none of the failed paths and',
				'sets no root and no pins. A path that fails verification has already',
				'been accepted: either the cache reported that its verification failed,',
				'or the cache had not verified it when the push stopped waiting, and it',
				'may still publish the path. If the cache accepted every path, the push',
				'has already set the root or pins, unless --no-retain was given.',
				'',
				'When a path fails, the command exits 77 if any failure was a sign-in or',
				'permission failure, otherwise 75 if any was temporary, otherwise 2 if',
				'an argument was invalid or an upload request exceeded its limit, and',
				'otherwise 1. A failure caused by the storage quota exits 1, because',
				'running the push again fails in the same way until space is freed or',
				'the quota is raised. For exit status 75, run the push again to publish',
				'the paths that failed.',
				'',
				'Examples:',
				'  # Push a build result to a tenant and keep it under a root',
				'  cupboard push https://cupboard.example.workers.dev/t/acme ./result \\',
				'    --root github:acme/app/main',
				'',
				'  # Preview a push without uploading anything',
				'  cupboard push https://cupboard.example.workers.dev/t/acme ./result --dry-run',
				'',
				'  # Push from CI with a GitHub Actions OIDC token',
				'  cupboard push --github-oidc https://cupboard.example.workers.dev/t/acme ./result \\',
				'    --root github:acme/app/main',
				'',
				'  # Push a shared intermediate without a root or pin',
				'  cupboard push --github-oidc https://cupboard.example.workers.dev/t/acme ./result \\',
				'    --no-retain',
				'',
				'  # Publish the whole closure of the result',
				'  cupboard push https://cupboard.example.workers.dev/t/acme ./result \\',
				'    --root github:acme/app/main --closure',
				'',
				'  # Publish build-time intermediates as well, without adding them to the root',
				'  cupboard push https://cupboard.example.workers.dev/t/acme ./result \\',
				'    --root github:acme/app/main --intermediate-paths-file intermediates.txt'
			].join('\n')
		)
		.action(async (url: URL, paths: string[], options: PushOptions) => {
			if (options.attest === false && options.attestation.length > 0) {
				throw new AttestationsDisabledError();
			}

			validateRetentionChoice(options);

			if (
				(options.readUser === undefined) !==
				(options.readPassword === undefined)
			) {
				throw new ReadCredentialPairError();
			}

			if (
				options.referenceReceiptFile !== undefined &&
				options.receiptFile !== undefined
			) {
				throw new ReferenceReceiptOptionError('conflict');
			}
			if (
				options.referenceReceiptFile !== undefined &&
				options.referenceManifest === undefined &&
				(options.referencePathsFile === undefined ||
					options.referenceSource === undefined)
			) {
				throw new ReferenceReceiptOptionError('source');
			}
			const buildStore = receiptBuildStore(options);

			if (
				(options.referencePathsFile === undefined) !==
				(options.referenceSource === undefined)
			) {
				throw new ReferenceSourcePairError();
			}

			// A path argument or a line in a path file may refer to a store path
			// through a symlink, so each is resolved through the filesystem first.
			// Anything that does not resolve to a store path is rejected before the
			// command requests a token provider. With `--github-oidc`, requesting a
			// token provider exchanges an OIDC token with the tenant. If the exchange
			// fails, the user sees an authentication error instead of an error about
			// the invalid path. One case is checked later: a first argument that
			// could be a cache name. Only a cache lookup, which needs a token
			// provider, determines whether the argument is a cache name or a path.
			const filePaths =
				options.pathsFile === undefined
					? []
					: resolvePushStorePaths(
							parsePathFile(await readFile(options.pathsFile, 'utf8'))
						);
			const intermediatePaths =
				options.intermediatePathsFile === undefined
					? undefined
					: resolvePushStorePaths(
							parsePathFile(
								await readFile(options.intermediatePathsFile, 'utf8')
							)
						);
			const referencePaths =
				options.referencePathsFile === undefined
					? undefined
					: resolvePushStorePaths(
							parsePathFile(await readFile(options.referencePathsFile, 'utf8'))
						);
			const references =
				options.referenceManifest === undefined
					? undefined
					: parseReferenceManifest(
							await readFile(options.referenceManifest, 'utf8')
						);
			const canAcceptEmptyPayload =
				filePaths.length > 0 ||
				(options.root !== undefined && options.dryRun !== true) ||
				intermediatePaths !== undefined ||
				referencePaths !== undefined ||
				references !== undefined;
			const resolved = await resolveAuthorisedCachePositionals(url, paths, {
				minimumPayload: canAcceptEmptyPayload ? 0 : 1,
				payloadDescription: 'a store path',
				parsePayloadEntry: resolvePushStorePath,
				authorise: async (target) => {
					const sourceReads = await referenceSourceReads(
						options,
						references ?? [],
						target,
						fetchCacheAccess
					);

					try {
						return await authenticate(
							CupboardClient.fromUrl(target.tenantUrl, {
								cache: target.cache,
								signal: programOptions.signal
							}),
							{
								githubOidc: options.githubOidc,
								audience:
									options.audience ?? audienceSchema.parse(target.tenantUrl),
								authorizationDetails: pushCommandAuthorizationDetails(
									options,
									target.cache,
									sourceReads.intents
								)
							}
						);
					} catch (error) {
						throw sourceReadRefusal(error, sourceReads.sources);
					}
				},
				signal: programOptions.signal
			});
			const publication = PublicationCollection.of({
				targets: [...resolved.payload, ...filePaths],
				...(intermediatePaths !== undefined && { intermediatePaths }),
				...(referencePaths !== undefined && { referencePaths }),
				...(references !== undefined && { references })
			});

			const isEmptyRootReplacement =
				publication.entries.length === 0 &&
				options.root !== undefined &&
				options.dryRun !== true;

			if (!isEmptyRootReplacement && publication.entries.length === 0) {
				throw new EmptyPublicationError();
			}
			const reporter = commandUi(program, programOptions).reporter();
			const cache = resolved.target.cache;

			const copiedFrom = await observedCopiesFrom(options.copiedFromFile);
			const receipt = await runPush(publication, reporter, {
				command: 'cupboard push',
				credential:
					options.githubOidc === true ? 'github-oidc' : 'cupboard-login',
				client: pushClientFor(resolved.target.tenantUrl, resolved.credential, {
					cache,
					signal: programOptions.signal
				}),
				...(options.store !== undefined && {
					nix: Nix.openForAvailability(undefined, {
						storeUri: options.store,
						...(programOptions.signal !== undefined && {
							signal: programOptions.signal
						})
					})
				}),
				...(options.store === undefined &&
					dependencies.openStore !== undefined && {
						openStore: dependencies.openStore
					}),
				...(options.closure !== undefined && { closure: options.closure }),
				...(options.referenceSource !== undefined && {
					referenceSource: {
						url: options.referenceSource,
						...(options.readUser !== undefined && {
							readUser: options.readUser,
							readPassword: options.readPassword
						})
					}
				}),
				wait: options.wait,
				signal: programOptions.signal,
				attest: options.attest,
				attestations: options.attestation.map((path) => ({ path })),
				...(options.root !== undefined && { root: options.root }),
				retention: rootRetentionChoice(options.ttl, options.permanent),
				...(options.runRoot !== undefined && {
					runRoot: {
						name: options.runRoot,
						retention: rootRetentionChoice(
							options.runRootTtl,
							options.runRootPermanent
						)
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
				...(buildStore !== undefined && { buildStore }),
				...(options.referenceReceiptFile !== undefined && {
					referenceReceipt: true
				}),
				...(options.alreadyHeld !== undefined && {
					alreadyHeld: options.alreadyHeld === false ? [] : options.alreadyHeld
				}),
				...(options.claimable !== undefined && {
					claimable: options.claimable === false ? [] : options.claimable
				}),
				...(copiedFrom !== undefined && { copiedFrom })
			});

			const receiptFile = options.referenceReceiptFile ?? options.receiptFile;
			if (receipt === undefined || receiptFile === undefined) {
				return;
			}

			await mkdir(path.dirname(receiptFile), { recursive: true });
			await writeFile(
				receiptFile,
				`${JSON.stringify(receipt, undefined, '\t')}\n`
			);
		});
}
