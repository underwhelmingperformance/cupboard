import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process, { env } from 'node:process';

import {
	dependencyOutputs,
	discoverNixStoreConfig,
	Nix,
	type NixBuildSettings,
	type NixStoreConfig,
	NixStorePathNotFoundError,
	type NixValidPathInfo,
	parseSshNgStoreUri,
	selectPublicationPaths,
	tenantDependencyReferences,
	tenantReferenceSources
} from '@cupboard/nix';
import { receiptSubjects as observedReceiptSubjects } from '@cupboard/nix/build-observation';
import { parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
import { derivationPathOf } from '@cupboard/nix-store/derivation';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import { storePathSchema } from '@cupboard/nix-store/scalars';
import {
	autoBuildStore,
	type BuildReceiptV2Input,
	buildReceiptV3Schema,
	type BuildSubjectV3Input
} from '@cupboard/protocol/build';
import {
	observeChildProcess,
	waitForAbortableChildProcess
} from '@cupboard/shared/child-process';
import { withCleanups } from '@cupboard/shared/cleanup';
import type { Command } from 'commander';
import { z } from 'zod';

import { HookFailureDetector } from '../build-paths/hook-failure.ts';
import {
	createJobRoots,
	type JobOutputProtection,
	jobOutputProtection,
	jobRootsEnvironmentKey
} from '../build-paths/job-roots.ts';
import {
	type BuildObservation,
	BuildObservationIncompleteError,
	type BuildObservationOptions,
	observeBuild
} from '../build-paths/observation.ts';
import {
	BuildAttemptsInvalidError,
	BuildInstallableInvalidError,
	BuildInstallablesMissingError,
	BuildObservationMissingError,
	BuildProvenanceConflictError,
	BuildPublicationUrlMissingError,
	BuildRebuildRemoteDispatchError,
	CommandFailedError
} from '../errors.ts';
import {
	appendEnvironmentFile,
	type Environment,
	parseLines,
	requireEnvironment,
	setOutput
} from '../inputs.ts';
import {
	collectLines,
	isEnabled,
	isNixPositionalArgument,
	provided,
	providedChoice
} from '../options.ts';

export interface BuildActivity {
	readonly derivation: string;
	readonly machine: string;
	readonly verifiedByCheck?: boolean;
}

export interface BuildAttempt {
	readonly attempt: number;
	readonly attemptId: string;
	readonly activities: readonly BuildActivity[];
	readonly validatedOutputs?: readonly NixValidPathInfo[];
}

export interface BuildOptions {
	readonly inlinePaths?: string;
	readonly cupboardPath?: string;
	readonly intermediatePathsFile?: string;
	readonly publicationUrl?: string;
	readonly publish?: string;
	readonly installables?: readonly string[];
	readonly installablesFile?: string;
	readonly attempts?: string;
	readonly keepGoing?: string;
	readonly maxJobs?: string;
	readonly allowFailure?: string;
	readonly build?: string;
	readonly requireProvenance?: string;
	readonly substituter?: string;
	readonly pathsFile?: string;
	readonly publishPathsFile?: string;
	readonly receiptFile?: string;
}

export interface RunResult {
	readonly status: number | undefined;
	readonly stdout: string;
	readonly hookDeliveryFailed?: boolean;
}

export interface NixInvocation {
	readonly arguments: readonly string[];
	readonly stdin: string;
	readonly environment?: Environment;
}

export interface BuildDependencies {
	readonly buildSettings?: NixBuildSettings;
	readonly protection?: JobOutputProtection;
	readonly createObservation?: (
		options: BuildObservationOptions
	) => Promise<BuildObservation>;
	readonly runNix?: (
		invocation: NixInvocation,
		signal?: AbortSignal
	) => Promise<RunResult>;
	readonly nix?: Pick<Nix, 'queryPathInfo'>;
	readonly graphNix?: Pick<Nix, 'readDerivation'>;
	readonly tenantDependencyReferences?: typeof tenantDependencyReferences;
	readonly availabilityNix?: Pick<
		Nix,
		| 'resolveSubstitutableClosure'
		| 'canSubstituteDerivation'
		| 'honoursSubstituterSettings'
	>;
	readonly availabilitySettings?: Pick<
		NixStoreConfig,
		'substitution' | 'signatures'
	>;
	readonly nextAttemptId?: () => string;
	readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	readonly signal?: AbortSignal;
}

const defaultBuildAttempts = 5;

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();

	return new Promise((resolve, reject) => {
		let hasSettled = false;
		const timeout = setTimeout(() => {
			if (hasSettled) {
				return;
			}

			hasSettled = true;
			signal?.removeEventListener('abort', abort);
			resolve();
		}, delayMs);
		const abort = (): void => {
			if (hasSettled) {
				return;
			}

			hasSettled = true;
			clearTimeout(timeout);
			signal?.removeEventListener('abort', abort);
			const reason: unknown = signal?.reason;

			reject(
				reason instanceof Error
					? reason
					: new Error('The retry delay was aborted', { cause: reason })
			);
		};

		signal?.addEventListener('abort', abort, { once: true });

		if (signal?.aborted === true) {
			abort();
		}
	});
}

