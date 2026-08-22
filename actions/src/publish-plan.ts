import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import {
	type StoredCache,
	type StoreDirectory,
	type StorePathHash,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	cacheAvailabilityMaxPaths,
	cacheAvailabilityResponseSchema
} from '@cupboard/protocol/cache-availability';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { basicAuthHeader, type BasicCredential } from '@cupboard/shared/http';
import { retryingFetcher } from '@cupboard/shared/retry';
import { z } from 'zod';

import { fetchWithProbeDeadline } from './cache-probe.ts';
import {
	CacheAvailabilityQueryError,
	CacheAvailabilityResponseMalformedError,
	CacheAvailabilityResponseSchemaError,
	CacheAvailabilityResponseUnexpectedHashError,
	CohortExecutionContextError,
	CohortFailureToleranceError,
	DerivationGraphShapeError,
	DerivationNodeMissingError,
	DerivationRootCountError,
	DuplicateGroupKeyError,
	PublishPlanInvariantError,
	TargetEvaluationError,
	TargetEvaluationResponseError,
	TargetRootUnresolvedError
} from './errors.ts';
import { isNixPositionalArgument } from './options.ts';
import { cacheUrlFor } from './substituters.ts';

const execFileAsync = promisify(execFile);

export const maximumConcurrentAvailabilityQueries = 4;

export type NixEvaluator = (
	arguments_: readonly string[]
) => Promise<{ stdout: string }>;

const defaultNixEvaluator: NixEvaluator = (arguments_) =>
	execFileAsync('nix', [...arguments_], {
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024
	});

// Strip only leading and trailing slashes. Equivalent suffix spellings must
// produce the same root, while interior slashes remain significant.
export function canonicalRootSuffix(suffix: string): string {
	return suffix.replace(/^\/+/u, '').replace(/\/+$/u, '');
}

/**
 * Retained-target checks and build jobs must construct byte-identical root
 * names. Canonicalise the prefix and suffix here for every consumer.
 */
export function joinRoot(prefix: string, suffix: string): string {
	return `${prefix.replace(/\/+$/u, '')}/${canonicalRootSuffix(suffix)}`;
}

/**
 * GitHub compares runner labels case-insensitively with .NET's ordinal rules.
 * JavaScript's full case conversion differs outside ASCII, so manifest parsing
 * permits only printable ASCII labels without spaces.
 */
export function isValidRunnerLabel(label: string): boolean {
	return /^[!-~]+$/u.test(label);
}

const derivationPathSchema = storePathSchema.refine(
	(value) => value.endsWith('.drv'),
	{ message: 'rootDrvPath must name a derivation in /nix/store' }
);

// Bound cohort labels because they become part of matrix job keys.
export const cohortLabelMaxLength = 100;

const publishOutputsSchema = z
	.array(
		z.string().min(1).refine(isNixPositionalArgument, {
			message:
				'output must not start with a hyphen or contain control characters'
		})
	)
	.min(1)
	.default(['out'])
	.transform((outputs) => [...new Set(outputs)]);

/**
 * Component entries inherit the aggregate target's execution context,
 * retention root, failure policy and cohort; see {@link expandComponents}.
 */
export const publishComponentSchema = z.strictObject({
	attr: z.string().min(1).refine(isNixPositionalArgument, {
		message: 'attr must not start with a hyphen or contain control characters'
	}),
	rootDrvPath: derivationPathSchema.optional(),
	outputs: publishOutputsSchema
});
export type PublishComponent = z.output<typeof publishComponentSchema>;

export const publishTargetSchema = z.strictObject({
	attr: z.string().min(1).refine(isNixPositionalArgument, {
		message: 'attr must not start with a hyphen or contain control characters'
	}),
	rootDrvPath: derivationPathSchema.optional(),
	system: z.string().min(1),
	os: z.string().min(1).refine(isValidRunnerLabel, {
		message: 'os must be a printable ASCII runner label without spaces'
	}),
	remote: z.boolean(),
	bestEffort: z.boolean().default(false),
	rootSuffix: z
		.string()
		.min(1)
		.refine((value) => canonicalRootSuffix(value) !== '', {
			message: 'root suffix must contain more than slashes'
		}),
	outputs: publishOutputsSchema,
	// Targets with the same cohort label form one cohort (see cohortsFor). A
	// target without a label forms its own cohort, keyed by its identity.
	cohort: z
		.string()
		.min(1)
		.max(cohortLabelMaxLength)
		.refine(isValidRunnerLabel, {
			message: `cohort must be a printable ASCII label of at most ${String(cohortLabelMaxLength)} characters without spaces`
		})
		.optional(),
	// When components are present, do not evaluate or build this target's own
	// attr and rootDrvPath. Publish its components under its rootSuffix instead;
	// see expandComponents.
	components: z.array(publishComponentSchema).min(1).optional()
});

