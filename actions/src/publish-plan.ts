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

// Remove leading and trailing slashes so equivalent suffixes produce the same
// root. Interior slashes remain significant to the server.
export function canonicalRootSuffix(suffix: string): string {
	return suffix.replace(/^\/+/u, '').replace(/\/+$/u, '');
}

/**
 * Joins a root prefix and suffix in the canonical form used by every target
 * root consumer. Cached-target checks and build jobs therefore use identical
 * root names.
 */
export function joinRoot(prefix: string, suffix: string): string {
	return `${prefix.replace(/\/+$/u, '')}/${canonicalRootSuffix(suffix)}`;
}

/**
 * Whether a runner label may be used at all: printable ASCII with no spaces.
 * GitHub matches labels case-insensitively with .NET's ordinal comparison,
 * whose case folding differs from JavaScript's full case conversion outside
 * ASCII (the sharp s, the sigma family), so a non-ASCII `os` label is
 * refused when the manifest is parsed.
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
 * One member of a component-publication target. The component supplies its
 * attribute and optional derivation path. It inherits its execution context,
 * retention root, failure policy and cohort from the aggregate target; see
 * {@link expandComponents}.
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
	// Two targets naming the same cohort form one cohort (see cohortsFor); a
	// target that omits it is its own cohort, keyed by its own identity.
	cohort: z
		.string()
		.min(1)
		.max(cohortLabelMaxLength)
		.refine(isValidRunnerLabel, {
			message: `cohort must be a printable ASCII label of at most ${String(cohortLabelMaxLength)} characters without spaces`
		})
		.optional(),
	// Component publication: see expandComponents. Present, this target's own
	// attr and rootDrvPath are never evaluated or built; its components are
	// published in its place, under its own rootSuffix.
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
 * One manifest-declared cohort: the targets that run together in one job.
 * Absent an explicit `cohort` label a target is its own cohort, so cohorts
 * partition the whole manifest, retained targets included, exactly as
 * declared; nothing here depends on what the destination already holds.
 */
export interface Cohort {
	readonly key: string;
	readonly system: string;
	readonly os: string;
	readonly remote: boolean;
	readonly targets: readonly PublishTarget[];
	// The multi-installable build request a cohort job hands to `nix build`:
	// one `attr^outputs` form per member, the same shape a target job builds
	// today.
	readonly installables: readonly string[];
}

/**
 * One derivation and the target identities (attrs) whose evaluated graph
 * contains it. Built from the recursive graph {@link evaluateTargets}
 * already read, so a streamed build's post-build hook can resolve a
 * `DRV_PATH` to the target, and from there the root, it belongs to without
 * asking Nix again.
 */
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

	// Cohorts partition the whole declared manifest, not just what still needs
	// building, so a target already retained still keeps its place in the
	// cohort a later run's cohort job would see.
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

// The availability probe asks only about the paths the retained-target check
// reads: each evaluated target's own predictable outputs.
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

// A best-effort target's failure is surfaced as a workflow warning rather than
// thrown, so the reason keeps the evaluator's own message: a
// {@link TargetEvaluationError} names the attribute and carries that message as
// its cause, so both are joined back into one line.
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

// A node's declared inputs: either the bare list of consumed output names, or
// the object form `nix derivation show` prints, whose `outputs` list holds the
// same names.
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

// One derivation as `nix derivation show` prints it. Only the fields the plan
// reads are named; the derivation carries many others, so the object is loose.
// `inputs.drvs` is the current spelling and `inputDrvs` the older one. An
// output's store path is either its own `path` or the path `env` records under
// the output name; a content-addressed output carries a placeholder there
// instead, which is not a store path and leaves the output pathless.
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

// `nix derivation show` prints a bare map of drvPath to node; the Determinate
// evaluator wraps the same map under `derivations`. Unwrapping to the inner map
// leaves one document shape to parse.
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

// A derivation reference is printed either absolute or as a bare basename, and
// a basename belongs to the store the evaluating Nix reads, whose directory the
// runner's configuration decides.
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
	// The query hangs off the base under a fixed protocol path, so the base is
	// rendered once and the path appended as text.
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
				await response.body?.cancel();
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
 * Fails the plan when two cohorts would emit one key: the workflow selects
 * jobs solely by key, so a shared key would make colliding jobs consume both
 * cohorts.
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

/**
 * Whether a cohort's failure is one the manifest tolerates. {@link cohortsFor}
 * rejects a labelled cohort whose members disagree, so every member has the
 * same value here. Cohorts themselves are never empty.
 */
export function isBestEffortCohort(members: readonly PublishTarget[]): boolean {
	return members.every((member) => member.bestEffort);
}

/**
 * Partitions the complete manifest into cohorts. An explicit `cohort` label
 * groups targets in one job; otherwise each target forms its own cohort.
 * Destination availability does not change cohort membership.
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
 * Maps each derivation in the evaluated dependency graphs to its owning target
 * attributes. The post-build hook uses this map to attribute a `DRV_PATH`
 * without querying Nix during the build. The graph records attribution
 * evidence; it does not instruct the build to realise every derivation in the
 * graph.
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
 * The advisory pre-filter result for one target. `covered` requires the root's
 * last reconciled list to contain every current output. Unknown output paths
 * and failed reads use distinct statuses so callers do not treat them as cache
 * misses.
 */
export interface TargetCoverage {
	readonly attr: string;
	readonly status: TargetCoverageStatus;
	readonly reason?: string;
}

/**
 * Determines whether a known-output target remains retained and whether its
 * reconciled root contains every current output. Callers produce
 * `unknown-output` and `failed` before reaching this check.
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
 * Reduces a cohort's member coverage to one prune decision. The pre-filter
 * prunes jobs, never composes build sets, so this only ever decides whether
 * the cohort's job is needed at all: pruned when every member is covered,
 * and never pruned when any member is uncovered, unknown, or failed. A
 * failed member makes the whole decision advisory rather than a refusal:
 * the job spawns and the reason travels with it, so the plan itself never
 * goes red for a check whose only job is to save runner minutes.
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