export async function runNix(
	invocation: NixInvocation,
	signal?: AbortSignal
): Promise<RunResult> {
	signal?.throwIfAborted();

	const child = spawn('nix', [...invocation.arguments], {
		stdio: ['pipe', 'pipe', 'pipe'],
		...(invocation.environment !== undefined && {
			env: { ...invocation.environment }
		})
	});
	const observed = observeChildProcess(child);
	let stdout = '';
	const hookFailures = new HookFailureDetector();
	let hasHookDeliveryFailed = false;
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		hasHookDeliveryFailed = hookFailures.accept(chunk);
		process.stderr.write(chunk);
	});

	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk;
	});

	const completion = waitForAbortableChildProcess(
		{
			...observed,
			onceError(listener) {
				observed.onceError(listener);
				child.stdin.once('error', listener);
			}
		},
		signal
	);

	child.stdin.end(invocation.stdin);

	const result = await completion;

	if (result.error !== undefined) {
		throw result.error;
	}

	return {
		status: result.status ?? undefined,
		stdout,
		hookDeliveryFailed: hasHookDeliveryFailed
	};
}

function nixBuildInvocation(
	arguments_: readonly string[],
	installables: readonly string[]
): NixInvocation {
	return {
		arguments: [...arguments_, '--stdin'],
		stdin: `${installables.join('\n')}\n`
	};
}

const activityHeaderSchema = z.object({
	action: z.string(),
	type: z.number()
});
const buildActivityStartSchema = z.object({
	action: z.literal('start'),
	type: z.literal(105),
	fields: z.tuple([z.string().endsWith('.drv'), z.string()]).rest(z.unknown())
});

export function buildActivities(log: string): BuildActivity[] {
	const activities = new Map<string, BuildActivity>();

	for (const line of log.split(/\r?\n/u)) {
		if (line === '') {
			continue;
		}

		const record: unknown = JSON.parse(line);
		const header = activityHeaderSchema.safeParse(record);
		if (
			!header.success ||
			header.data.action !== 'start' ||
			header.data.type !== 105
		) {
			continue;
		}

		const build = buildActivityStartSchema.parse(record);
		const [derivation, machine] = build.fields;
		const previous = activities.get(derivation);
		if (previous !== undefined && previous.machine !== '') {
			continue;
		}

		activities.set(derivation, { derivation, machine });
	}

	return activities
		.values()
		.toArray()
		.toSorted((left, right) => left.derivation.localeCompare(right.derivation));
}

async function readBuildActivities(logFile: string): Promise<BuildActivity[]> {
	let log: string;
	try {
		log = await readFile(logFile, 'utf8');
	} catch {
		return [];
	}

	return buildActivities(log);
}

async function queryExistingOutputInfos(
	storePaths: readonly string[],
	queryOutputInfo: (storePath: string) => Promise<NixValidPathInfo>
): Promise<NixValidPathInfo[]> {
	const states = await Promise.allSettled(
		storePaths.map((storePath) => queryOutputInfo(storePath))
	);
	for (const state of states) {
		if (state.status !== 'rejected') {
			continue;
		}
		const reason: unknown = state.reason;
		if (reason instanceof NixStorePathNotFoundError) {
			continue;
		}
		if (reason instanceof Error) {
			throw reason;
		}
		throw new Error('Could not query the requested build outputs', {
			cause: reason
		});
	}
	return states.flatMap((state) =>
		state.status === 'fulfilled' ? [state.value] : []
	);
}

export function derivationsRequiringVerification(
	finalInfos: readonly NixValidPathInfo[],
	preExisting: ReadonlySet<string>,
	plannedPaths: ReadonlySet<string>,
	uncertainInitialPaths: ReadonlySet<string>
): string[] {
	const derivations = new Set<string>();

	for (const info of finalInfos) {
		if (info.deriver === undefined) {
			continue;
		}

		if (
			preExisting.has(info.storePath) ||
			!plannedPaths.has(info.storePath) ||
			uncertainInitialPaths.has(info.storePath) ||
			!info.ultimate
		) {
			derivations.add(info.deriver);
		}
	}

	return derivations
		.values()
		.toArray()
		.toSorted((left, right) => left.localeCompare(right));
}

