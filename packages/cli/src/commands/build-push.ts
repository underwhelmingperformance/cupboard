import { randomUUID } from 'node:crypto';
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
	storePathSchema,
	type StorePathString,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import {
	type BuildReceipt,
	buildReceiptSchema,
	type BuildReceiptV3,
	buildReceiptV3Schema,
	type BuildSubjectV3,
	invocationIdSchema
} from '@cupboard/protocol/build';
import type {
	RootRetentionRequest,
	RootSetBody
} from '@cupboard/protocol/retention';
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
	type RunChild,
	runChild
} from '../build-push/supervisor.ts';
import {
	cacheTargetFromUrl,
	cacheTargetWithName,
	splitDelimitedCachePositionals
} from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';
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
import { NarArchive } from '../nix/nar.ts';
import { reportUnknownSettings } from '../nix/settings.ts';
import { pushClientFor } from '../push/push-client.ts';
import { parseRootName } from '../root-name.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { parsePathFile, validateRetentionChoice } from './push.ts';
import { rootRetentionChoice } from './retention-choice.ts';

declare module 'commander' {
	interface Command {
		readonly rawArgs: string[];
	}
}

interface BuildPushOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
	readonly root?: RootName;
	readonly ttl?: TtlSeconds;
	readonly permanent?: boolean;
	readonly retain?: boolean;
	readonly closure?: boolean;
	readonly intermediatePathsFile?: string;
	readonly runRoot?: RootName;
	readonly runRootTtl?: TtlSeconds;
	readonly runRootPermanent?: boolean;
	readonly wait?: boolean;
	readonly waitTimeout?: WaitTimeoutSeconds;
	readonly uploadConcurrency?: number;
	readonly receiptFile?: string;
	readonly aggregateReceiptV3?: boolean;
	readonly cohortsFile?: string;
	readonly gcBetweenCohorts?: boolean;
	readonly keepGoingCohorts?: boolean;
}

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
 * Configures optional garbage collection between cohorts. Collection starts
 * only after the preceding cohort has published and released its temporary GC
 * roots.
 *
 * An ordinary collection failure produces a warning and does not fail the
 * build. A terminating signal still cancels the remaining cohorts.
 */
export interface BetweenCohortCollectorOptions {
	readonly signal?: AbortSignal;
	readonly runCollector?: RunChild;
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

/**
 * Deduplicates successful cohort targets and sorts them so aggregate-root
 * contents do not depend on cohort completion order.
 */
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
	subjects: Map<string, BuildSubjectV3>,
	subject: BuildSubjectV3
): void {
	if (
		subjects.get(subject.storePath)?.origin === 'built' &&
		subject.origin !== 'built'
	) {
		return;
	}

	subjects.set(subject.storePath, subject);
}

/**
 * Combines version 3 cohort receipts. A `built` subject takes precedence when
 * another cohort later finds the same path in its store, and terminal target
 * failures remain distinct from command failures.
 */
export function aggregateBuildReceipts(
	receipts: readonly BuildReceipt[]
): BuildReceiptV3 {
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
	const subjects = new Map<string, BuildSubjectV3>();

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

/**
 * Keeps the public multi-receipt envelope unless the caller explicitly asks
 * for the version 3 aggregate used by the action output.
 */
export function multiCohortReceiptDocument(
	receipts: readonly BuildReceipt[],
	shouldAggregateReceiptV3: boolean
): BuildReceiptV3 | { readonly receipts: readonly BuildReceipt[] } {
	return shouldAggregateReceiptV3
		? aggregateBuildReceipts(receipts)
		: { receipts: [...receipts] };
}

interface AggregateCohortRootOptions {
	readonly cohortCount: number;
	readonly failed: boolean;
	readonly root: RootName;
	readonly settledTargets: ReadonlyMap<number, readonly StorePathString[]>;
	readonly retention: RootRetentionRequest;
}

/**
 * Leaves the aggregate root unchanged after any cohort failure. Once every
 * cohort succeeds, replaces it with the deduplicated targets from all cohorts.
 */
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
		retention: options.retention
	});
}

