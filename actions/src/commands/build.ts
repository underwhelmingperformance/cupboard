import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { Nix, type NixValidPathInfo } from '@cupboard/nix';
import type { Command } from 'commander';
import { z } from 'zod';

import type { BuildReceipt } from '../build-receipt.ts';
import { CommandFailedError, InvalidInputError } from '../errors.ts';
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
import {
	derivationGraphFromJson,
	type DerivationNode
} from '../publish-plan.ts';

const plannedOutputPathSchema = z.string().nullable();
const plannedOutputsSchema = z.record(z.string(), plannedOutputPathSchema);
const plannedBuildSchema = z.union([
	z.string(),
	z.object({
		outputs: plannedOutputsSchema.optional()
	})
]);

export interface BuildActivity {
	readonly derivation: string;
	readonly machine: string;
}

export interface BuildAttempt {
	readonly attempt: number;
	readonly attemptId: string;
	readonly activities: readonly BuildActivity[];
}

export interface AttributedOutput {
	readonly storePath: string;
	readonly derivation: string;
	readonly attempt: number;
	readonly attemptId: string;
	readonly machine: string;
}

interface BuildSnapshot {
	readonly derivations: ReadonlySet<string>;
	readonly validPaths: ReadonlySet<string>;
	readonly complete: boolean;
}

export interface BuildOptions {
	readonly installables?: readonly string[];
	readonly installablesFile?: string;
	readonly attempts?: string;
	readonly keepGoing?: string;
	readonly maxJobs?: string;
	readonly allowFailure?: string;
	readonly derivationGraphFile?: string;
	readonly pathsFile?: string;
	readonly publicationPathsFile?: string;
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
	readonly runNix?: (invocation: NixInvocation) => Promise<RunResult>;
	readonly nix?: Pick<
		Nix,
		| 'queryDerivationOutputPaths'
		| 'queryPathsInfo'
		| 'queryValidPaths'
		| 'queryValidPathsInfo'
	>;
	readonly nextAttemptId?: () => string;
	readonly sleep?: (delayMs: number) => Promise<void>;
}

function runNix(invocation: NixInvocation): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn('nix', [...invocation.arguments], {
			stdio: ['pipe', 'pipe', 'inherit']
		});
		let stdout = '';

		child.stdin.once('error', reject);
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.once('error', reject);
		child.once('close', (status) => {
			resolve({ status: status ?? undefined, stdout });
		});
		child.stdin.end(invocation.stdin);
	});
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

