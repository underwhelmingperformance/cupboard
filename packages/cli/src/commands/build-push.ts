import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	createNixDaemonStoreClient,
	discoverNixStoreConfig,
	Nix,
	type NixDaemonClientOptions,
	type NixStoreConfig
} from '@cupboard/nix';
import { InvalidStorePathError } from '@cupboard/nix-store/errors';
import {
	type RootName,
	selectorForCache,
	storePathSchema,
	type StorePathString,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import {
	buildReceiptSchema,
	buildReceiptV3Schema,
	invocationIdSchema,
	type ParsedBuildReceipt,
	type ParsedBuildReceiptV3,
	type ParsedBuildSubjectV3
} from '@cupboard/protocol/build';
import type { RootSetBody } from '@cupboard/protocol/retention';
import type { Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';
import { z } from 'zod';

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { pushAuthorizationDetails } from '../auth/attenuate.ts';
import { authenticateForPush } from '../auth/auth.ts';
import {
	type BuildInvocation,
	childExitCode,
	runBuildPush
} from '../build-push/build-push.ts';
import { runCohortSequence } from '../build-push/cohorts.ts';
import { preflightBuildPush } from '../build-push/preflight.ts';
import {
	type ChildCommand,
	type ChildExit,
	runChild,
	type RunChildOptions
} from '../build-push/supervisor.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient, storedCacheFor } from '../client/client.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	parseTtl,
	parseWaitTimeout,
	type WaitTimeoutSeconds
} from '../duration.ts';
import {
	BuildCommandFailedError,
	CohortInputError,
	CohortsFileInvalidError,
	InvalidUploadConcurrencyError
} from '../errors.ts';
import { reportUnknownSettings } from '../nix/settings.ts';
import { pushClientFor } from '../push/push-client.ts';
import { parseRootName } from '../root-name.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { parsePathFile, validateRetentionChoice } from './push.ts';

interface BuildPushOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
	readonly root?: RootName;
	readonly ttl?: TtlSeconds;
	readonly retain?: boolean;
	readonly closure?: boolean;
	readonly intermediatePathsFile?: string;
	readonly runRoot?: RootName;
	readonly runRootTtl?: TtlSeconds;
	readonly cache?: string;
	readonly wait?: boolean;
	readonly waitTimeout?: WaitTimeoutSeconds;
	readonly uploadConcurrency?: number;
	readonly receiptFile?: string;
	readonly aggregateReceiptV3?: boolean;
	readonly cohortsFile?: string;
	readonly gcBetweenCohorts?: boolean;
	readonly keepGoingCohorts?: boolean;
}

// The cohorts file is deliberately small: each cohort is either a child
// command supervised unchanged, or the installables of a constructed nix
// invocation with its attempt settings.
const commandCohortSchema = z.strictObject({
	command: z.array(z.string().min(1)).min(1)
});
const constructedCohortSchema = z.strictObject({
	installables: z.array(z.string().min(1)).min(1),
	attempts: z.number().int().positive().optional(),
	rebuild: z.boolean().optional(),
	requireProvenance: z.boolean().optional(),
	keepGoing: z.boolean().optional(),
	// Zero is Nix's remote-builders-only setting: no local build slots.
	maxJobs: z.number().int().nonnegative().optional()
});
const cohortsFileSchema = z.strictObject({
	cohorts: z
		.array(z.union([commandCohortSchema, constructedCohortSchema]))
		.min(1)
});

/**
 * Runs `nix store gc` at a cohort boundary when the run opted into collection.
 * `nix store gc` deletes only dead paths, so anything a local gc root keeps
 * alive survives. Paths already published are retained on the server, which a
 * local collection does not touch. A boundary runs only after the cohort's
 * publication has finished, so no batch temporary roots are held either.
 *
 * Collection is an optimisation: a failed collection is reported as a warning
 * and never turns a successful build into a failure, while a collection killed
 * by a signal cancels the rest of the sequence.
 */
export interface BetweenCohortCollectorOptions {
	/** The enclosing CLI run's cancellation signal. */
	readonly signal?: AbortSignal;
	/** Runs the collector child; injectable for tests. */
	readonly runCollector?: (options: RunChildOptions) => Promise<ChildExit>;
}