// Retention treats all targets sharing a root as retained after one successful
// ensure. Duplicate roots could therefore race or cause an uncached target to
// be skipped. Check canonical suffixes so `app`, `/app` and `app/` conflict.
export const publishTargetsSchema = z
	.array(publishTargetSchema)
	.min(1)
	.superRefine((targets, ctx) => {
		const firstBySuffix = new Map<
			string,
			{ readonly index: number; readonly spelling: string }
		>();

		for (const [index, target] of targets.entries()) {
			const canonical = canonicalRootSuffix(target.rootSuffix);
			const first = firstBySuffix.get(canonical);

			if (first === undefined) {
				firstBySuffix.set(canonical, {
					index,
					spelling: target.rootSuffix
				});
				continue;
			}

			ctx.addIssue({
				code: 'custom',
				path: [index, 'rootSuffix'],
				message: `duplicate rootSuffix '${target.rootSuffix}': names the same root as '${first.spelling}' on target ${String(first.index)}`
			});
		}
	})
	.transform((targets) =>
		targets.map((target) => ({
			...target,
			rootSuffix: canonicalRootSuffix(target.rootSuffix)
		}))
	);

export type PublishTarget = z.output<typeof publishTargetSchema>;

/**
 * Replaces each aggregate target with one synthetic target per component.
 * Components inherit the aggregate's execution context, failure policy, cohort
 * and root suffix, so they publish under one retention root. Targets without
 * components pass through unchanged. The aggregate itself is not evaluated or
 * built; the activating machine assembles it from the published components.
 * Input validation limits the component list to the number of targets a root
 * can accept in one update.
 */
export function expandComponents(
	targets: readonly PublishTarget[]
): readonly PublishTarget[] {
	return targets.flatMap((target) => {
		if (target.components === undefined) {
			return [target];
		}

		return target.components.map((component): PublishTarget => ({
			attr: component.attr,
			...(component.rootDrvPath !== undefined && {
				rootDrvPath: component.rootDrvPath
			}),
			system: target.system,
			os: target.os,
			remote: target.remote,
			bestEffort: target.bestEffort,
			rootSuffix: target.rootSuffix,
			outputs: component.outputs,
			...(target.cohort !== undefined && { cohort: target.cohort })
		}));
	});
}

export interface DerivationOutput {
	readonly name: string;
	readonly path?: StorePathString;
}

export interface DerivationNode {
	readonly drvPath: string;
	readonly inputs: ReadonlyMap<string, readonly string[]>;
	readonly outputs: readonly DerivationOutput[];
}

export interface TargetEvaluation {
	readonly target: PublishTarget;
	readonly rootDrvPath: string;
	readonly nodes: ReadonlyMap<string, DerivationNode>;
	readonly targetPaths: readonly StorePathString[];
}

/**
 * Targets in one cohort run in one job. A target without an explicit `cohort`
 * label forms its own cohort. Cohorts partition the complete manifest before
 * destination availability is checked, so retained targets remain members.
 */
export interface Cohort {
	readonly key: string;
	readonly system: string;
	readonly os: string;
	readonly remote: boolean;
	readonly targets: readonly PublishTarget[];
	readonly installables: readonly string[];
}

export interface DerivationToTargetsEntry {
	readonly drvPath: string;
	readonly targets: readonly string[];
}

export interface PublishPlan {
	readonly retained: readonly PublishTarget[];
	readonly targets: readonly PublishTarget[];
	readonly cohorts: readonly Cohort[];
	readonly derivationToTargets: readonly DerivationToTargetsEntry[];
}

export interface UnevaluatedTarget {
	readonly target: PublishTarget;
	readonly reason: string;
}

export interface EvaluatedTargets {
	readonly evaluations: readonly TargetEvaluation[];
	readonly unevaluated: readonly UnevaluatedTarget[];
}

interface ResolvedTargetRoot {
	readonly target: PublishTarget;
	readonly rootDrvPath: string;
}

