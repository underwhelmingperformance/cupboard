import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { Nix, type NixValidPathInfo } from '@cupboard/nix';
import type { BuildReceiptV2 } from '@cupboard/protocol/build';
import type { Command } from 'commander';
import { z } from 'zod';

import {
	observeChildProcess,
	waitForAbortableChildProcess
} from '../child-process.ts';
import {
	BuildAttemptsInvalidError,
	BuildInstallableInvalidError,
	BuildInstallablesMissingError,
	CommandFailedError,
	ProvenanceSubjectsIncompleteError
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
	provided
} from '../options.ts';

export interface BuildActivity {
	readonly derivation: string;
	readonly machine: string;
}

export interface BuildAttempt {
	readonly attempt: number;
	readonly attemptId: string;
	readonly activities: readonly BuildActivity[];
}

export interface BuildOptions {
	readonly installables?: readonly string[];
	readonly installablesFile?: string;
	readonly attempts?: string;
	readonly keepGoing?: string;
	readonly maxJobs?: string;
	readonly allowFailure?: string;
	readonly requireProvenance?: string;
	readonly pathsFile?: string;
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
	readonly runNix?: (
		invocation: NixInvocation,
		signal?: AbortSignal
	) => Promise<RunResult>;
	readonly nix?: Pick<Nix, 'queryPathInfo'>;
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
		activities.set(derivation, { derivation, machine });
	}

	return activities
		.values()
		.toArray()
		.toSorted((left, right) => left.derivation.localeCompare(right.derivation));
}