export function receiptSubjects(
	attempts: readonly BuildAttempt[],
	finalInfos: readonly NixValidPathInfo[],
	preExisting: ReadonlySet<string>,
	provenanceRebuilds: ReadonlySet<string> = new Set()
): BuildReceiptV2Input['subjects'] {
	const hasExplicitChecks = attempts.some((attempt) =>
		attempt.activities.some((activity) => activity.verifiedByCheck === true)
	);
	const subjects = observedReceiptSubjects(
		attempts.map((attempt) => ({
			attempt: attempt.attempt,
			attemptId: attempt.attemptId,
			activities: attempt.activities,
			...(attempt.validatedOutputs !== undefined && {
				completedOutputs: attempt.validatedOutputs.map((info) => ({
					storePath: info.storePath,
					narHash: info.narHash.digestHex(),
					derivation: info.deriver ?? ''
				}))
			}),
			...(attempt.activities.some(
				(activity) =>
					(activity.verifiedByCheck === true || !hasExplicitChecks) &&
					finalInfos.some(
						(info) =>
							provenanceRebuilds.has(info.storePath) &&
							info.deriver === activity.derivation
					)
			) && {
				verifiedOutputs: finalInfos
					.filter((info) => provenanceRebuilds.has(info.storePath))
					.map((info) => ({
						storePath: info.storePath,
						narHash: info.narHash.digestHex(),
						derivation: info.deriver ?? ''
					}))
			})
		})),
		finalInfos.map((info) =>
			provenanceRebuilds.has(info.storePath)
				? { ...info, ultimate: true }
				: info
		),
		preExisting,
		autoBuildStore
	);
	return subjects.flatMap((subject) =>
		subject.origin !== 'built' ||
		subject.attempt === undefined ||
		subject.attemptId === undefined
			? []
			: [
					{
						storePath: subject.storePath,
						narHash: subject.narHash,
						derivation: subject.derivation,
						attempt: subject.attempt,
						attemptId: subject.attemptId
					}
				]
	);
}

function originSubjects(
	built: BuildReceiptV2Input['subjects'],
	finalInfos: readonly NixValidPathInfo[],
	attempts: readonly BuildAttempt[],
	storeUri: string
): BuildSubjectV3Input[] {
	const builtByPath = new Map(
		built.map((subject) => [subject.storePath, subject])
	);
	const isRemoteStore = parseSshNgStoreUri(storeUri) !== undefined;

	return finalInfos.map((info): BuildSubjectV3Input => {
		const subject = builtByPath.get(info.storePath);
		const identity = {
			storePath: info.storePath,
			narHash: info.narHash.digestHex(),
			...(info.deriver !== undefined && { derivation: info.deriver })
		};

		if (isRemoteStore && (subject !== undefined || info.ultimate)) {
			return { ...identity, origin: 'store-held', buildStore: storeUri };
		}

		if (subject !== undefined) {
			const activity = attempts
				.find(
					(attempt) =>
						attempt.attempt === subject.attempt &&
						attempt.attemptId === subject.attemptId
				)
				?.activities.find(
					(candidate) => candidate.derivation === subject.derivation
				);
			const machine = activity?.machine;
			const isDelegated = machine !== undefined && machine !== '';
			const isVerifiedByCheck =
				activity?.verifiedByCheck === true && !isDelegated;

			const built: BuildSubjectV3Input = {
				...subject,
				origin: 'built',
				buildStore: autoBuildStore,
				...(isDelegated && { machine }),
				verification: isDelegated ? 'build-store' : 'local'
			};

			return isVerifiedByCheck ? { ...built, reproduced: true } : built;
		}

		if (info.ultimate) {
			return { ...identity, origin: 'store-held', buildStore: autoBuildStore };
		}

		return {
			...identity,
			origin: 'copied',
			signatures: [...info.signatures],
			...(info.ca !== undefined && { ca: info.ca })
		};
	});
}

function plannedOutputs(value: string): {
	readonly paths: string[];
	readonly installables: ReadonlyMap<string, string>;
} {
	const outputPath = z.string().nullable();
	const outputs = z.record(z.string(), outputPath).optional();
	const buildable = z.union([
		z.string(),
		z.object({ drvPath: z.string().optional(), outputs })
	]);
	const parsedJson: unknown = JSON.parse(value);
	const parsed = z.array(buildable).parse(parsedJson);

	const paths = new Set<string>();
	const installables = new Map<string, string>();
	for (const buildable of parsed) {
		if (typeof buildable === 'string' || buildable.outputs === undefined) {
			continue;
		}

		for (const [name, output] of Object.entries(buildable.outputs)) {
			if (typeof output !== 'string') {
				continue;
			}

			paths.add(output);
			if (buildable.drvPath !== undefined) {
				installables.set(output, `${buildable.drvPath}^${name}`);
			}
		}
	}

	return {
		paths: [...paths].toSorted((left, right) => left.localeCompare(right)),
		installables
	};
}

export function plannedOutputPaths(value: string): string[] {
	return plannedOutputs(value).paths;
}