export function planPublish(options: {
	readonly evaluations: readonly TargetEvaluation[];
	readonly retainedRoots: ReadonlySet<string>;
	readonly unevaluated?: readonly PublishTarget[];
}): PublishPlan {
	const retained: PublishTarget[] = [];
	const pending: TargetEvaluation[] = [];

	for (const evaluation of options.evaluations) {
		if (options.retainedRoots.has(evaluation.target.rootSuffix)) {
			retained.push(evaluation.target);
			continue;
		}

		pending.push(evaluation);
	}

	const targets = [
		...pending.map((evaluation) => evaluation.target),
		...(options.unevaluated ?? [])
	];

	// Cohort membership comes from the complete manifest, not the pending build
	// set. A retained target must remain in any cohort job that still runs.
	const allTargets = [
		...options.evaluations.map((evaluation) => evaluation.target),
		...(options.unevaluated ?? [])
	];

	return {
		retained,
		targets,
		cohorts: cohortsFor(allTargets),
		derivationToTargets: derivationToTargetsFor(options.evaluations)
	};
}

// Probe only the predictable outputs used by the retained-target check, not
// every path in each target's dependency graph.
export function cacheProbePaths(
	evaluations: readonly TargetEvaluation[]
): StorePathString[] {
	const paths = new Set<StorePathString>(
		evaluations.flatMap((evaluation) => evaluation.targetPaths)
	);

	return paths.values().toArray();
}

export async function evaluateTargets(
	targets: readonly PublishTarget[],
	storeDirectory: StoreDirectory,
	evaluator: NixEvaluator = defaultNixEvaluator
): Promise<EvaluatedTargets> {
	const resolved: ResolvedTargetRoot[] = [];
	const unevaluated: UnevaluatedTarget[] = [];

	for (const target of targets) {
		if (target.rootDrvPath !== undefined) {
			resolved.push({ target, rootDrvPath: target.rootDrvPath });
			continue;
		}

		const error = new TargetRootUnresolvedError(target.attr);

		if (!target.bestEffort) {
			throw error;
		}

		unevaluated.push({ target, reason: error.message });
	}

	if (resolved.length === 0) {
		return { evaluations: [], unevaluated };
	}

	const evaluated = await evaluateResolvedTargets(
		resolved,
		storeDirectory,
		evaluator
	);

	return {
		evaluations: evaluated.filter(
			(evaluation): evaluation is TargetEvaluation => 'nodes' in evaluation
		),
		unevaluated: [
			...unevaluated,
			...evaluated.filter(
				(evaluation): evaluation is UnevaluatedTarget => 'reason' in evaluation
			)
		]
	};
}

async function evaluateResolvedTargets(
	resolutions: readonly ResolvedTargetRoot[],
	storeDirectory: StoreDirectory,
	evaluator: NixEvaluator
): Promise<(TargetEvaluation | UnevaluatedTarget)[]> {
	if (resolutions.length === 1) {
		return [
			await evaluateResolvedTarget(
				requireIndex(resolutions, 0),
				storeDirectory,
				evaluator
			)
		];
	}

	try {
		const attributes = resolutions.map((resolution) => resolution.target.attr);
		const rootDrvPaths = [
			...new Set(resolutions.map((resolution) => resolution.rootDrvPath))
		];
		const label = attributes.join(', ');
		const value = await evaluateDerivationsAsync(
			rootDrvPaths,
			true,
			evaluator,
			label
		);
		const nodes = derivationNodes(label, value, storeDirectory);

		return resolutions.map(({ target, rootDrvPath }) =>
			evaluationForRoot(target, nodes, rootDrvPath)
		);
	} catch {
		const evaluated: (TargetEvaluation | UnevaluatedTarget)[] = [];

		for (const resolution of resolutions) {
			evaluated.push(
				await evaluateResolvedTarget(resolution, storeDirectory, evaluator)
			);
		}

		return evaluated;
	}
}

async function evaluateResolvedTarget(
	resolution: ResolvedTargetRoot,
	storeDirectory: StoreDirectory,
	evaluator: NixEvaluator
): Promise<TargetEvaluation | UnevaluatedTarget> {
	const { target, rootDrvPath } = resolution;

	try {
		const value = await evaluateDerivationsAsync(
			[rootDrvPath],
			true,
			evaluator,
			target.attr
		);
		const nodes = derivationNodes(target.attr, value, storeDirectory);

		return evaluationForRoot(target, nodes, rootDrvPath);
	} catch (error) {
		if (!target.bestEffort) {
			throw error;
		}

		return { target, reason: evaluationFailureReason(error) };
	}
}