export function betweenCohortCollector(
	reporter: Pick<Reporter, 'warn'>,
	options: BetweenCohortCollectorOptions = {}
): () => Promise<void> {
	return async () => {
		options.signal?.throwIfAborted();

		const exit = await (options.runCollector ?? runChild)({
			command: ['nix', 'store', 'gc'],
			environment: process.env,
			...(options.signal !== undefined && { signal: options.signal })
		});
		options.signal?.throwIfAborted();

		const signal =
			exit.signal ??
			(exit.status === 130
				? 'SIGINT'
				: exit.status === 143
					? 'SIGTERM'
					: undefined);

		if (signal !== undefined) {
			throw new BuildCommandFailedError(
				exit.status,
				signal,
				childExitCode(exit)
			);
		}

		if (exit.status === 0) {
			return;
		}

		reporter.warn(
			'collection failed',
			`nix store gc exited ${String(childExitCode(exit))}; the next cohort builds with the store as it stands`
		);
	};
}

function childCommand(parts: readonly string[]): ChildCommand {
	const [executable, ...rest] = parts;

	if (executable === undefined) {
		throw new CohortsFileInvalidError();
	}

	return [executable, ...rest];
}

/**
 * Parses the contents of a cohorts file into build invocations, in order.
 * Contents that are not JSON of the cohort shape are refused with
 * {@link CohortsFileInvalidError}.
 */
export function parseCohortsFile(contents: string): readonly BuildInvocation[] {
	let json: unknown;
	try {
		json = JSON.parse(contents);
	} catch (error) {
		throw new CohortsFileInvalidError({ cause: error });
	}

	const parsed = cohortsFileSchema.safeParse(json);

	if (!parsed.success) {
		throw new CohortsFileInvalidError({ cause: parsed.error });
	}

	return parsed.data.cohorts.map((cohort): BuildInvocation => {
		if ('command' in cohort) {
			return { kind: 'command', command: childCommand(cohort.command) };
		}

		return {
			kind: 'constructed',
			build: {
				installables: cohort.installables,
				...(cohort.attempts !== undefined && { attempts: cohort.attempts }),
				...(cohort.rebuild !== undefined && { rebuild: cohort.rebuild }),
				...(cohort.requireProvenance !== undefined && {
					requireProvenance: cohort.requireProvenance
				}),
				...(cohort.keepGoing !== undefined && { keepGoing: cohort.keepGoing }),
				...(cohort.maxJobs !== undefined && { maxJobs: cohort.maxJobs })
			}
		};
	});
}

/** Successful cohort targets retained by one aggregate multi-cohort root. */
export function aggregateCohortTargets(
	cohorts: readonly (readonly StorePathString[])[]
): readonly StorePathString[] {
	return [...new Set(cohorts.flat())].toSorted((left, right) =>
		left.localeCompare(right)
	);
}

function unique<T>(values: readonly T[]): readonly T[] {
	return [...new Set(values)];
}

// One path can appear in several cohorts: the cohort that built it records the
// build, and a later cohort finds it already in the store. Keep the `built`
// subject whichever order the receipts arrive in.
function recordAggregateSubject(
	subjects: Map<string, ParsedBuildSubjectV3>,
	subject: ParsedBuildSubjectV3
): void {
	if (
		subjects.get(subject.storePath)?.origin === 'built' &&
		subject.origin !== 'built'
	) {
		return;
	}

	subjects.set(subject.storePath, subject);
}

/** One schema-valid receipt over every settled cohort in a sequence. */
export function aggregateBuildReceipts(
	receipts: readonly ParsedBuildReceipt[]
): ParsedBuildReceiptV3 {
	const parsed = receipts.map((receipt) => buildReceiptV3Schema.parse(receipt));
	const terminalFailures = parsed.flatMap((receipt) =>
		receipt.terminalFailure === undefined ? [] : [receipt.terminalFailure]
	);
	const targetFailures = terminalFailures.flatMap((failure) =>
		failure.kind === 'target-build' ? failure.failedTargets : []
	);
	const terminalFailure =
		terminalFailures.length === 0
			? undefined
			: terminalFailures.every((failure) => failure.kind === 'target-build')
				? ({
						kind: 'target-build',
						failedTargets: unique(targetFailures)
					} as const)
				: ({ kind: 'command' } as const);
	const firstFailedReceipt = parsed.find(
		(receipt) => receipt.terminalFailure !== undefined
	);
	const subjects = new Map<string, ParsedBuildSubjectV3>();

	for (const receipt of parsed) {
		for (const subject of receipt.subjects) {
			recordAggregateSubject(subjects, subject);
		}
	}

	return buildReceiptV3Schema.parse({
		version: 3,
		paths: unique(parsed.flatMap((receipt) => receipt.paths)),
		subjects: subjects.values().toArray(),
		...(firstFailedReceipt?.childExitStatus !== undefined && {
			childExitStatus: firstFailedReceipt.childExitStatus
		}),
		...(terminalFailure !== undefined && { terminalFailure }),
		uploaded: unique(parsed.flatMap((receipt) => receipt.uploaded ?? [])),
		failed: unique(parsed.flatMap((receipt) => receipt.failed ?? [])),
		collected: unique(parsed.flatMap((receipt) => receipt.collected ?? []))
	});
}