export function derivationsRequiringVerification(
	attempts: readonly BuildAttempt[],
	successfulAttempt: number,
	finalInfos: readonly NixValidPathInfo[]
): string[] {
	const finalDerivations = new Set(
		finalInfos.flatMap((info) =>
			info.deriver === undefined ? [] : [info.deriver]
		)
	);

	const derivations = new Set<string>();

	for (const attempt of attempts) {
		for (const activity of attempt.activities) {
			if (
				finalDerivations.has(activity.derivation) &&
				(attempt.attempt !== successfulAttempt || activity.machine !== '')
			) {
				derivations.add(activity.derivation);
			}
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
): BuildReceiptV2['subjects'] {
	const firstBuild = new Map<string, Omit<BuildAttempt, 'activities'>>();

	for (const attempt of attempts) {
		for (const activity of attempt.activities) {
			if (!firstBuild.has(activity.derivation)) {
				firstBuild.set(activity.derivation, attempt);
			}
		}
	}

	return finalInfos
		.flatMap((info) => {
			if (
				info.deriver === undefined ||
				(preExisting.has(info.storePath) &&
					!provenanceRebuilds.has(info.deriver))
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

export function plannedOutputPaths(value: string): string[] {
	const outputPath = z.string().nullable();
	const outputs = z.record(z.string(), outputPath).optional();
	const buildable = z.union([z.string(), z.object({ outputs })]);
	const parsedJson: unknown = JSON.parse(value);
	const parsed = z.array(buildable).parse(parsedJson);

	const paths = new Set<string>();
	for (const buildable of parsed) {
		if (typeof buildable === 'string' || buildable.outputs === undefined) {
			continue;
		}

		for (const output of Object.values(buildable.outputs)) {
			if (typeof output === 'string') {
				paths.add(output);
			}
		}
	}

	return [...paths].toSorted((left, right) => left.localeCompare(right));
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
			'--require-provenance <boolean>',
			'locally rebuild outputs without evidence from this run',
			'false'
		)
		.option('--paths-file <path>', 'write realised output paths to this file')
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
	const runnerTemporary = requireEnvironment(environment, 'RUNNER_TEMP');
	const pathsFile = path.resolve(
		provided(options.pathsFile) ??
			path.join(runnerTemporary, 'cupboard-build-paths.txt')
	);
	const receiptFile = path.resolve(
		provided(options.receiptFile) ??
			path.join(runnerTemporary, 'cupboard-build-receipt.json')
	);
	const observed: BuildAttempt[] = [];
	let attributed: BuildAttempt[] = [];
	let finalPaths: string[] = [];
	let status: number | undefined;

	await mkdir(path.dirname(receiptFile), { recursive: true });
	const nix = dependencies.nix ?? Nix.open();
	const executeNix = dependencies.runNix ?? runNix;
	const execute = (invocation: NixInvocation): Promise<RunResult> =>
		dependencies.signal === undefined
			? executeNix(invocation)
			: executeNix(invocation, dependencies.signal);
	const nextAttemptId = dependencies.nextAttemptId ?? randomUUID;
	const waitBeforeRetry = dependencies.sleep ?? sleep;
	const plan = await execute(
		nixBuildInvocation(
			['build', '--dry-run', '--json', '--no-link'],
			installables
		)
	);
	const preExisting = new Set<string>();
	if (plan.status === 0) {
		const candidates = plannedOutputPaths(plan.stdout);
		const states = await Promise.allSettled(
			candidates.map(async (storePath) => {
				await nix.queryPathInfo(storePath);
				return storePath;
			})
		);
		for (const state of states) {
			if (state.status === 'fulfilled') {
				preExisting.add(state.value);
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
			logFile
		];
		if (isKeepGoing) {
			arguments_.push('--keep-going');
		}
		const maxJobs = provided(options.maxJobs);
		if (maxJobs !== undefined) {
			arguments_.push('--max-jobs', maxJobs);
		}
		const invocation = nixBuildInvocation(arguments_, installables);

		const result = await execute(invocation);
		status = result.status;
		finalPaths = result.stdout.split(/\r?\n/u).filter((line) => line !== '');
		let log = '';
		try {
			log = await readFile(logFile, 'utf8');
		} catch {
			// Nix can fail before it creates the event log. Record the attempt with
			// no activities so its failure still triggers the configured retry.
		}
		const buildAttempt = {
			attempt,
			attemptId,
			activities: buildActivities(log)
		};
		observed.push(buildAttempt);
		if (status === 0 && plan.status === 0) {
			const attemptInfos = await Promise.all(
				finalPaths.map((storePath) => nix.queryPathInfo(storePath))
			);
			const verificationDerivations = derivationsRequiringVerification(
				observed,
				attempt,
				attemptInfos
			);
			if (verificationDerivations.length > 0) {
				const verification = await execute(
					nixBuildInvocation(
						[
							'build',
							'--rebuild',
							'--no-link',
							'--builders',
							'',
							'--max-jobs',
							'1'
						],
						verificationDerivations.map((derivation) => `${derivation}^*`)
					)
				);
				if (verification.status !== 0) {
					throw new CommandFailedError(
						'nix build --rebuild',
						verification.status ?? -1
					);
				}
			}
			const activities = new Map(
				buildAttempt.activities.map((activity) => [
					activity.derivation,
					activity
				])
			);
			for (const derivation of verificationDerivations) {
				activities.set(derivation, { derivation, machine: '' });
			}
			attributed = [
				{
					...buildAttempt,
					activities: activities.values().toArray()
				}
			];
		}
		if (status === 0) {
			break;
		}
		if (attempt < attempts) {
			await waitBeforeRetry(attempt * 15_000, dependencies.signal);
		}
	}

	if (status !== 0 && !isAllowFailure) {
		throw new CommandFailedError('nix build', status ?? -1);
	}

	let finalInfos = await Promise.all(
		finalPaths.map((storePath) => nix.queryPathInfo(storePath))
	);
	const provenanceRebuilds = new Set<string>();
	let subjects = receiptSubjects(attributed, finalInfos, preExisting);

	if (requiresProvenance && subjects.length !== finalInfos.length) {
		const attributedPaths = new Set(
			subjects.map((subject) => subject.storePath)
		);
		const missing = finalInfos.filter(
			(info) => !attributedPaths.has(info.storePath)
		);
		const unavailable = missing
			.filter((info) => info.deriver === undefined)
			.map((info) => info.storePath);

		if (unavailable.length > 0) {
			throw new ProvenanceSubjectsIncompleteError(unavailable);
		}

		const derivations = new Set(
			missing.flatMap((info) =>
				info.deriver === undefined ? [] : [info.deriver]
			)
		);
		const rebuild = await execute(
			nixBuildInvocation(
				[
					'build',
					'--rebuild',
					'--no-link',
					'--builders',
					'',
					'--max-jobs',
					'1'
				],
				derivations
					.values()
					.map((derivation) => `${derivation}^*`)
					.toArray()
			)
		);

		if (rebuild.status !== 0) {
			throw new CommandFailedError(
				'nix build --rebuild for provenance',
				rebuild.status ?? -1
			);
		}

		const rebuildAttempt: BuildAttempt = {
			attempt: observed.length + 1,
			attemptId: nextAttemptId(),
			activities: derivations
				.values()
				.map((derivation) => ({ derivation, machine: '' }))
				.toArray()
		};
		for (const derivation of derivations) {
			provenanceRebuilds.add(derivation);
		}
		attributed = [...attributed, rebuildAttempt];
		finalInfos = await Promise.all(
			finalPaths.map((storePath) => nix.queryPathInfo(storePath))
		);
		subjects = receiptSubjects(
			attributed,
			finalInfos,
			preExisting,
			provenanceRebuilds
		);

		if (subjects.length !== finalInfos.length) {
			const completed = new Set(subjects.map((subject) => subject.storePath));
			throw new ProvenanceSubjectsIncompleteError(
				finalInfos
					.filter((info) => !completed.has(info.storePath))
					.map((info) => info.storePath)
			);
		}
	}
	const receipt: BuildReceiptV2 = { version: 2, paths: finalPaths, subjects };
	await mkdir(path.dirname(pathsFile), { recursive: true });
	await writeFile(
		pathsFile,
		finalPaths.join('\n').concat(finalPaths.length === 0 ? '' : '\n')
	);
	await writeFile(receiptFile, `${JSON.stringify(receipt)}\n`);
	await setOutput(environment, 'paths-file', pathsFile);
	await setOutput(environment, 'receipt-file', receiptFile);
	const delimiter = `CUPBOARD_PATHS_${randomUUID().replaceAll('-', '_')}`;
	await appendEnvironmentFile(
		environment.GITHUB_OUTPUT,
		`paths<<${delimiter}\n${finalPaths.join('\n')}\n${delimiter}\n`
	);
}