// Best-effort failures become workflow warnings. Include the evaluator's cause
// so the warning explains the failure instead of reporting only the target.
function evaluationFailureReason(error: unknown): string {
	if (error instanceof TargetEvaluationError && error.cause instanceof Error) {
		return `${error.message}: ${error.cause.message}`;
	}

	return error instanceof Error ? error.message : String(error);
}

export function evaluationFromJson(
	target: PublishTarget,
	value: unknown,
	storeDirectory: StoreDirectory
): TargetEvaluation {
	const nodes = derivationNodes(target.attr, value, storeDirectory);
	const referenced = new Set<string>();

	for (const node of nodes.values()) {
		for (const input of node.inputs.keys()) {
			referenced.add(input);
		}
	}

	const roots = nodes
		.keys()
		.filter((drvPath) => !referenced.has(drvPath))
		.toArray();

	if (roots.length !== 1) {
		throw new DerivationRootCountError(target.attr, roots.length);
	}

	const rootDrvPath = requireIndex(roots, 0);

	return evaluationForRoot(target, nodes, rootDrvPath);
}

function evaluationForRoot(
	target: PublishTarget,
	graph: ReadonlyMap<string, DerivationNode>,
	rootDrvPath: string
): TargetEvaluation {
	const nodes = new Map<string, DerivationNode>();
	const pending = [rootDrvPath];

	while (pending.length > 0) {
		const drvPath = requireIndex(pending, pending.length - 1);
		pending.pop();

		if (nodes.has(drvPath)) {
			continue;
		}

		const node = graph.get(drvPath);

		if (node === undefined) {
			throw new DerivationNodeMissingError(target.attr, drvPath);
		}

		nodes.set(drvPath, node);
		pending.push(...node.inputs.keys());
	}

	const root = requireValue(nodes.get(rootDrvPath), rootDrvPath);
	const selected = new Set(target.outputs);
	const targetPaths = root.outputs
		.filter((output) => selected.has(output.name))
		.map((output) => output.path)
		.filter((outputPath) => outputPath !== undefined);

	return { target, rootDrvPath, nodes, targetPaths };
}

async function evaluateDerivationsAsync(
	installables: readonly string[],
	isRecursive: boolean,
	evaluator: NixEvaluator,
	label = installables.join(', ')
): Promise<unknown> {
	const arguments_ = [
		'derivation',
		'show',
		...(isRecursive ? ['-r'] : []),
		'--',
		...installables
	];

	try {
		const result = await evaluator(arguments_);

		return parseDerivationResponse(label, result.stdout);
	} catch (error) {
		if (error instanceof TargetEvaluationResponseError) {
			throw error;
		}

		throw new TargetEvaluationError(label, { cause: error });
	}
}

function parseDerivationResponse(label: string, stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch (error) {
		throw new TargetEvaluationResponseError(
			label,
			error instanceof SyntaxError ? error : new SyntaxError(String(error))
		);
	}
}

// Nix prints an input either as a list of consumed output names or as an object
// whose `outputs` field contains that list.
const outputNamesSchema = z.array(z.string());
const derivationInputSchema = z.union([
	outputNamesSchema,
	z.looseObject({ outputs: outputNamesSchema.default([]) })
]);

const derivationInputsSchema = z.record(z.string(), derivationInputSchema);
const derivationInputsFieldSchema = z.looseObject({
	drvs: derivationInputsSchema.optional()
});
const derivationOutputSchema = z.looseObject({ path: z.string().optional() });

// Accept both `inputs.drvs`, which current Nix versions print, and the older
// `inputDrvs` spelling. An output path can appear in `path` or in the matching
// `env` value. Content-addressed placeholders are not store paths, so those
// outputs remain unresolved. Ignore fields that planning does not use.
const derivationNodeBaseSchema = z.looseObject({
	inputs: derivationInputsFieldSchema.optional(),
	inputDrvs: derivationInputsSchema.optional(),
	outputs: z.record(z.string(), derivationOutputSchema).default({}),
	env: z.record(z.string(), z.string()).default({})
});

type ParsedDerivationNode = z.output<typeof derivationNodeBaseSchema>;