/** The stable public multi-cohort envelope, or the action's explicit V3 view. */
export function multiCohortReceiptDocument(
	receipts: readonly ParsedBuildReceipt[],
	shouldAggregateReceiptV3: boolean
): ParsedBuildReceiptV3 | { readonly receipts: readonly ParsedBuildReceipt[] } {
	return shouldAggregateReceiptV3
		? aggregateBuildReceipts(receipts)
		: { receipts: [...receipts] };
}

interface AggregateCohortRootOptions {
	readonly cohortCount: number;
	readonly failed: boolean;
	readonly root: RootName;
	readonly settledTargets: ReadonlyMap<number, readonly StorePathString[]>;
	readonly ttlSeconds?: TtlSeconds;
}

/** Replaces a multi-cohort root once, and only after every cohort succeeded. */
export async function updateAggregateCohortRoot(
	options: AggregateCohortRootOptions,
	setRoot: (root: RootName, body: RootSetBody) => Promise<void>
): Promise<void> {
	if (options.failed) {
		return;
	}

	const targetGroups = Array.from({ length: options.cohortCount }).flatMap(
		(_unused, index) => {
			const targets = options.settledTargets.get(index + 1);

			return targets === undefined ? [] : [targets];
		}
	);
	const targets = aggregateCohortTargets(targetGroups);

	await setRoot(options.root, {
		targets: [...targets],
		...(options.ttlSeconds !== undefined && {
			ttlSeconds: options.ttlSeconds
		})
	});
}

async function settledReceipt(
	receiptFile: string
): Promise<ParsedBuildReceipt | undefined> {
	try {
		return buildReceiptSchema.parse(
			JSON.parse(await readFile(receiptFile, 'utf8'))
		);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return;
		}

		throw error;
	}
}

function parseUploadConcurrency(value: string): number {
	if (!/^\d+$/.test(value) || Number(value) < 1) {
		throw new InvalidUploadConcurrencyError(value);
	}

	return Number(value);
}

/**
 * Opens the Nix daemon connection used by build-push preflight and batched
 * publication. The connection is bound to the command's abort signal, so
 * cancelling the command also abandons a connection that is waiting on a daemon
 * protocol operation.
 */
export function createBuildPushDaemon(
	config: NixStoreConfig,
	options: Pick<NixDaemonClientOptions, 'connect' | 'signal'>
): ReturnType<typeof createNixDaemonStoreClient> {
	return createNixDaemonStoreClient(undefined, config, options);
}

// Every line must parse as a store path. Checking here rejects a bad line
// before any token is requested.
function parseStorePathFile(contents: string): readonly StorePathString[] {
	return parsePathFile(contents).map((line) => {
		const parsed = storePathSchema.safeParse(line);

		if (!parsed.success) {
			throw new InvalidStorePathError(line);
		}

		return parsed.data;
	});
}

