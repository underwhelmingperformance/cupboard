import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import {
	createNixDaemonStoreClient,
	discoverNixStoreConfig,
	Nix
} from '@cupboard/nix';
import { InvalidStorePathError } from '@cupboard/nix-store/errors';
import {
	type RootName,
	selectorForCache,
	storePathSchema,
	type StorePathString,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import { invocationIdSchema } from '@cupboard/protocol/build';
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
	verifyRebuilds: z.boolean().optional(),
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
 * The collector a cohort boundary invokes when the run opted into collection:
 * `nix store gc`, which sweeps only dead paths, so live roots (a target root,
 * the run root's server-side retention, a user's own gc roots) are untouched.
 * A boundary only runs after the cohort's publication has drained, so no
 * batch temporary roots are held either. Collection is an optimisation: a
 * failed sweep surfaces as a warning and never fails a green build.
 */
export function betweenCohortCollector(
	reporter: Pick<Reporter, 'warn'>,
	runCollector: (options: RunChildOptions) => Promise<ChildExit> = runChild
): () => Promise<void> {
	return async () => {
		const exit = await runCollector({
			command: ['nix', 'store', 'gc'],
			environment: process.env
		});

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
 * Parses a cohorts file's contents into the build invocations it names, in
 * order. The file is transport only; a body that is not JSON of the small
 * cohort shape refuses with {@link CohortsFileInvalidError}.
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
				...(cohort.verifyRebuilds !== undefined && {
					verifyRebuilds: cohort.verifyRebuilds
				}),
				...(cohort.keepGoing !== undefined && { keepGoing: cohort.keepGoing }),
				...(cohort.maxJobs !== undefined && { maxJobs: cohort.maxJobs })
			}
		};
	});
}

function parseUploadConcurrency(value: string): number {
	if (!/^\d+$/.test(value) || Number(value) < 1) {
		throw new InvalidUploadConcurrencyError(value);
	}

	return Number(value);
}

// The path file is transport only; every line must name a store path before
// any token is requested.
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
			'replace this named root with the built targets once every one is confirmed servable',
			parseRootName
		)
		.option(
			'--ttl <duration>',
			'expire the retained targets after this duration (e.g. 7d, 12h); default permanent',
			parseTtl
		)
		.option(
			'--no-retain',
			"publish without any target root; kept only by the cache's retention grace policy, if one matches"
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
			'--cohorts-file <path>',
			'JSON file naming the cohorts to build in order, each {"command": [...]} or {"installables": [...]}; replaces the -- build command'
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
				'build with failed publication or retention exits with the sysexits',
				'vocabulary: 77 authentication, 75 transient, 69 unavailable, and 74',
				'for a publication failure not otherwise classified.',
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

				const config = discoverNixStoreConfig();
				const daemon = createNixDaemonStoreClient(undefined, config);
				// The store Nix itself would read through: the daemon where one
				// answers, and this process's own reader on a machine where none
				// does, which is the machine a reconciled local run publishes from.
				const nix = Nix.open();

				reportUnknownSettings(reporter, nix.unknownSettings);
				// A multi-cohort run aggregates its receipts itself, so only the
				// single-cohort form hands the receipt file to the run.
				const perCohortReceiptFile =
					cohorts.length === 1 ? options.receiptFile : undefined;

				// Each cohort is its own supervising invocation, with its own
				// identity, runtime endpoint and preflight.
				const runCohort = (
					invocation: BuildInvocation
				): ReturnType<typeof runBuildPush> => {
					const invocationId = invocationIdSchema.parse(randomUUID());

					return runBuildPush(
						{
							invocation,
							...(targetRoot !== undefined && { root: targetRoot }),
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
							...(perCohortReceiptFile !== undefined && {
								receiptFile: perCohortReceiptFile
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
							client: pushClientFor(url, token, {
								cache: options.cache,
								signal: programOptions.signal
							}),
							store: nix,
							batchStore: {
								withConnection: (use) => daemon.withConnection(use)
							},
							storeDirectory: config.storeDirectory,
							invocationId,
							preflight: () =>
								preflightBuildPush({
									config,
									socketExists: (socketPath) => existsSync(socketPath),
									daemonTrust: () => daemon.daemonTrust(),
									invocationId,
									grants: authorizationDetails,
									cache: cacheSelector,
									...(options.runRoot !== undefined && {
										runRoot: options.runRoot
									}),
									...(targetRoot !== undefined && {
										targetRoots: [targetRoot]
									}),
									...(invocation.kind === 'constructed' && {
										verification: {
											verifyRebuilds: invocation.build.verifyRebuilds === true,
											installables: invocation.build.installables,
											requirements: (drvPath: string) =>
												nix.derivationBuildRequirements(drvPath)
										}
									})
								})
						}
					);
				};

				const result = await runCohortSequence(
					{
						cohorts,
						...(options.gcBetweenCohorts === true && {
							collectBetweenCohorts: true
						}),
						...(options.keepGoingCohorts === true && {
							keepGoingCohorts: true
						})
					},
					{ runCohort, collect: betweenCohortCollector(reporter) }
				);

				if (cohorts.length > 1 && options.receiptFile !== undefined) {
					await writeFile(
						options.receiptFile,
						`${JSON.stringify({ receipts: result.receipts }, undefined, '\t')}\n`
					);
				}

				const [firstFailure] = result.failures;

				if (firstFailure !== undefined) {
					throw firstFailure.error;
				}
			}
		);
}