function derivationNodeSchema(storeDirectory: StoreDirectory) {
	return derivationNodeBaseSchema.transform((node) => ({
		inputs: nodeInputs(node, storeDirectory),
		outputs: nodeOutputs(node, storeDirectory)
	}));
}

// Nix prints a bare map from derivation path to node. The Determinate evaluator
// wraps the same map in `derivations`; unwrap it before parsing the nodes.
const derivationWrapperSchema = z.looseObject({
	derivations: z.record(z.string(), z.unknown())
});

function derivationDocumentSchema(storeDirectory: StoreDirectory) {
	return z.preprocess(
		(value) => {
			const wrapper = derivationWrapperSchema.safeParse(value);

			return wrapper.success ? wrapper.data.derivations : value;
		},
		z.record(z.string(), derivationNodeSchema(storeDirectory))
	);
}

function derivationNodes(
	attribute: string,
	value: unknown,
	storeDirectory: StoreDirectory
): Map<string, DerivationNode> {
	const parsed = derivationDocumentSchema(storeDirectory).safeParse(value);

	if (!parsed.success) {
		throw new DerivationGraphShapeError(attribute, { cause: parsed.error });
	}

	const nodes = new Map<string, DerivationNode>();

	for (const [rawDrvPath, body] of Object.entries(parsed.data)) {
		const drvPath = absoluteStorePath(rawDrvPath, storeDirectory);
		nodes.set(drvPath, { drvPath, ...body });
	}

	return nodes;
}

function nodeInputs(
	node: ParsedDerivationNode,
	storeDirectory: StoreDirectory
): Map<string, readonly string[]> {
	const drvs = node.inputs?.drvs ?? node.inputDrvs ?? {};
	const inputs = new Map<string, readonly string[]>();

	for (const [inputPath, input] of Object.entries(drvs)) {
		inputs.set(
			absoluteStorePath(inputPath, storeDirectory),
			Array.isArray(input) ? input : input.outputs
		);
	}

	return inputs;
}

function nodeOutputs(
	node: ParsedDerivationNode,
	storeDirectory: StoreDirectory
): DerivationOutput[] {
	return Object.entries(node.outputs).map(([name, output]) => {
		const candidate = output.path ?? node.env[name];

		if (candidate === undefined) {
			return { name };
		}

		const path = storePathSchema.safeParse(
			absoluteStorePath(candidate, storeDirectory)
		);

		return path.success ? { name, path: path.data } : { name };
	});
}

// A bare derivation basename refers to the store used by the Nix evaluator.
// Resolve it against that store's configured directory, not `/nix/store`.
function absoluteStorePath(
	storePath: string,
	storeDirectory: StoreDirectory
): string {
	const prefix = `${storeDirectory}/`;

	return storePath.startsWith(prefix) ? storePath : `${prefix}${storePath}`;
}

interface ProbeOptions {
	readonly paths: readonly StorePathString[];
	readonly credentials?: BasicCredential;
	readonly fetcher?: typeof fetch;
}

export function availableCachePaths(
	options: ProbeOptions & {
		readonly baseUrl: URL;
		readonly cache: StoredCache;
	}
): Promise<Set<StorePathString>> {
	return availablePathsAt(
		cacheUrlFor(options.baseUrl, options.cache),
		options,
		cacheAvailabilityMaxPaths
	);
}

async function availablePathsAt(
	probeUrl: URL,
	options: ProbeOptions,
	maximumBatchSize: number
): Promise<Set<StorePathString>> {
	const paths = new Set(options.paths).values().toArray();

	if (paths.length === 0) {
		return new Set();
	}

	const pathsByHash = new Map<StorePathHash, StorePathString[]>();

	for (const storePath of paths) {
		const hash = StorePath.hash(storePath);
		const matching = pathsByHash.get(hash) ?? [];
		matching.push(storePath);
		pathsByHash.set(hash, matching);
	}

	const batches = chunk(pathsByHash.keys().toArray(), maximumBatchSize);
	const fetcher = retryingFetcher(options.fetcher ?? fetch);
	const headers = {
		'content-type': 'application/json',
		...(options.credentials !== undefined &&
			basicAuthHeader(options.credentials))
	};
	const firstBatch = requireIndex(batches, 0);
	const firstMissing = await queryMissingStorePathHashes(
		fetcher,
		probeUrl,
		firstBatch,
		headers
	);

	const remainingMissing = await mapWithConcurrency(
		batches.slice(1),
		maximumConcurrentAvailabilityQueries,
		(batch) => queryMissingStorePathHashes(fetcher, probeUrl, batch, headers)
	);
	const missing = new Set([...firstMissing, ...remainingMissing.flat()]);
	const available = new Set<StorePathString>();

	for (const [hash, matchingPaths] of pathsByHash) {
		if (missing.has(hash)) {
			continue;
		}

		for (const storePath of matchingPaths) {
			available.add(storePath);
		}
	}

	return available;
}