async function writtenReceipt(
	receiptFile: string
): Promise<BuildReceipt | undefined> {
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

export function createNarArchiveForStore(
	store: Pick<Nix, 'storePathOnDisk'>
): (storePath: string) => NarArchive {
	return (storePath) => new NarArchive(store.storePathOnDisk(storePath));
}

export function registerBuildPushCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('build-push')
		.description(
			'Run a build command and publish each output as soon as Nix builds it.'
		)
		.usage('<url> [cache] [options] -- <build command...>')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument(
			'[arguments...]',
			'an optional cache name, then -- and the build command (leave out the command when you use --cohorts-file)'
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
			"when the build succeeds and the cache has verified every output, replace this root's targets with the built outputs",
			parseRootName
		)
		.option(
			'--ttl <duration>',
			'expire the root after this duration (e.g. 7d, 12h)',
			parseTtl
		)
		.option('--permanent', 'keep the root permanently')
		.option(
			'--no-retain',
			"publish without a root, so that only the cache's grace period keeps the paths"
		)
		.option(
			'--closure',
			'publish the whole closure of the built outputs (by default, only the built outputs)'
		)
		.option(
			'--intermediate-paths-file <path>',
			'file of extra store paths, one per line, to publish without adding them to the root'
		)
		.option(
			'--run-root <name>',
			'also add each published path to this run root as soon as the cache accepts it',
			parseRootName
		)
		.option(
			'--run-root-ttl <duration>',
			'expire the run root after this duration (e.g. 7d, 12h)',
			parseTtl
		)
		.option('--run-root-permanent', 'keep the run root permanently')
		.option(
			'--no-wait',
			'finish without waiting for the cache to verify the uploaded NARs. If some outputs are not yet verified, the root is left as it was.'
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
			'--receipt-file <path>',
			'write the build receipt (JSON) to this file. With several cohorts, the file contains {"receipts": [...]}, in cohort order.'
		)
		.option(
			'--aggregate-receipt-v3',
			'with several cohorts, write one combined version 3 receipt instead of {"receipts": [...]}'
		)
		.option(
			'--cohorts-file <path>',
			'JSON file that lists several builds (cohorts) to run in order, each {"command": [...]} or {"installables": [...]}. Use it instead of a build command after --.'
		)
		.option(
			'--gc-between-cohorts',
			'run garbage collection on the local Nix store between cohorts, so that a later cohort downloads shared outputs of earlier cohorts from the cache (off by default; there is no collection after the last cohort)'
		)
		.option(
			'--keep-going-cohorts',
			'run the remaining cohorts after one fails. The exit status is still that of the first cohort to fail.'
		)
		.addHelpText(
			'after',
			[
				'',
				'The build command must use the same Nix store as build-push. Do not',
				'pass --store to a Nix command inside it, and do not change',
				'NIX_REMOTE. build-push cannot see or publish outputs in another store.',
				'',
				"The build command's output is passed through unchanged. If the build",
				"fails, build-push exits with the build's own status. If the build",
				'succeeds but publishing or updating the root fails, build-push exits',
				'with 77 for a sign-in or permission failure, 75 for a temporary',
				'failure, 69 when something that publishing needs is unavailable, or',
				'74 for any other publishing failure.',
				'',
				'Examples:',
				"  # Build and publish the outputs, replacing a root's targets",
				'  cupboard build-push https://cupboard.example.workers.dev/t/acme \\',
				'    --root github:acme/app/main -- nix build --no-link .#app',
				'',
				'  # Publish to the named cache builds (give the cache name before --)',
				'  cupboard build-push https://cupboard.example.workers.dev/t/acme builds \\',
				'    --root github:acme/app/main -- nix build --no-link .#app',
				'',
				'  # Build in CI, signing in with the GitHub Actions OIDC token, and add a run root',
				'  cupboard build-push --github-oidc --root github:acme/app/main \\',
				'    --run-root github:acme/app/run-123 --run-root-ttl 2d \\',
				'    https://cupboard.example.workers.dev/t/acme -- nix build --no-link .#app'
			].join('\n')
		)
		.action(
			async (url: URL, commandParts: string[], options: BuildPushOptions) => {
				validateRetentionChoice(options);
				const delimited = splitDelimitedCachePositionals(
					commandParts,
					program.rawArgs,
					{
						withoutSeparator:
							options.cohortsFile === undefined
								? 'command-payload'
								: 'cache-only'
					}
				);

				if (
					delimited.payload.length > 0 ===
					(options.cohortsFile !== undefined)
				) {
					throw new CohortInputError();
				}

				const targetRoot = options.retain === false ? undefined : options.root;
				const urlTarget = cacheTargetFromUrl(url);
				const target =
					delimited.cacheName === undefined
						? urlTarget
						: cacheTargetWithName(urlTarget, delimited.cacheName);
				const credential = await authenticateForPush(
					CupboardClient.fromUrl(target.tenantUrl, {
						cache: target.cache,
						signal: programOptions.signal
					}),
					{
						githubOidc: options.githubOidc,
						audience:
							options.audience ?? audienceSchema.parse(target.tenantUrl),
						authorizationDetails: pushAuthorizationDetails({
							cache: target.cache,
							attest: false,
							...(targetRoot !== undefined && { root: targetRoot }),
							...(options.runRoot !== undefined && {
								runRoot: options.runRoot
							})
						})
					}
				);

				const cohorts: readonly BuildInvocation[] =
					options.cohortsFile === undefined
						? [{ kind: 'command', command: childCommand(delimited.payload) }]
						: parseCohortsFile(await readFile(options.cohortsFile, 'utf8'));

				const intermediatePaths =
					options.intermediatePathsFile === undefined
						? undefined
						: parseStorePathFile(
								await readFile(options.intermediatePathsFile, 'utf8')
							);
				const reporter = commandUi(program, programOptions).reporter();
				const cache = target.cache;
				const authorizationDetails = pushAuthorizationDetails({
					cache,
					attest: false,
					...(targetRoot !== undefined && { root: targetRoot }),
					...(options.runRoot !== undefined && {
						runRoot: options.runRoot
					})
				});
				const pushClient = pushClientFor(target.tenantUrl, credential, {
					cache,
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
				const nix = Nix.open();
				const createNarArchive = createNarArchiveForStore(nix);

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
								withProtectedPaths: (use) =>
									openDaemon().withConnection((session) =>
										use({
											protectPath: (storePath) =>
												session.addTempRoot(storePath),
											queryPathInfo: (storePath) =>
												session.queryPathInfo(storePath)
										})
									)
							},
							storeDirectory: nix.storeDirectory,
							createNarArchive,
							invocationId,
							settledTargets: (targets) => {
								settledTargets.set(cohort, targets);
							},
							preflight: () =>
								preflightBuildPush({
									config,
									storeKind: nix.storeKind,
									stateDirectory: nix.stateDirectory ?? config.stateDirectory,
									daemonTrust: () => openDaemon().daemonTrust(),
									invocationId,
									grants: authorizationDetails,
									cache,
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
							recoverReceipt: (_error, cohort) => {
								const receiptFile = receiptFileFor(cohort);

								return receiptFile === undefined
									? Promise.resolve(undefined)
									: writtenReceipt(receiptFile);
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
								retention: rootRetentionChoice(options.ttl, options.permanent)
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