export function registerBuildCommand(
	program: Command,
	environment: Environment = env,
	signal?: AbortSignal
): void {
	program
		.command('build')
		.option(
			'--installables <value>',
			'build this installable (repeatable or newline-delimited)',
			collectLines,
			[]
		)
		.option(
			'--installables-file <path>',
			'read newline-delimited installables from this file'
		)
		.option(
			'--attempts <count>',
			'maximum number of build attempts',
			String(defaultBuildAttempts)
		)
		.option(
			'--keep-going <boolean>',
			'continue building other installables after one fails',
			'false'
		)
		.option('--max-jobs <count>', 'limit local build jobs to this number')
		.option(
			'--allow-failure <boolean>',
			'exit successfully if every build attempt fails',
			'false'
		)
		.option(
			'--publish <scope>',
			'publication scope: none, outputs, built, or closure'
		)
		.option(
			'--build <mode>',
			'build missing outputs or rebuild selected outputs'
		)
		.option(
			'--require-provenance <boolean>',
			'deprecated: use --build rebuild for true or --build missing for false'
		)
		.option(
			'--substituter <mode>',
			'exclude substituted selected outputs from publication or select them for copying',
			'copy'
		)
		.option(
			'--publication-url <url>',
			'destination tenant or cache URL, required when substituter is leave'
		)
		.option(
			'--cupboard-path <path>',
			'cupboard executable with the compiled build hook relay'
		)
		.option(
			'--intermediate-paths-file <path>',
			'write completed intermediate output paths to this file'
		)
		.option('--paths-file <path>', 'write realised output paths to this file')
		.option(
			'--inline-paths <value>',
			'also write inline path outputs: true or false'
		)
		.option(
			'--publish-paths-file <path>',
			'write paths selected for publication'
		)
		.option(
			'--receipt-file <path>',
			'write the current-run build receipt to this file'
		)
		.action((options: BuildOptions) =>
			buildAction(options, environment, {
				...(signal !== undefined && { signal })
			})
		);
}