async function queryMissingStorePathHashes(
	fetcher: typeof fetch,
	probeUrl: URL,
	storePathHashes: readonly StorePathHash[],
	headers: Readonly<Record<string, string>>
): Promise<StorePathHash[]> {
	// Append the protocol path to one canonical rendering of the cache URL.
	const target = `${canonicalHref(probeUrl)}/api/v1/missing-paths`;

	return fetchWithProbeDeadline(
		fetcher,
		target,
		{
			body: JSON.stringify({ storePathHashes }),
			headers,
			method: 'POST'
		},
		async (response) => {
			if (!response.ok) {
				await discardResponseBody(response);
				throw new CacheAvailabilityQueryError(response.status);
			}

			let value: unknown;

			try {
				value = await response.json();
			} catch (error) {
				throw new CacheAvailabilityResponseMalformedError(
					error instanceof SyntaxError ? error : new SyntaxError(String(error))
				);
			}

			const parsed = cacheAvailabilityResponseSchema.safeParse(value);

			if (!parsed.success) {
				throw new CacheAvailabilityResponseSchemaError(parsed.error);
			}

			const requested = new Set(storePathHashes);
			const unexpected = parsed.data.missingStorePathHashes.find(
				(storePathHash) => !requested.has(storePathHash)
			);

			if (unexpected !== undefined) {
				throw new CacheAvailabilityResponseUnexpectedHashError(unexpected);
			}

			return parsed.data.missingStorePathHashes;
		}
	);
}

/**
 * Fails the plan when two cohorts would emit the same key. The workflow selects
 * a job by its key alone, so two cohorts sharing one could not be told apart.
 */
export function assertDistinctGroupKeys(
	groups: readonly { readonly key: string }[]
): void {
	const seen = new Set<string>();

	for (const group of groups) {
		if (seen.has(group.key)) {
			throw new DuplicateGroupKeyError(group.key);
		}

		seen.add(group.key);
	}
}

// GitHub matches runner labels case-insensitively, so grouping and keying
// compare this canonical form, never the raw spelling.
function canonicalRunnerLabel(label: string): string {
	return label.toLowerCase();
}

function executionContextKey(target: PublishTarget): string {
	return JSON.stringify([
		target.system,
		canonicalRunnerLabel(target.os),
		target.remote
	]);
}

export function isBestEffortCohort(members: readonly PublishTarget[]): boolean {
	return members.every((member) => member.bestEffort);
}

/**
 * Destination availability does not change cohort membership. Partition the
 * complete manifest by explicit `cohort` label, with an individual cohort for
 * each target that has no label.
 */
export function cohortsFor(targets: readonly PublishTarget[]): Cohort[] {
	const byLabel = new Map<string, PublishTarget[]>();

	for (const target of targets) {
		const label = target.cohort ?? target.attr;
		const members = byLabel.get(label) ?? [];
		members.push(target);
		byLabel.set(label, members);
	}

	const cohorts = byLabel
		.entries()
		.map(([label, members]) => cohortFor(label, members))
		.toArray()
		.toSorted((left, right) => left.key.localeCompare(right.key));

	assertDistinctGroupKeys(cohorts);

	return cohorts;
}

function cohortFor(label: string, members: readonly PublishTarget[]): Cohort {
	const first = requireIndex(members, 0);
	const context = executionContextKey(first);

	for (const member of members) {
		if (executionContextKey(member) !== context) {
			throw new CohortExecutionContextError(label, first.attr, member.attr);
		}

		if (member.bestEffort !== first.bestEffort) {
			const bestEffortAttribute = first.bestEffort ? first.attr : member.attr;
			const requiredAttribute = first.bestEffort ? member.attr : first.attr;

			throw new CohortFailureToleranceError(
				label,
				bestEffortAttribute,
				requiredAttribute
			);
		}
	}

	return {
		key: cohortKey(label, first),
		system: first.system,
		os: first.os,
		remote: first.remote,
		targets: members,
		installables: members.map(
			(member) => `${member.attr}^${member.outputs.join(',')}`
		)
	};
}