export function receiptSubjects(
	outputs: readonly AttributedOutput[],
	finalInfos: readonly NixValidPathInfo[],
	preExisting: ReadonlySet<string>
): BuildReceipt['subjects'] {
	const attributedByPath = new Map(
		outputs.map((output) => [output.storePath, output])
	);

	return finalInfos
		.flatMap((info) => {
			if (info.deriver === undefined || preExisting.has(info.storePath)) {
				return [];
			}

			const built = attributedByPath.get(info.storePath);
			if (built?.derivation !== info.deriver) {
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
	const parsed = plannedBuilds(value);
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

function plannedBuilds(value: string) {
	const parsedJson: unknown = JSON.parse(value);
	return z.array(plannedBuildSchema).parse(parsedJson);
}

export function publicationPaths(options: {
	readonly targetPaths: readonly string[];
	readonly builtOutputPaths: readonly string[];
}): string[] {
	return [...new Set([...options.targetPaths, ...options.builtOutputPaths])];
}

export function retentionRootPaths(
	infos: readonly NixValidPathInfo[]
): string[] {
	const selected = new Set(infos.map((info) => info.storePath));
	const referenced = new Set(
		infos.flatMap((info) =>
			info.references.filter(
				(reference) => reference !== info.storePath && selected.has(reference)
			)
		)
	);

	return infos
		.map((info) => info.storePath)
		.filter((storePath) => !referenced.has(storePath))
		.toSorted((left, right) => left.localeCompare(right));
}

async function builtOutputInfos(
	nix: NonNullable<BuildDependencies['nix']>,
	outputs: readonly AttributedOutput[]
): Promise<readonly NixValidPathInfo[]> {
	if (outputs.length === 0) {
		return [];
	}

	const paths = await nix.queryValidPaths(
		outputs.map((output) => output.storePath)
	);

	return nix.queryPathsInfo(
		paths.toSorted((left, right) => left.localeCompare(right))
	);
}

async function evaluateDerivationGraph(
	executeNix: NonNullable<BuildDependencies['runNix']>,
	installables: readonly string[],
	isAllowFailure: boolean
): Promise<{
	readonly graph: ReadonlyMap<string, DerivationNode>;
	readonly isComplete: boolean;
}> {
	const combined = await executeNix(
		nixBuildInvocation(['derivation', 'show', '-r'], installables)
	);

	if (combined.status === 0) {
		const value: unknown = JSON.parse(combined.stdout);

		return { graph: derivationGraphFromJson(value), isComplete: true };
	}

	if (!isAllowFailure) {
		throw new CommandFailedError('nix derivation show', combined.status ?? -1);
	}

	const graph = new Map<string, DerivationNode>();
	const installablesToEvaluate = installables.length > 1 ? installables : [];
	let isComplete = installables.length > 1;

	for (const installable of installablesToEvaluate) {
		const result = await executeNix(
			nixBuildInvocation(['derivation', 'show', '-r'], [installable])
		);

		if (result.status !== 0) {
			isComplete = false;
			continue;
		}

		const value: unknown = JSON.parse(result.stdout);

		for (const [drvPath, node] of derivationGraphFromJson(value)) {
			graph.set(drvPath, node);
		}
	}

	return { graph, isComplete };
}

async function buildSnapshot(
	nix: NonNullable<BuildDependencies['nix']>,
	nodes: ReadonlyMap<string, DerivationNode>,
	isComplete = true
): Promise<BuildSnapshot> {
	const staticPaths = nodes
		.values()
		.flatMap((node) =>
			node.outputs.flatMap((output) =>
				output.path === undefined ? [] : [output.path]
			)
		)
		.toArray();
	const pathlessDerivations = nodes
		.values()
		.filter((node) => node.outputs.some((output) => output.path === undefined))
		.map((node) => node.drvPath)
		.toArray()
		.toSorted((left, right) => left.localeCompare(right));
	const realisedPathlessOutputs =
		pathlessDerivations.length === 0
			? []
			: await nix.queryDerivationOutputPaths(pathlessDerivations);
	const candidates = [
		...new Set([...staticPaths, ...realisedPathlessOutputs])
	].toSorted((left, right) => left.localeCompare(right));
	const validPaths =
		candidates.length === 0 ? [] : await nix.queryValidPaths(candidates);

	return {
		derivations: new Set(nodes.keys()),
		validPaths: new Set(validPaths),
		complete: isComplete
	};
}

async function attributedAttemptOutputs(
	nix: NonNullable<BuildDependencies['nix']>,
	snapshot: BuildSnapshot,
	attempt: BuildAttempt,
	previouslyAttributed: ReadonlySet<string>
): Promise<AttributedOutput[]> {
	const activities = new Map(
		attempt.activities.map((activity) => [activity.derivation, activity])
	);

	for (const derivation of activities.keys()) {
		if (snapshot.derivations.has(derivation)) {
			continue;
		}

		if (snapshot.complete) {
			throw new Error(
				`build activity was outside the pre-build derivation snapshot: ${derivation}`
			);
		}

		activities.delete(derivation);
	}

	if (activities.size === 0) {
		return [];
	}

	const candidates = await nix.queryDerivationOutputPaths(
		activities.keys().toArray()
	);
	const infos = await nix.queryValidPathsInfo(candidates);
	const outputs: AttributedOutput[] = [];

	for (const info of infos) {
		if (
			snapshot.validPaths.has(info.storePath) ||
			previouslyAttributed.has(info.storePath) ||
			info.deriver === undefined
		) {
			continue;
		}

		const activity = activities.get(info.deriver);
		if (activity === undefined) {
			continue;
		}

		outputs.push({
			storePath: info.storePath,
			derivation: info.deriver,
			attempt: attempt.attempt,
			attemptId: attempt.attemptId,
			machine: activity.machine
		});
	}

	return outputs.toSorted((left, right) =>
		left.storePath.localeCompare(right.storePath)
	);
}

export function registerBuildCommand(
	program: Command,
	environment: Environment = env
): void {
	program
		.command('build')
		.option(
			'--installables <value>',
			'installable to build (repeatable or newline-delimited)',
			collectLines,
			[]
		)
		.option(
			'--installables-file <path>',
			'file containing newline-delimited installables'
		)
		.option('--attempts <count>', 'maximum build attempts', '3')
		.option(
			'--keep-going <boolean>',
			'continue after an individual build failure',
			'false'
		)
		.option('--max-jobs <count>', 'maximum local build jobs')
		.option(
			'--allow-failure <boolean>',
			'return successfully after exhausting attempts',
			'false'
		)
		.option(
			'--derivation-graph-file <path>',
			'pre-evaluated recursive derivation graph'
		)
		.option('--paths-file <path>', 'where to write realised output paths')
		.option(
			'--publication-paths-file <path>',
			'where to write the store paths selected for publication'
		)
		.option(
			'--receipt-file <path>',
			'where to write the current-run build receipt'
		)
		.action((options: BuildOptions) => buildAction(options, environment));
}

export async function buildAction(
	options: BuildOptions,
	environment: Environment = env,
	dependencies: BuildDependencies = {}
): Promise<void> {
	const installables = [...(options.installables ?? [])];
	const installablesFile = provided(options.installablesFile);
	if (installablesFile !== undefined) {
		const contents = await readFile(path.resolve(installablesFile), 'utf8');
		installables.push(...parseLines(contents));
	}

	if (installables.length === 0) {
		throw new InvalidInputError(
			'installables',
			'installables must contain at least one value'
		);
	}
	if (!installables.every(isNixPositionalArgument)) {
		throw new InvalidInputError(
			'installables',
			'installables must not start with a hyphen or contain control characters'
		);
	}

	const attempts = Number(options.attempts ?? '3');
	if (!Number.isSafeInteger(attempts) || attempts < 1) {
		throw new InvalidInputError(
			'attempts',
			'attempts must be a positive integer'
		);
	}

	const isKeepGoing = isEnabled('keep-going', options.keepGoing, false);
	const isAllowFailure = isEnabled(
		'allow-failure',
		options.allowFailure,
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
	const publicationPathsFile = path.resolve(
		provided(options.publicationPathsFile) ??
			path.join(runnerTemporary, 'cupboard-publication-paths.txt')
	);
	const attributed: AttributedOutput[] = [];
	const attributedPaths = new Set<string>();
	const observed: BuildAttempt[] = [];
	let finalPaths: string[] = [];

	await mkdir(path.dirname(receiptFile), { recursive: true });
	const nix = dependencies.nix ?? Nix.open();
	const executeNix = dependencies.runNix ?? runNix;
	const nextAttemptId = dependencies.nextAttemptId ?? randomUUID;
	const sleep =
		dependencies.sleep ??
		((delayMs: number) =>
			new Promise((resolve) => setTimeout(resolve, delayMs)));
	const derivationGraphFile = provided(options.derivationGraphFile);
	let graph: ReadonlyMap<string, DerivationNode>;
	let isGraphComplete: boolean;

	if (derivationGraphFile === undefined) {
		const evaluated = await evaluateDerivationGraph(
			executeNix,
			installables,
			isAllowFailure
		);
		graph = evaluated.graph;
		isGraphComplete = evaluated.isComplete;
	} else {
		const graphText = await readFile(path.resolve(derivationGraphFile), 'utf8');
		const graphValue: unknown = JSON.parse(graphText);
		graph = derivationGraphFromJson(graphValue);
		isGraphComplete = true;
	}

	const snapshot = await buildSnapshot(nix, graph, isGraphComplete);
	let status: number | undefined;

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

		const result = await executeNix(invocation);
		status = result.status;
		finalPaths = result.stdout.split(/\r?\n/u).filter((line) => line !== '');
		let log = '';
		try {
			log = await readFile(logFile, 'utf8');
		} catch {
			// A failed Nix startup has no event log to attribute.
		}
		const buildAttempt = {
			attempt,
			attemptId,
			activities: buildActivities(log)
		};
		observed.push(buildAttempt);
		const attemptOutputs = await attributedAttemptOutputs(
			nix,
			snapshot,
			buildAttempt,
			attributedPaths
		);
		for (const output of attemptOutputs) {
			attributed.push(output);
			attributedPaths.add(output.storePath);
		}
		if (status === 0) {
			break;
		}
		if (attempt < attempts) {
			await sleep(attempt * 15_000);
		}
	}

	if (status !== 0 && !isAllowFailure) {
		throw new CommandFailedError('nix build', status ?? -1);
	}

	const finalInfos = await nix.queryPathsInfo(finalPaths);
	const finalDerivations = new Set(
		finalInfos.flatMap((info) =>
			info.deriver === undefined ? [] : [info.deriver]
		)
	);
	const verificationDerivations = [
		...new Set([
			...attributed.flatMap((output) =>
				output.machine === '' ? [] : [output.derivation]
			),
			...(snapshot.complete
				? []
				: observed.flatMap((attempt) =>
						attempt.activities.flatMap((activity) =>
							activity.machine !== '' &&
							finalDerivations.has(activity.derivation)
								? [activity.derivation]
								: []
						)
					))
		])
	].toSorted((left, right) => left.localeCompare(right));
	if (verificationDerivations.length > 0) {
		const verification = await executeNix(
			nixBuildInvocation(
				[
					'build',
					'--rebuild',
					'--no-link',
					'--builders',
					'',
					'--max-jobs',
					'1',
					'--keep-going'
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

	const selectedBuiltOutputInfos = await builtOutputInfos(nix, attributed);
	const selectedBuiltOutputPaths = selectedBuiltOutputInfos.map(
		(info) => info.storePath
	);
	const selectedPublicationPaths = publicationPaths({
		targetPaths: finalPaths,
		builtOutputPaths: selectedBuiltOutputPaths
	});
	const retainedPaths =
		finalPaths.length === 0
			? retentionRootPaths(selectedBuiltOutputInfos)
			: finalPaths;
	const publicationInfos = new Map(
		[...finalInfos, ...selectedBuiltOutputInfos].map((info) => [
			info.storePath,
			info
		])
	)
		.values()
		.toArray();
	const subjects = receiptSubjects(
		attributed,
		publicationInfos,
		snapshot.validPaths
	);
	const receipt: BuildReceipt = {
		version: 1,
		paths: selectedPublicationPaths,
		subjects
	};
	await mkdir(path.dirname(pathsFile), { recursive: true });
	await writeFile(
		pathsFile,
		retainedPaths.join('\n').concat(retainedPaths.length === 0 ? '' : '\n')
	);
	await writeFile(
		publicationPathsFile,
		selectedPublicationPaths
			.join('\n')
			.concat(selectedPublicationPaths.length === 0 ? '' : '\n')
	);
	await writeFile(receiptFile, `${JSON.stringify(receipt)}\n`);
	await setOutput(environment, 'paths-file', pathsFile);
	await setOutput(environment, 'publication-paths-file', publicationPathsFile);
	await setOutput(
		environment,
		'publication-path-count',
		String(selectedPublicationPaths.length)
	);
	await setOutput(environment, 'receipt-file', receiptFile);
	const delimiter = `CUPBOARD_PATHS_${randomUUID().replaceAll('-', '_')}`;
	await appendEnvironmentFile(
		environment.GITHUB_OUTPUT,
		`paths<<${delimiter}\n${retainedPaths.join('\n')}\n${delimiter}\n`
	);
}