export async function buildAction(
	options: BuildOptions,
	environment: Environment = env,
	dependencies: BuildDependencies = {}
): Promise<void> {
	dependencies.signal?.throwIfAborted();
	const publish = providedChoice(
		'publish',
		options.publish,
		['none', 'outputs', 'built', 'closure'],
		'outputs'
	);

	const installables = [...(options.installables ?? [])];
	const isInlinePaths = isEnabled('inline-paths', options.inlinePaths, true);
	const publicationUrl = provided(options.publicationUrl);
	const tenantUrl =
		publicationUrl === undefined
			? undefined
			: parseTenantCacheUrl(new URL(publicationUrl)).tenantUrl;
	const installablesFile = provided(options.installablesFile);
	if (installablesFile !== undefined) {
		const contents = await readFile(path.resolve(installablesFile), 'utf8');
		installables.push(...parseLines(contents));
	}

	if (installables.length === 0) {
		throw new BuildInstallablesMissingError();
	}
	if (!installables.every(isNixPositionalArgument)) {
		throw new BuildInstallableInvalidError(installables);
	}

	const statedAttempts = options.attempts ?? String(defaultBuildAttempts);
	const attempts = Number(statedAttempts);
	if (!Number.isSafeInteger(attempts) || attempts < 1) {
		throw new BuildAttemptsInvalidError(statedAttempts);
	}

	const isKeepGoing = isEnabled('keep-going', options.keepGoing, false);
	const isAllowFailure = isEnabled(
		'allow-failure',
		options.allowFailure,
		false
	);
	const requiresProvenance = isEnabled(
		'require-provenance',
		options.requireProvenance,
		false
	);
	if (requiresProvenance && provided(options.build) === 'missing') {
		throw new BuildProvenanceConflictError();
	}
	const build = providedChoice(
		'build',
		options.build,
		['missing', 'rebuild'],
		requiresProvenance ? 'rebuild' : 'missing'
	);
	const storeConfig = discoverNixStoreConfig();
	if (
		build === 'rebuild' &&
		(dependencies.buildSettings ?? storeConfig.building).builders !== undefined
	) {
		throw new BuildRebuildRemoteDispatchError();
	}
	const substituter = providedChoice(
		'substituter',
		options.substituter,
		['leave', 'copy'],
		'copy'
	);
	if (substituter === 'leave' && tenantUrl === undefined) {
		throw new BuildPublicationUrlMissingError();
	}

	const runnerTemporary = requireEnvironment(environment, 'RUNNER_TEMP');
	const outputDirectory =
		environment[jobRootsEnvironmentKey] ?? runnerTemporary;
	const pathsFile = path.resolve(
		provided(options.pathsFile) ??
			path.join(outputDirectory, 'cupboard-build-paths.txt')
	);
	const receiptFile = path.resolve(
		provided(options.receiptFile) ??
			path.join(outputDirectory, 'cupboard-build-receipt.json')
	);
	const publishPathsFile = path.resolve(
		provided(options.publishPathsFile) ??
			path.join(outputDirectory, 'cupboard-publish-paths.txt')
	);
	const intermediatePathsFile = path.resolve(
		provided(options.intermediatePathsFile) ??
			path.join(outputDirectory, 'cupboard-intermediate-paths.txt')
	);
	let attributed: BuildAttempt[] = [];
	let finalPaths: string[] = [];
	let status: number | undefined;
	let failedCommand = 'nix build';
	const checkedPaths = new Set<string>();
	let remoteBuilderDerivations = new Set<string>();

	await mkdir(path.dirname(receiptFile), { recursive: true });
	await rm(`${receiptFile}.references.json`, { force: true });
	const nix = dependencies.nix ?? Nix.open();
	const protection =
		dependencies.protection ??
		(publish === 'built' || environment[jobRootsEnvironmentKey] !== undefined
			? jobOutputProtection(
					environment[jobRootsEnvironmentKey] ??
						(await createJobRoots(environment)),
					storeConfig.storeUri
				)
			: undefined);
	const observation =
		publish === 'built' && protection !== undefined
			? await (dependencies.createObservation ?? observeBuild)({
					environment,
					config: storeConfig,
					nix: Nix.open(),
					invocationId: randomUUID(),
					protection,
					...(provided(options.cupboardPath) !== undefined && {
						cupboardPath: provided(options.cupboardPath)
					})
				})
			: undefined;
	return withCleanups(async () => {
		const completedExecution: {
			readonly attempt: BuildAttempt;
			readonly outputs: readonly NixValidPathInfo[];
		}[] = [];
		const requestedSurvivors = new Set<string>();
		const executeNix = dependencies.runNix ?? runNix;
		const execute = (invocation: NixInvocation): Promise<RunResult> => {
			const observed =
				observation === undefined
					? invocation
					: { ...invocation, environment: observation.environment };
			return dependencies.signal === undefined
				? executeNix(observed)
				: executeNix(observed, dependencies.signal);
		};
		const nextAttemptId = dependencies.nextAttemptId ?? randomUUID;
		const waitBeforeRetry = dependencies.sleep ?? sleep;
		const maxJobs = provided(options.maxJobs);

		const plan = await execute(
			nixBuildInvocation(
				['build', '--dry-run', '--json', '--no-link'],
				installables
			)
		);
		const plannedPaths = new Set<string>();
		let plannedInstallables: ReadonlyMap<string, string> = new Map();
		const queryOutputInfo = async (
			storePath: string
		): Promise<NixValidPathInfo> => {
			const info = await nix.queryPathInfo(storePath);
			if (info.deriver !== undefined) {
				return info;
			}
			const installable = plannedInstallables.get(info.storePath);
			const derivation = installable?.split('^', 1)[0];
			return derivation === undefined ? info : { ...info, deriver: derivation };
		};
		const preExisting = new Set<string>();
		const uncertainInitialPaths = new Set<string>();
		const earlierExecution: {
			readonly attempt: BuildAttempt;
			readonly outputs: readonly NixValidPathInfo[];
		}[] = [];
		if (plan.status === 0) {
			const planned = plannedOutputs(plan.stdout);
			const candidates = planned.paths;
			plannedInstallables = planned.installables;
			for (const candidate of candidates) {
				plannedPaths.add(candidate);
			}
			const states = await Promise.allSettled(
				candidates.map(async (storePath) => {
					await nix.queryPathInfo(storePath);
					return storePath;
				})
			);
			for (const [index, state] of states.entries()) {
				if (state.status === 'fulfilled') {
					preExisting.add(state.value);
				} else if (!(state.reason instanceof NixStorePathNotFoundError)) {
					const candidate = candidates[index];
					if (candidate !== undefined) {
						uncertainInitialPaths.add(candidate);
					}
				}
			}
		}
		await protection?.protect([...preExisting], dependencies.signal);
		for (let attempt = 1; attempt <= attempts; attempt += 1) {
			const attemptId = nextAttemptId();
			const logFile = path.join(
				runnerTemporary,
				`cupboard-nix-${attemptId}.jsonl`
			);
			const arguments_ = [
				'build',
				...(protection === undefined
					? ['--no-link']
					: ['--out-link', path.join(protection.directory, 'targets')]),
				'--print-out-paths',
				'--option',
				'json-log-path',
				logFile,
				...(isKeepGoing ? ['--keep-going'] : []),
				...(maxJobs === undefined ? [] : ['--max-jobs', maxJobs])
			];
			const invocation = nixBuildInvocation(arguments_, installables);

			const firstEvent = observation?.events.length ?? 0;
			const result = await execute(invocation);
			await observation?.flush();
			if (observation !== undefined && result.hookDeliveryFailed === true) {
				throw new BuildObservationIncompleteError();
			}
			status = result.status;
			failedCommand = 'nix build';
			finalPaths = result.stdout.split(/\r?\n/u).filter((line) => line !== '');
			const requestedInfos =
				protection === undefined
					? undefined
					: await queryExistingOutputInfos(
							[...new Set([...plannedPaths, ...finalPaths])],
							queryOutputInfo
						);
			if (requestedInfos !== undefined) {
				await protection?.protect(
					requestedInfos.map((info) => info.storePath),
					dependencies.signal
				);
				for (const info of requestedInfos) {
					requestedSurvivors.add(info.storePath);
				}
			}
			const buildAttempt = {
				attempt,
				attemptId,
				activities: await readBuildActivities(logFile)
			};
			for (const storePath of finalPaths) {
				requestedSurvivors.add(storePath);
			}
			if (observation !== undefined) {
				const completedPaths = [
					...new Set(
						observation.events
							.slice(firstEvent)
							.flatMap((event) => event.outputPaths)
					)
				];
				const outputs = await Promise.all(
					completedPaths.map((storePath) => queryOutputInfo(storePath))
				);
				completedExecution.push({ attempt: buildAttempt, outputs });
			}
			if (status !== 0 && buildAttempt.activities.length > 0) {
				const infos =
					requestedInfos ??
					(await queryExistingOutputInfos(
						[...new Set([...plannedPaths, ...finalPaths])],
						queryOutputInfo
					));
				earlierExecution.push({
					attempt: buildAttempt,
					outputs: infos.filter((info) =>
						buildAttempt.activities.some(
							(activity) => activity.derivation === info.deriver
						)
					)
				});
			}
			if (status === 0) {
				const attemptInfos = await Promise.all(
					finalPaths.map((storePath) => queryOutputInfo(storePath))
				);
				if (
					build === 'rebuild' &&
					buildAttempt.activities.some(
						(activity) =>
							activity.machine !== '' &&
							attemptInfos.some((info) => info.deriver === activity.derivation)
					)
				) {
					throw new BuildRebuildRemoteDispatchError();
				}
				const verificationDerivations =
					build === 'rebuild'
						? [
								...new Set([
									...derivationsRequiringVerification(
										attemptInfos,
										preExisting,
										plannedPaths,
										uncertainInitialPaths
									),
									...attemptInfos.flatMap((info) =>
										info.deriver !== undefined &&
										buildAttempt.activities.every(
											(activity) => activity.derivation !== info.deriver
										)
											? [info.deriver]
											: []
									)
								])
							].toSorted((left, right) => left.localeCompare(right))
						: [];
				const hasUnresolvedDeriver =
					attemptInfos.some((info) => info.deriver === undefined) &&
					build === 'rebuild';
				if (hasUnresolvedDeriver || verificationDerivations.length > 0) {
					const selectedPaths = hasUnresolvedDeriver
						? attemptInfos.map((info) => info.storePath)
						: attemptInfos
								.filter(
									(info) =>
										info.deriver !== undefined &&
										verificationDerivations.includes(info.deriver)
								)
								.map((info) => info.storePath);
					const selectedInstallables = selectedPaths.map((storePath) =>
						plannedInstallables.get(storePath)
					);
					const verificationAttemptId = nextAttemptId();
					const verificationLogFile = path.join(
						runnerTemporary,
						`cupboard-nix-${verificationAttemptId}-${String(attempt)}-rebuild.jsonl`
					);
					const verificationFirstEvent = observation?.events.length ?? 0;
					const verification = await execute(
						nixBuildInvocation(
							[
								'build',
								'--rebuild',
								'--option',
								'builders',
								'',
								'--no-link',
								'--option',
								'json-log-path',
								verificationLogFile,
								...(isKeepGoing ? ['--keep-going'] : []),
								...(maxJobs === undefined ? [] : ['--max-jobs', maxJobs])
							],
							hasUnresolvedDeriver || selectedInstallables.includes(undefined)
								? installables
								: selectedInstallables.filter(
										(installable) => installable !== undefined
									)
						)
					);
					await observation?.flush();
					if (
						observation !== undefined &&
						verification.hookDeliveryFailed === true
					) {
						throw new BuildObservationIncompleteError();
					}
					const checkActivities =
						await readBuildActivities(verificationLogFile);
					if (observation !== undefined) {
						const intermediateCompletionPaths = [
							...new Set(
								observation.events
									.slice(verificationFirstEvent)
									.flatMap((event) => event.outputPaths)
							)
						].filter((storePath) => !finalPaths.includes(storePath));
						const outputs = await Promise.all(
							intermediateCompletionPaths.map((storePath) =>
								queryOutputInfo(storePath)
							)
						);
						completedExecution.push({
							attempt: {
								attempt,
								attemptId: verificationAttemptId,
								activities: checkActivities
							},
							outputs
						});
					}
					status = verification.status;
					failedCommand = 'nix build --rebuild';
					if (status === 0) {
						const selectedDerivations = new Set(
							attemptInfos.flatMap((info) =>
								info.deriver === undefined ? [] : [info.deriver]
							)
						);
						const selectedActivities = checkActivities.filter((activity) =>
							selectedDerivations.has(activity.derivation)
						);
						if (
							selectedActivities.some((activity) => activity.machine !== '')
						) {
							throw new BuildRebuildRemoteDispatchError();
						}
						const verificationActivities = selectedActivities
							.filter((activity) => activity.machine === '')
							.map((activity) => ({ ...activity, verifiedByCheck: true }));
						remoteBuilderDerivations = new Set(
							[...buildAttempt.activities, ...selectedActivities]
								.filter((activity) => activity.machine !== '')
								.map((activity) => activity.derivation)
						);
						for (const info of attemptInfos) {
							if (
								info.deriver !== undefined &&
								selectedPaths.includes(info.storePath) &&
								verificationActivities.some(
									(activity) => activity.derivation === info.deriver
								)
							) {
								checkedPaths.add(info.storePath);
							}
						}
						attributed = [
							{
								attempt,
								attemptId: verificationAttemptId,
								activities: verificationActivities
							},
							buildAttempt
						];
					}
				} else {
					attributed = [buildAttempt];
					remoteBuilderDerivations = new Set(
						buildAttempt.activities
							.filter((activity) => activity.machine !== '')
							.map((activity) => activity.derivation)
					);
				}
				if (status === 0 && build === 'rebuild') {
					const observed = new Set([
						...remoteBuilderDerivations,
						...attributed.flatMap((current) =>
							current.activities.map((activity) => activity.derivation)
						)
					]);
					const unobservedPaths = attemptInfos
						.filter(
							(info) =>
								info.deriver === undefined || !observed.has(info.deriver)
						)
						.map((info) => info.storePath);
					if (unobservedPaths.length > 0) {
						throw new BuildObservationMissingError(unobservedPaths);
					}
				}
			}
			if (status === 0) {
				break;
			}
			if (attempt < attempts) {
				await waitBeforeRetry(attempt * 15_000, dependencies.signal);
			}
		}

		if (status !== 0 && !isAllowFailure) {
			throw new CommandFailedError(failedCommand, status ?? -1);
		}

		await observation?.flush();
		if (observation !== undefined) {
			const survivors = await queryExistingOutputInfos(
				[...requestedSurvivors.union(plannedPaths)],
				queryOutputInfo
			);
			finalPaths = survivors
				.map((info) => info.storePath)
				.toSorted((left, right) => left.localeCompare(right));
		}
		const observedPaths =
			observation?.events.flatMap((event) => event.outputPaths) ?? [];
		let intermediatePaths = [
			...new Set(
				observedPaths.filter((storePath) => !finalPaths.includes(storePath))
			)
		].toSorted((left, right) => left.localeCompare(right));
		const allPaths = [...finalPaths, ...intermediatePaths];
		const finalInfos = await Promise.all(
			allPaths.map((storePath) => queryOutputInfo(storePath))
		);
		await protection?.protect(allPaths, dependencies.signal);
		attributed = [
			...[...earlierExecution, ...completedExecution].map((execution) => ({
				...execution.attempt,
				validatedOutputs: execution.outputs
			})),
			...attributed
		];
		const subjects = receiptSubjects(
			attributed,
			finalInfos,
			preExisting,
			checkedPaths
		);
		let receipt = buildReceiptV3Schema.parse({
			version: 3,
			paths: allPaths,
			subjects: originSubjects(
				subjects,
				finalInfos,
				attributed,
				storeConfig.storeUri
			)
		});
		const selection = await selectPublicationPaths(
			receipt.subjects
				.filter((subject) => finalPaths.includes(subject.storePath))
				.map((subject) => ({
					...subject,
					origin:
						earlierExecution.some((execution) =>
							execution.outputs.some(
								(output) =>
									output.storePath === subject.storePath &&
									output.narHash.digestHex() === subject.narHash &&
									output.deriver === subject.derivation &&
									execution.attempt.activities.some(
										(activity) => activity.derivation === output.deriver
									)
							)
						) ||
						(subject.derivation !== undefined &&
							remoteBuilderDerivations.has(subject.derivation)) ||
						subject.origin === 'built'
							? 'built'
							: subject.origin === 'copied'
								? 'copied'
								: 'store-held'
				})),
			{
				substituter: build === 'rebuild' ? 'copy' : substituter,
				...(tenantUrl !== undefined && { tenantUrl }),
				...(dependencies.availabilitySettings !== undefined && {
					settings: dependencies.availabilitySettings
				}),
				...(dependencies.availabilityNix !== undefined && {
					store: dependencies.availabilityNix
				}),
				...(dependencies.signal !== undefined && {
					signal: dependencies.signal
				})
			}
		);
		if (
			publish === 'built' &&
			tenantUrl !== undefined &&
			publicationUrl !== undefined
		) {
			const roots = [
				...new Set(
					finalInfos
						.filter((info) =>
							selection.published.includes(
								storePathSchema.parse(info.storePath)
							)
						)
						.flatMap((info) => {
							const derivation = derivationPathOf(
								plannedInstallables.get(info.storePath) ?? ''
							);
							return derivation === undefined
								? []
								: [storePathSchema.parse(derivation)];
						})
				)
			];
			const graphNix = dependencies.graphNix ?? Nix.open();
			const outputs = await dependencyOutputs(roots, {
				readDerivation: (path) => graphNix.readDerivation(path),
				...(dependencies.signal !== undefined && {
					signal: dependencies.signal
				})
			});
			const references = await (
				dependencies.tenantDependencyReferences ?? tenantDependencyReferences
			)(
				outputs
					.map((output) => output.storePath)
					.filter((path) => !allPaths.includes(path)),
				{
					sources: tenantReferenceSources(tenantUrl, [
						{ url: new URL(publicationUrl), paths: [] }
					]),
					...(dependencies.signal !== undefined && {
						signal: dependencies.signal
					})
				}
			);
			if (references.length > 0) {
				await writeFile(
					`${receiptFile}.references.json`,
					JSON.stringify({ version: 1, paths: references })
				);
			}
			intermediatePaths = [
				...intermediatePaths,
				...references.map((reference) => reference.storePath)
			];
			receipt = buildReceiptV3Schema.parse({
				...receipt,
				paths: [
					...receipt.paths,
					...references.map((reference) => reference.storePath)
				],
				subjects: [
					...receipt.subjects,
					...references.map((reference) => {
						const narinfo = NarInfo.parse(reference.narinfo);
						return {
							origin: 'republished',
							storePath: narinfo.storePath.value,
							narHash: narinfo.narHash.digestHex(),
							...(narinfo.deriver !== undefined && {
								derivation: `${narinfo.storePath.storeDirectory}/${narinfo.deriver}`
							}),
							signatures: [...narinfo.sigs],
							...(narinfo.ca !== undefined && { ca: narinfo.ca }),
							metadataSource: reference.source
						};
					})
				]
			});
		}

		const publishPaths = selection.published;
		const builtSubjects = receipt.subjects.filter(
			(subject) =>
				subject.origin === 'built' && finalPaths.includes(subject.storePath)
		);
		const builtPaths = builtSubjects
			.map((subject) => subject.storePath)
			.toSorted((left, right) => left.localeCompare(right));
		const builtReceipt = buildReceiptV3Schema.parse({
			version: 3,
			paths: builtPaths,
			subjects: builtSubjects
		});
		const builtReceiptFile = path.join(
			path.dirname(receiptFile),
			'cupboard-built-receipt.json'
		);
		await mkdir(path.dirname(pathsFile), { recursive: true });
		await mkdir(path.dirname(publishPathsFile), { recursive: true });
		await writeFile(
			pathsFile,
			finalPaths.join('\n').concat(finalPaths.length === 0 ? '' : '\n')
		);
		await writeFile(
			publishPathsFile,
			publishPaths.join('\n').concat(publishPaths.length === 0 ? '' : '\n')
		);
		await mkdir(path.dirname(intermediatePathsFile), { recursive: true });
		await writeFile(
			intermediatePathsFile,
			intermediatePaths
				.join('\n')
				.concat(intermediatePaths.length === 0 ? '' : '\n')
		);
		await setOutput(
			environment,
			'intermediate-paths-file',
			intermediatePathsFile
		);
		await setOutput(
			environment,
			'intermediate-paths-count',
			String(intermediatePaths.length)
		);
		await writeFile(receiptFile, `${JSON.stringify(receipt)}\n`);
		await writeFile(builtReceiptFile, `${JSON.stringify(builtReceipt)}\n`);
		await setOutput(environment, 'paths-file', pathsFile);
		await setOutput(environment, 'publish-paths-file', publishPathsFile);
		await setOutput(environment, 'receipt-file', receiptFile);
		await setOutput(environment, 'built-receipt-file', builtReceiptFile);
		for (const [output, paths] of [
			['paths', finalPaths],
			['publish-paths', publishPaths],
			['built-paths', builtPaths]
		] as const) {
			await setOutput(environment, `${output}-count`, String(paths.length));
			if (!isInlinePaths) {
				continue;
			}
			const contents = paths.join('\n');
			const delimiter = `CUPBOARD_PATHS_${randomUUID().replaceAll('-', '_')}`;
			await appendEnvironmentFile(
				environment.GITHUB_OUTPUT,
				`${output}<<${delimiter}\n${contents}\n${delimiter}\n`
			);
		}
	}, [() => observation?.close() ?? Promise.resolve()]);
}