// Combine readable context fields with a 64-bit hash of the complete tuple.
// The label is part of the hash so per-target cohorts remain distinct within
// one execution context. Hashing also prevents ambiguous joined fields such as
// (`a-b`, `c`) and (`a`, `b-c`) from colliding. `assertDistinctGroupKeys`
// rejects any remaining collision.
function cohortKey(label: string, target: PublishTarget): string {
	const os = canonicalRunnerLabel(target.os);
	const mode = target.remote ? 'remote' : 'local';
	const digest = createHash('sha256')
		.update(JSON.stringify([target.system, os, target.remote, label]))
		.digest('hex')
		.slice(0, 16);

	return `cohort-${target.system}-${os}-${mode}-${digest}`;
}

/**
 * Record which target graphs contain each derivation. This map is attribution
 * evidence only; it does not instruct a build to realise every derivation in
 * those graphs.
 */
export function derivationToTargetsFor(
	evaluations: readonly TargetEvaluation[]
): DerivationToTargetsEntry[] {
	const targetsByDrvPath = new Map<string, Set<string>>();

	for (const evaluation of evaluations) {
		for (const drvPath of evaluation.nodes.keys()) {
			const attributes = targetsByDrvPath.get(drvPath) ?? new Set<string>();
			attributes.add(evaluation.target.attr);
			targetsByDrvPath.set(drvPath, attributes);
		}
	}

	return targetsByDrvPath
		.entries()
		.map(([drvPath, attributes]) => ({
			drvPath,
			targets: attributes
				.values()
				.toArray()
				.toSorted((left, right) => left.localeCompare(right))
		}))
		.toArray()
		.toSorted((left, right) => left.drvPath.localeCompare(right.drvPath));
}

export type TargetCoverageStatus =
	'covered' | 'not-covered' | 'unknown-output' | 'failed';

/**
 * `covered` requires the root's last reconciled list to contain every current
 * output. Keep unknown output paths and failed reads distinct so callers do not
 * treat them as cache misses.
 */
export interface TargetCoverage {
	readonly attr: string;
	readonly status: TargetCoverageStatus;
	readonly reason?: string;
}

/**
 * A retained root covers a known-output target only when its last reconciled
 * path list contains every current output. Callers handle unknown outputs and
 * failed reads before this check.
 */
export function evaluateTargetCoverage(
	target: PublishTarget,
	targetPaths: readonly StorePathString[],
	check: {
		readonly retained: boolean;
		readonly reconciledPaths: ReadonlySet<StorePathString>;
	}
): TargetCoverage {
	if (!check.retained) {
		return { attr: target.attr, status: 'not-covered' };
	}

	const isCovered = targetPaths.every((path) =>
		check.reconciledPaths.has(path)
	);

	return { attr: target.attr, status: isCovered ? 'covered' : 'not-covered' };
}

export interface CohortPreFilterDecision {
	readonly key: string;
	readonly pruned: boolean;
	readonly reason?: string;
}

/**
 * The advisory pre-filter may prune a cohort only when every member is covered.
 * An uncovered, unknown or failed member keeps the job in the plan. Failures
 * record their reasons but do not fail planning because this check exists only
 * to avoid unnecessary runner work.
 */
export function cohortPreFilterDecision(
	cohort: Cohort,
	coverageByAttribute: ReadonlyMap<string, TargetCoverage>
): CohortPreFilterDecision {
	const coverage = cohort.targets.map(
		(target): TargetCoverage =>
			coverageByAttribute.get(target.attr) ?? {
				attr: target.attr,
				status: 'not-covered'
			}
	);
	const failures = coverage.filter((entry) => entry.status === 'failed');

	if (failures.length > 0) {
		return {
			key: cohort.key,
			pruned: false,
			reason: failures
				.map((entry) => `${entry.attr}: ${entry.reason ?? 'unknown failure'}`)
				.join('; ')
		};
	}

	const isPruned = coverage.every((entry) => entry.status === 'covered');

	return { key: cohort.key, pruned: isPruned };
}

function requireIndex<T>(values: readonly T[], index: number): T {
	return requireValue(values[index], `index ${String(index)}`);
}

function requireValue<T>(value: T | undefined, subject: string): T {
	if (value === undefined) {
		throw new PublishPlanInvariantError(subject);
	}

	return value;
}
