import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import {
	discoverNixStoreConfig,
	Nix,
	type NixBuildSettings,
	type NixStoreConfig,
	NixStorePathNotFoundError,
	type NixValidPathInfo,
	parseSshNgStoreUri,
	selectPublicationPaths
} from '@cupboard/nix';
import { parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
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
import type { Command } from 'commander';
import { z } from 'zod';

import {
	BuildAttemptsInvalidError,
	BuildInstallableInvalidError,
	BuildInstallablesMissingError,
	BuildObservationMissingError,
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
}

export interface BuildOptions {
	readonly inlinePaths?: string;
	readonly publicationUrl?: string;
	readonly installables?: readonly string[];
	readonly installablesFile?: string;
	readonly attempts?: string;
	readonly keepGoing?: string;
	readonly maxJobs?: string;
	readonly allowFailure?: string;
	readonly build?: string;
	readonly substituter?: string;
	readonly pathsFile?: string;
	readonly publishPathsFile?: string;
	readonly receiptFile?: string;
}

export interface RunResult {
	readonly status: number | undefined;
	readonly stdout: string;
}

export interface NixInvocation {
	readonly arguments: readonly string[];
	readonly stdin: string;
}

export interface BuildDependencies {
	readonly buildSettings?: NixBuildSettings;
	readonly runNix?: (
		invocation: NixInvocation,
		signal?: AbortSignal
	) => Promise<RunResult>;
	readonly nix?: Pick<Nix, 'queryPathInfo'>;
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

async function runNix(
	invocation: NixInvocation,
	signal?: AbortSignal
): Promise<RunResult> {
	signal?.throwIfAborted();

	const child = spawn('nix', [...invocation.arguments], {
		stdio: ['pipe', 'pipe', 'inherit']
	});
	const observed = observeChildProcess(child);
	let stdout = '';

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

	return { status: result.status ?? undefined, stdout };
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
	const firstBuild = new Map<string, Omit<BuildAttempt, 'activities'>>();

	for (const attempt of attempts) {
		for (const activity of attempt.activities) {
			if (activity.machine !== '') {
				continue;
			}

			if (!firstBuild.has(activity.derivation)) {
				firstBuild.set(activity.derivation, attempt);
			}
		}
	}

	return finalInfos
		.flatMap((info) => {
			if (
				info.deriver === undefined ||
				(!info.ultimate && !provenanceRebuilds.has(info.storePath)) ||
				(preExisting.has(info.storePath) &&
					!provenanceRebuilds.has(info.storePath))
			) {
				return [];
			}

			const built = firstBuild.get(info.deriver);
			if (built === undefined) {
				return [];
			}

			return [
				{
					storePath: info.storePath,
					narHash: info.narHash.digestHex(),
					derivation: info.deriver,
					attempt: built.attempt,
					attemptId: built.attemptId
				}
			];
		})
		.toSorted((left, right) => left.storePath.localeCompare(right.storePath));
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
			'--build <mode>',
			'build missing outputs or rebuild selected outputs',
			'missing'
		)
		.option(
			'--substituter <mode>',
			'exclude substituted selected outputs from publication or select them for copying',
			'copy'
		)
		.option(
			'--publication-url <url>',
			'destination tenant or cache URL for publication selection'
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
	const build = providedChoice(
		'build',
		options.build,
		['missing', 'rebuild'],
		'missing'
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

	const runnerTemporary = requireEnvironment(environment, 'RUNNER_TEMP');
	const pathsFile = path.resolve(
		provided(options.pathsFile) ??
			path.join(runnerTemporary, 'cupboard-build-paths.txt')
	);
	const receiptFile = path.resolve(
		provided(options.receiptFile) ??
			path.join(runnerTemporary, 'cupboard-build-receipt.json')
	);
	const publishPathsFile = path.resolve(
		provided(options.publishPathsFile) ??
			path.join(runnerTemporary, 'cupboard-publish-paths.txt')
	);
	let attributed: BuildAttempt[] = [];
	let finalPaths: string[] = [];
	let status: number | undefined;
	let failedCommand = 'nix build';
	let unobservedPaths: string[] = [];
	const checkedPaths = new Set<string>();
	let remoteBuilderDerivations = new Set<string>();

	await mkdir(path.dirname(receiptFile), { recursive: true });
	const nix = dependencies.nix ?? Nix.open();
	const executeNix = dependencies.runNix ?? runNix;
	const execute = (invocation: NixInvocation): Promise<RunResult> =>
		dependencies.signal === undefined
			? executeNix(invocation)
			: executeNix(invocation, dependencies.signal);
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
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const attemptId = nextAttemptId();
		const logFile = path.join(
			runnerTemporary,
			`cupboard-nix-${attemptId}.jsonl`
		);
		const arguments_ = [
			'build',
			'--no-link',
			'--print-out-paths',
			'--option',
			'json-log-path',
			logFile,
			...(isKeepGoing ? ['--keep-going'] : []),
			...(maxJobs === undefined ? [] : ['--max-jobs', maxJobs])
		];
		const invocation = nixBuildInvocation(arguments_, installables);

		const result = await execute(invocation);
		status = result.status;
		failedCommand = 'nix build';
		finalPaths = result.stdout.split(/\r?\n/u).filter((line) => line !== '');
		const buildAttempt = {
			attempt,
			attemptId,
			activities: await readBuildActivities(logFile)
		};
		if (status !== 0 && buildAttempt.activities.length > 0) {
			const states = await Promise.allSettled(
				[...new Set([...plannedPaths, ...finalPaths])].map((storePath) =>
					nix.queryPathInfo(storePath)
				)
			);
			earlierExecution.push({
				attempt: buildAttempt,
				outputs: states.flatMap((state) =>
					state.status === 'fulfilled' &&
					buildAttempt.activities.some(
						(activity) => activity.derivation === state.value.deriver
					)
						? [state.value]
						: []
				)
			});
		}
		if (status === 0) {
			const attemptInfos = await Promise.all(
				finalPaths.map((storePath) => nix.queryPathInfo(storePath))
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
				status = verification.status;
				failedCommand = 'nix build --rebuild';
				if (status === 0) {
					const selectedDerivations = new Set(
						attemptInfos.flatMap((info) =>
							info.deriver === undefined ? [] : [info.deriver]
						)
					);
					const checkActivities =
						await readBuildActivities(verificationLogFile);
					const selectedActivities = checkActivities.filter((activity) =>
						selectedDerivations.has(activity.derivation)
					);
					if (selectedActivities.some((activity) => activity.machine !== '')) {
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
				unobservedPaths = attemptInfos
					.filter(
						(info) => info.deriver === undefined || !observed.has(info.deriver)
					)
					.map((info) => info.storePath);
				if (unobservedPaths.length > 0) {
					status = -1;
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
		if (status === -1 && unobservedPaths.length > 0) {
			throw new BuildObservationMissingError(unobservedPaths);
		}
		throw new CommandFailedError(failedCommand, status ?? -1);
	}

	const finalInfos = await Promise.all(
		finalPaths.map((storePath) => nix.queryPathInfo(storePath))
	);
	const subjects = receiptSubjects(
		attributed,
		finalInfos,
		preExisting,
		checkedPaths
	);
	const receipt = buildReceiptV3Schema.parse({
		version: 3,
		paths: finalPaths,
		subjects: originSubjects(
			subjects,
			finalInfos,
			attributed,
			storeConfig.storeUri
		)
	});
	const selection = await selectPublicationPaths(
		receipt.subjects.map((subject) => ({
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
			...(dependencies.signal !== undefined && { signal: dependencies.signal })
		}
	);
	const publishPaths = selection.published;
	const builtSubjects = receipt.subjects.filter(
		(subject) => subject.origin === 'built'
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
}