export function registerBuildPushCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('build-push')
		.description(
			'Run a build command under streaming publication: completed outputs ' +
				'upload while the build continues, and a final reconciliation ' +
				'settles roots and writes the build receipt.'
		)
		.usage('<url> [options] -- <build command...>')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument(
			'[command...]',
			'the build command to run, after a -- separator (e.g. nix build --no-link .#target); replaced by --cohorts-file for a multi-cohort run'
		)
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
			'replace this named root with the built targets once every target is confirmed servable',
			parseRootName
		)
		.option(
			'--ttl <duration>',
			'expire the retained targets after this duration (e.g. 7d, 12h); default permanent',
			parseTtl
		)
		.option(
			'--no-retain',
			"publish without any target root; the paths are kept only by the destination cache's retention grace policy, if one covers that cache"
		)
		.option(
			'--closure',
			'publish the complete realised closure of the built targets (default: exactly the built outputs)'
		)
		.option(
			'--intermediate-paths-file <path>',
			'newline-delimited store paths to publish alongside the targets without retaining them as targets'
		)
		.option(
			'--run-root <name>',
			'bind a run root: every path joins this root as it commits, whether streamed or reconciled',
			parseRootName
		)
		.option(
			'--run-root-ttl <duration>',
			'expire the run root after this duration (e.g. 7d, 12h); default per the tenant retention policy, else permanent',
			parseTtl
		)
		.option('--cache <name>', 'push to a named cache rather than the default')
		.option(
			'--no-wait',
			'reconcile without waiting for deferred blobs to become servable; an unconfirmed root is left untouched'
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
			'--receipt-file <path>',
			'write the build receipt (JSON) to this file; a multi-cohort run writes {"receipts": [...]} in cohort order'
		)
		.option(
			'--aggregate-receipt-v3',
			'write one schema-valid V3 aggregate instead of the public multi-cohort receipt envelope'
		)
		.option(
			'--cohorts-file <path>',
			'JSON file listing the cohorts to build, in order, each {"command": [...]} or {"installables": [...]}; replaces the -- build command'
		)
		.option(
			'--gc-between-cohorts',
			'collect the local Nix store between cohorts, so a later cohort substitutes the earlier shared work from the cache (default: off; nothing is collected after the last cohort)'
		)
		.option(
			'--keep-going-cohorts',
			'continue with the remaining cohorts after one fails; the run still exits with the first failed cohort status'
		)
		.addHelpText(
			'after',
			[
				'',
				'The build command runs with its output and exit status untouched: a',
				'failed build exits with the build command status. A successful',
				'build with failed publication or retention exits with a sysexits',
				'code: 77 authentication, 75 transient, 69 unavailable, or 74 for a',
				'publication failure not otherwise classified.',
				'',
				'Examples:',
				'  # Build and stream the outputs to a tenant, replacing a named root',
				'  cupboard build-push https://cache.example.workers.dev/t/acme \\',
				'    --root github:acme/infra/main -- nix build --no-link .#app',
				'',
				'  # Build from CI with a GitHub Actions OIDC token and a run root',
				'  cupboard build-push --github-oidc --root github:acme/infra/main \\',
				'    --run-root github:acme/infra/run-123 --run-root-ttl 2d \\',
				'    https://cache.example.workers.dev/t/acme -- nix build --no-link .#app'
			].join('\n')
		)
		.action(
			async (url: URL, commandParts: string[], options: BuildPushOptions) => {
				validateRetentionChoice(options);

				// Exactly one build input: a -- command builds a single cohort, and a
				// cohorts file names the multi-cohort form.
				if (commandParts.length > 0 === (options.cohortsFile !== undefined)) {
					throw new CohortInputError();
				}

				const cohorts: readonly BuildInvocation[] =
					options.cohortsFile === undefined
						? [{ kind: 'command', command: childCommand(commandParts) }]
						: parseCohortsFile(await readFile(options.cohortsFile, 'utf8'));

				const intermediatePaths =
					options.intermediatePathsFile === undefined
						? undefined
						: parseStorePathFile(
								await readFile(options.intermediatePathsFile, 'utf8')
							);
				const reporter = commandUi(program, programOptions).reporter();
				const raw = CupboardClient.fromUrl(url, {
					cache: options.cache,
					signal: programOptions.signal
				});
				const cacheSelector = selectorForCache(storedCacheFor(options.cache));
				const targetRoot = options.retain === false ? undefined : options.root;
				const authorizationDetails = pushAuthorizationDetails({
					cacheSelector,
					attest: false,
					...(targetRoot !== undefined && { root: targetRoot }),
					...(options.runRoot !== undefined && { runRoot: options.runRoot })
				});
				const token = await authenticateForPush(raw, {
					githubOidc: options.githubOidc,
					audience: options.audience ?? audienceSchema.parse(url),
					authorizationDetails
				});
				const pushClient = pushClientFor(url, token, {
					cache: options.cache,
					signal: programOptions.signal
				});

				const config = discoverNixStoreConfig();
				let daemon: ReturnType<typeof createNixDaemonStoreClient> | undefined;
				const openDaemon = (): ReturnType<
					typeof createNixDaemonStoreClient
				> => {
					daemon ??= createBuildPushDaemon(config, {
						signal: programOptions.signal
					});

					return daemon;
				};
				// The store Nix itself would read through: the daemon where one
				// answers, and this process's own reader on a machine where none
				// does, which is the machine a reconciled local run publishes from.
				const nix = Nix.open();

				reportUnknownSettings(reporter, nix.unknownSettings);
				const sequenceDirectory =
					cohorts.length === 1
						? undefined
						: await mkdtemp(path.join(tmpdir(), 'cupboard-build-push-'));
				const receiptFileFor = (cohort: number): string | undefined =>
					sequenceDirectory === undefined
						? options.receiptFile
						: path.join(sequenceDirectory, `cohort-${String(cohort)}.json`);
				const settledTargets = new Map<number, readonly StorePathString[]>();

				// Each cohort is its own supervising invocation, with its own
				// identity, runtime endpoint and preflight.
				const runCohort = (
					invocation: BuildInvocation,
					cohort: number
				): ReturnType<typeof runBuildPush> => {
					const invocationId = invocationIdSchema.parse(randomUUID());
					const receiptFile = receiptFileFor(cohort);

					return runBuildPush(
						{
							invocation,
							...(cohorts.length === 1 &&
								targetRoot !== undefined && {
									root: targetRoot
								}),
							...(options.ttl !== undefined && { ttlSeconds: options.ttl }),
							...(options.runRoot !== undefined && {
								runRoot: {
									name: options.runRoot,
									...(options.runRootTtl !== undefined && {
										ttlSeconds: options.runRootTtl
									})
								}
							}),
							...(options.closure !== undefined && {
								closure: options.closure
							}),
							...(intermediatePaths !== undefined && { intermediatePaths }),
							...(receiptFile !== undefined && {
								receiptFile
							}),
							...(options.wait !== undefined && { wait: options.wait }),
							...(options.waitTimeout !== undefined && {
								waitTimeoutSeconds: options.waitTimeout
							}),
							...(options.uploadConcurrency !== undefined && {
								uploadConcurrency: options.uploadConcurrency
							})
						},
						reporter,
						{
							client: pushClient,
							store: nix,
							batchStore: {
								withConnection: (use) => openDaemon().withConnection(use)
							},
							storeDirectory: config.storeDirectory,
							invocationId,
							settledTargets: (targets) => {
								settledTargets.set(cohort, targets);
							},
							preflight: () =>
								preflightBuildPush({
									config,
									socketExists: (socketPath) => existsSync(socketPath),
									daemonTrust: () => openDaemon().daemonTrust(),
									invocationId,
									grants: authorizationDetails,
									cache: cacheSelector,
									...(options.runRoot !== undefined && {
										runRoot: options.runRoot
									}),
									...(targetRoot !== undefined && {
										targetRoots: [targetRoot]
									})
								})
						}
					);
				};

				try {
					const result = await runCohortSequence(
						{
							cohorts,
							signal: programOptions.signal,
							...(options.gcBetweenCohorts === true && {
								collectBetweenCohorts: true
							}),
							...(options.keepGoingCohorts === true && {
								keepGoingCohorts: true
							})
						},
						{
							runCohort,
							settledReceipt: (_error, cohort) => {
								const receiptFile = receiptFileFor(cohort);

								return receiptFile === undefined
									? Promise.resolve(undefined)
									: settledReceipt(receiptFile);
							},
							collect: betweenCohortCollector(reporter, {
								signal: programOptions.signal
							})
						}
					);
					const [firstFailure] = result.failures;

					if (cohorts.length > 1 && options.receiptFile !== undefined) {
						const receipt = multiCohortReceiptDocument(
							result.receipts,
							options.aggregateReceiptV3 === true
						);
						await writeFile(
							options.receiptFile,
							`${JSON.stringify(receipt, undefined, '\t')}\n`
						);
					}

					if (targetRoot !== undefined && cohorts.length > 1) {
						await updateAggregateCohortRoot(
							{
								cohortCount: cohorts.length,
								failed: firstFailure !== undefined,
								root: targetRoot,
								settledTargets,
								...(options.ttl !== undefined && {
									ttlSeconds: options.ttl
								})
							},
							(root, body) =>
								reporter.phase('Updating retention root', async () => {
									await pushClient.setRoot(root, body);
								})
						);
					}

					if (firstFailure !== undefined) {
						throw firstFailure.error;
					}
				} finally {
					if (sequenceDirectory !== undefined) {
						await rm(sequenceDirectory, { recursive: true, force: true });
					}
				}
			}
		);
}
