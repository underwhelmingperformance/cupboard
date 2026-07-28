import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import {
	type StoredCache,
	type StorePathHash,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	cacheAvailabilityMaxPaths,
	cacheAvailabilityResponseSchema,
	reuseViewAvailabilityMaxPaths
} from '@cupboard/protocol/cache-availability';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { basicAuthHeader } from '@cupboard/shared/http';
import { retryingFetcher } from '@cupboard/shared/retry';
import { z } from 'zod';

import { fetchWithProbeDeadline } from './cache-probe.ts';
import {
	CacheAvailabilityQueryError,
	CacheAvailabilityResponseMalformedError,
	CacheAvailabilityResponseSchemaError,
	CacheAvailabilityResponseUnexpectedHashError,
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
import { cacheUrlFor, reuseViewUrlFor } from './substituters.ts';

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

// A root suffix names its target's root under the run's prefix, and
// equivalent spellings must name one root: the canonical form drops the
// leading and trailing slashes that a join would otherwise absorb or
// duplicate. The server accepts any slashes inside a root name, so interior
// ones are meaningful and stay.
export function canonicalRootSuffix(suffix: string): string {
	return suffix.replace(/^\/+/u, '').replace(/\/+$/u, '');
}

/**
 * The one construction of a target's full root name: the prefix, its own
 * trailing slashes dropped, joined to the canonical root suffix. Every
 * consumer of a target root goes through this, so the root a run ensures for
 * a cached target and the root its build job publishes under can never be
 * spelt two different ways.
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
	outputs: z
		.array(
			z.string().min(1).refine(isNixPositionalArgument, {
				message:
					'output must not start with a hyphen or contain control characters'
			})
		)
		.min(1)
		.default(['out'])
		.transform((outputs) => [...new Set(outputs)])
});

// Retention treats every target sharing a root as retained once one of them
// is ensured (see planPublish's retainedRoots.has lookup), so two targets
// whose suffixes name the same root would race each other's root, or leave a
// missing one unbuilt while its cached sibling stands in for it. Equivalent
// spellings (`app`, `/app`, `app/`) join to one root, so uniqueness runs on
// the canonical form and the parsed plan carries only canonical suffixes.
// Reject the manifest outright rather than let either happen at runtime.
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

export interface SeedCandidate {
	readonly drvPath: string;
	readonly output: string;
	readonly path: StorePathString;
}

export interface SeedGroup {
	readonly key: string;
	readonly system: string;
	readonly os: string;
	readonly remote: boolean;
	readonly targets: readonly string[];
	readonly candidates: readonly SeedCandidate[];
}

export interface FallbackGroup {
	readonly key: string;
	readonly system: string;
	readonly os: string;
	readonly remote: boolean;
	readonly targets: readonly PublishTarget[];
}

export interface PublishPlan {
	readonly retained: readonly PublishTarget[];
	readonly targets: readonly PublishTarget[];
	readonly seedGroups: readonly SeedGroup[];
	readonly fallbackGroups: readonly FallbackGroup[];
	// Shared outputs that qualified for seeding but are already served by the
	// destination, so their seeds are omitted. Grace mode confirms these before
	// relying on them, refreshing each one's retention deadline.
	readonly destinationIntermediates: readonly StorePathString[];
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

interface DerivationUse {
	readonly identity: string;
	readonly drvPath: string;
	readonly output: string;
	readonly path?: StorePathString;
	readonly targets: Set<TargetEvaluation>;
}

export function planPublish(options: {
	readonly evaluations: readonly TargetEvaluation[];
	readonly retainedRoots: ReadonlySet<string>;
	readonly availablePaths: ReadonlySet<StorePathString>;
	// Paths substitutable through the configured reuse view; empty when no
	// view is configured. A separate fact from destination availability: it
	// changes where a shared output can be substituted from, never whether a
	// target builds or what the destination retains.
	readonly viewAvailablePaths?: ReadonlySet<StorePathString>;
	readonly uses: ReadonlyMap<string, DerivationUse>;
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

	const pendingIndices = new Map(
		pending.map((evaluation, index) => [evaluation, index] as const)
	);
	const fallbackIndices = fallbackTargetComponents(
		options.uses,
		pending,
		pendingIndices
	);
	const fallbackTargets = new Set(fallbackIndices.flat());
	const targets = [
		...pending.map((evaluation) => evaluation.target),
		...(options.unevaluated ?? [])
	];
	const { seedGroups, destinationIntermediates } = seedGroupsFor(
		options.uses,
		pending,
		pendingIndices,
		fallbackTargets,
		options.availablePaths,
		options.viewAvailablePaths ?? new Set()
	);
	const fallbackGroups = fallbackIndices.map((indices, groupIndex) => {
		const evaluations = indices.map((index) => requireIndex(pending, index));
		const first = requireIndex(evaluations, 0);

		return {
			key: `fallback-${first.target.system}-${String(groupIndex + 1)}`,
			system: first.target.system,
			os: first.target.os,
			remote: first.target.remote,
			targets: evaluations.map((evaluation) => evaluation.target)
		};
	});

	assertDistinctGroupKeys([...seedGroups, ...fallbackGroups]);

	return {
		retained,
		targets,
		seedGroups,
		fallbackGroups,
		destinationIntermediates
	};
}

export function derivationUses(
	evaluations: readonly TargetEvaluation[]
): Map<string, DerivationUse> {
	const uses = new Map<string, DerivationUse>();

	for (const evaluation of evaluations) {
		recordRootUses(uses, evaluation);
		recordConsumedInputUses(uses, evaluation);
	}

	return uses;
}

// An evaluation's own target outputs are consumed by definition: they are
// exactly the outputs that become its targetPaths.
function recordRootUses(
	uses: Map<string, DerivationUse>,
	evaluation: TargetEvaluation
): void {
	const root = evaluation.nodes.get(evaluation.rootDrvPath);

	if (root === undefined) {
		return;
	}

	const selected = new Set(evaluation.target.outputs);

	for (const output of root.outputs) {
		if (selected.has(output.name)) {
			recordDerivationUse(uses, root, output, evaluation);
		}
	}
}

// A node's declared inputs name the specific outputs of its dependencies it
// actually references; an output no dependent names (a `dev` output beside a
// consumed `out`, say) is not a use, even though the derivation graph still
// contains it.
function recordConsumedInputUses(
	uses: Map<string, DerivationUse>,
	evaluation: TargetEvaluation
): void {
	for (const node of evaluation.nodes.values()) {
		recordConsumedInputsFor(uses, node, evaluation);
	}
}

function recordConsumedInputsFor(
	uses: Map<string, DerivationUse>,
	node: DerivationNode,
	evaluation: TargetEvaluation
): void {
	for (const [inputDrvPath, outputNames] of node.inputs) {
		const inputNode = evaluation.nodes.get(inputDrvPath);

		if (inputNode === undefined) {
			continue;
		}

		for (const outputName of outputNames) {
			const output = inputNode.outputs.find(
				(candidate) => candidate.name === outputName
			);

			if (output !== undefined) {
				recordDerivationUse(uses, inputNode, output, evaluation);
			}
		}
	}
}

export function cacheProbePaths(
	evaluations: readonly TargetEvaluation[],
	uses: ReadonlyMap<string, DerivationUse>
): StorePathString[] {
	const paths = new Set<StorePathString>(
		evaluations.flatMap((evaluation) => evaluation.targetPaths)
	);

	for (const use of uses.values()) {
		if (use.targets.size >= 2 && use.path !== undefined) {
			paths.add(use.path);
		}
	}

	return paths.values().toArray();
}

// The planner only ever consumes view availability for shared outputs whose
// users are still pending once retention settles, but retention is not known
// until the roots are ensured, after this probe. The probe therefore carries
// every shared output with at least two manifest users, the smallest superset
// the planner can consume; probing target paths against the view would load
// the gated lookup for answers nothing reads.
export function viewProbePaths(
	uses: ReadonlyMap<string, DerivationUse>
): StorePathString[] {
	const paths = new Set<StorePathString>();

	for (const use of uses.values()) {
		if (use.targets.size >= 2 && use.path !== undefined) {
			paths.add(use.path);
		}
	}

	return paths.values().toArray();
}

function recordDerivationUse(
	uses: Map<string, DerivationUse>,
	node: DerivationNode,
	output: DerivationOutput,
	evaluation: TargetEvaluation
): void {
	const identity = `${node.drvPath}^${output.name}`;
	const existing = uses.get(identity);

	if (existing !== undefined) {
		existing.targets.add(evaluation);
		return;
	}

	uses.set(identity, {
		identity,
		drvPath: node.drvPath,
		output: output.name,
		...(output.path !== undefined && { path: output.path }),
		targets: new Set([evaluation])
	});
}

// Projects a use's targets onto the `pending` array's indices, dropping any
// target that isn't pending (a retained target using the same derivation, for
// instance). Callers that reason about pending targets only must count and
// group over this projection rather than the use's raw target set.
function pendingUsers(
	use: DerivationUse,
	pendingIndices: ReadonlyMap<TargetEvaluation, number>
): number[] {
	return use.targets
		.values()
		.map((evaluation) => pendingIndices.get(evaluation))
		.filter((index): index is number => index !== undefined)
		.toArray();
}

function fallbackTargetComponents(
	uses: ReadonlyMap<string, DerivationUse>,
	pending: readonly TargetEvaluation[],
	pendingIndices: ReadonlyMap<TargetEvaluation, number>
): number[][] {
	const parents = pending.map((_, index) => index);
	const find = (index: number): number => {
		const parent = requireIndex(parents, index);

		if (parent === index) {
			return index;
		}

		const root = find(parent);
		parents[index] = root;

		return root;
	};
	const union = (left: number, right: number): void => {
		const leftRoot = find(left);
		const rightRoot = find(right);

		if (leftRoot !== rightRoot) {
			parents[rightRoot] = leftRoot;
		}
	};
	const fallback = new Set<number>();

	for (const use of uses.values()) {
		if (use.path !== undefined) {
			continue;
		}

		const indices = pendingUsers(use, pendingIndices);

		if (indices.length < 2) {
			continue;
		}

		const contextGroups = Map.groupBy(indices, (index) =>
			executionContextKey(requireIndex(pending, index).target)
		);

		for (const groupIndices of contextGroups.values()) {
			connectFallbackTargets(groupIndices, fallback, union);
		}
	}

	const groups = new Map<number, number[]>();

	for (const index of fallback) {
		const root = find(index);
		const group = groups.get(root) ?? [];
		group.push(index);
		groups.set(root, group);
	}

	return groups
		.values()
		.map((group) => group.toSorted((left, right) => left - right))
		.toArray()
		.toSorted((left, right) => requireIndex(left, 0) - requireIndex(right, 0));
}

function connectFallbackTargets(
	indices: readonly number[],
	fallback: Set<number>,
	union: (left: number, right: number) => void
): void {
	if (indices.length < 2) {
		return;
	}

	const first = requireIndex(indices, 0);
	fallback.add(first);

	for (const index of indices.slice(1)) {
		fallback.add(index);
		union(first, index);
	}
}

function seedGroupsFor(
	uses: ReadonlyMap<string, DerivationUse>,
	pending: readonly TargetEvaluation[],
	pendingIndices: ReadonlyMap<TargetEvaluation, number>,
	fallbackTargets: ReadonlySet<number>,
	availablePaths: ReadonlySet<StorePathString>,
	viewAvailablePaths: ReadonlySet<StorePathString>
): {
	readonly seedGroups: SeedGroup[];
	readonly destinationIntermediates: readonly StorePathString[];
} {
	const buildGroups = new Map<
		string,
		{ evaluations: Set<number>; candidates: SeedCandidate[] }
	>();
	const adoptionGroups = new Map<
		string,
		{ evaluations: Set<number>; candidates: SeedCandidate[] }
	>();
	const destinationIntermediates = new Set<StorePathString>();

	for (const use of uses.values()) {
		if (use.path === undefined) {
			continue;
		}

		const indices = pendingUsers(use, pendingIndices);

		if (indices.length < 2) {
			continue;
		}

		const targetIndices = new Set(indices)
			.difference(fallbackTargets)
			.values()
			.toArray();

		if (targetIndices.length < 2) {
			continue;
		}

		// The qualification above is checked first, so this set holds exactly
		// the outputs whose seeds the availability omitted, and nothing that
		// would never have been seeded anyway.
		if (availablePaths.has(use.path)) {
			destinationIntermediates.add(use.path);
			continue;
		}

		// A view-only output stays in the seed matrix under its own adoption
		// group: the seed job's nix build substitutes it from the configured
		// view and the publish adopts it into the destination. It never joins
		// the confirm set above, since view availability says nothing about
		// what the destination retains.
		const groups = viewAvailablePaths.has(use.path)
			? adoptionGroups
			: buildGroups;
		const contextGroups = Map.groupBy(targetIndices, (index) =>
			executionContextKey(requireIndex(pending, index).target)
		);

		for (const [key, groupIndices] of contextGroups) {
			addSeedCandidate(groups, key, groupIndices, use, use.path);
		}
	}

	const seedGroups = [
		...renderSeedGroups(buildGroups, 'seed', pending),
		...renderSeedGroups(adoptionGroups, 'adopt', pending)
	].toSorted((left, right) => left.key.localeCompare(right.key));

	return {
		seedGroups,
		destinationIntermediates: [...destinationIntermediates].toSorted(
			(left, right) => left.localeCompare(right)
		)
	};
}

function renderSeedGroups(
	groups: ReadonlyMap<
		string,
		{ evaluations: Set<number>; candidates: SeedCandidate[] }
	>,
	prefix: 'seed' | 'adopt',
	pending: readonly TargetEvaluation[]
): SeedGroup[] {
	return groups
		.values()
		.map((group): SeedGroup => {
			const evaluationIndices = [...group.evaluations].toSorted(
				(left, right) => left - right
			);
			const first = requireIndex(pending, requireIndex(evaluationIndices, 0));

			return {
				key: groupKey(prefix, first.target),
				system: first.target.system,
				os: first.target.os,
				remote: first.target.remote,
				targets: evaluationIndices.map(
					(index) => requireIndex(pending, index).target.attr
				),
				candidates: group.candidates.toSorted((left, right) =>
					`${left.drvPath}^${left.output}`.localeCompare(
						`${right.drvPath}^${right.output}`
					)
				)
			};
		})
		.toArray();
}

function addSeedCandidate(
	groups: Map<
		string,
		{ evaluations: Set<number>; candidates: SeedCandidate[] }
	>,
	key: string,
	indices: readonly number[],
	use: DerivationUse,
	path: StorePathString
): void {
	if (indices.length < 2) {
		return;
	}

	const group = groups.get(key) ?? {
		evaluations: new Set<number>(),
		candidates: []
	};

	for (const index of indices) {
		group.evaluations.add(index);
	}

	group.candidates.push({
		drvPath: use.drvPath,
		output: use.output,
		path
	});
	groups.set(key, group);
}

export async function evaluateTargets(
	targets: readonly PublishTarget[],
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

	const evaluated = await evaluateResolvedTargets(resolved, evaluator);

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
	evaluator: NixEvaluator
): Promise<(TargetEvaluation | UnevaluatedTarget)[]> {
	if (resolutions.length === 1) {
		return [
			await evaluateResolvedTarget(requireIndex(resolutions, 0), evaluator)
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
		const nodes = derivationNodes(label, value);

		return resolutions.map(({ target, rootDrvPath }) =>
			evaluationForRoot(target, nodes, rootDrvPath)
		);
	} catch {
		const evaluated: (TargetEvaluation | UnevaluatedTarget)[] = [];

		for (const resolution of resolutions) {
			evaluated.push(await evaluateResolvedTarget(resolution, evaluator));
		}

		return evaluated;
	}
}

async function evaluateResolvedTarget(
	resolution: ResolvedTargetRoot,
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
		const nodes = derivationNodes(target.attr, value);

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
	value: unknown
): TargetEvaluation {
	const nodes = derivationNodes(target.attr, value);
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

const derivationNodeSchema = derivationNodeBaseSchema.transform((node) => ({
	inputs: nodeInputs(node),
	outputs: nodeOutputs(node)
}));

// `nix derivation show` prints a bare map of drvPath to node; the Determinate
// evaluator wraps the same map under `derivations`. Unwrapping to the inner map
// leaves one document shape to parse.
const derivationWrapperSchema = z.looseObject({
	derivations: z.record(z.string(), z.unknown())
});

const derivationDocumentSchema = z.preprocess(
	(value) => {
		const wrapper = derivationWrapperSchema.safeParse(value);

		return wrapper.success ? wrapper.data.derivations : value;
	},
	z.record(z.string(), derivationNodeSchema)
);

function derivationNodes(
	attribute: string,
	value: unknown
): Map<string, DerivationNode> {
	const parsed = derivationDocumentSchema.safeParse(value);

	if (!parsed.success) {
		throw new DerivationGraphShapeError(attribute, { cause: parsed.error });
	}

	const nodes = new Map<string, DerivationNode>();

	for (const [rawDrvPath, body] of Object.entries(parsed.data)) {
		const drvPath = absoluteStorePath(rawDrvPath);
		nodes.set(drvPath, { drvPath, ...body });
	}

	return nodes;
}

function nodeInputs(
	node: ParsedDerivationNode
): Map<string, readonly string[]> {
	const drvs = node.inputs?.drvs ?? node.inputDrvs ?? {};
	const inputs = new Map<string, readonly string[]>();

	for (const [inputPath, input] of Object.entries(drvs)) {
		inputs.set(
			absoluteStorePath(inputPath),
			Array.isArray(input) ? input : input.outputs
		);
	}

	return inputs;
}

function nodeOutputs(node: ParsedDerivationNode): DerivationOutput[] {
	return Object.entries(node.outputs).map(([name, output]) => {
		const candidate = output.path ?? node.env[name];

		if (candidate === undefined) {
			return { name };
		}

		const path = storePathSchema.safeParse(absoluteStorePath(candidate));

		return path.success ? { name, path: path.data } : { name };
	});
}

function absoluteStorePath(storePath: string): string {
	return storePath.startsWith('/nix/store/')
		? storePath
		: `/nix/store/${storePath}`;
}

interface ProbeOptions {
	readonly paths: readonly StorePathString[];
	readonly credentials?: { readonly user: string; readonly password: string };
	readonly fetcher?: typeof fetch;
}

export function availableCachePaths(
	options: ProbeOptions & {
		readonly baseUrl: string;
		readonly cache: StoredCache;
	}
): Promise<Set<StorePathString>> {
	return availablePathsAt(
		cacheUrlFor(options.baseUrl, options.cache),
		options,
		cacheAvailabilityMaxPaths
	);
}

/**
 * The subset of `paths` substitutable through a reuse view. View
 * substitutability is a separate fact from destination availability: it says
 * only that a build job can substitute the path, never that the destination
 * holds or retains it.
 */
export function availableViewPaths(
	options: ProbeOptions & {
		readonly baseUrl: string;
		readonly view: string;
	}
): Promise<Set<StorePathString>> {
	return availablePathsAt(
		reuseViewUrlFor(options.baseUrl, options.view),
		options,
		reuseViewAvailabilityMaxPaths
	);
}

async function availablePathsAt(
	probeUrl: string,
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
	probeUrl: string,
	storePathHashes: readonly StorePathHash[],
	headers: Readonly<Record<string, string>>
): Promise<StorePathHash[]> {
	const target = `${probeUrl}/api/v1/missing-paths`;

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

// Targets whose jobs run in the same place share seeding and fallback
// groups; the label is compared canonically, so case-variant spellings of
// one runner label do not split a shared output into separate builds.
/**
 * Fails the plan when two groups would emit one key: the workflow selects
 * groups solely by key, and root mode derives each group's temporary
 * retention root from it, so a shared key would make colliding jobs consume
 * both groups and race on one root.
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

// A group's key names its matrix entry and, in root mode, its temporary
// seed root. The readable parts are joined with hyphens, which the
// components may themselves contain, so a 64-bit hash of the unambiguous
// tuple disambiguates: ('a-b', 'c') and ('a', 'b-c') read alike but never
// collide. The digest is not injective, so {@link assertDistinctGroupKeys}
// backstops it: any residual collision fails the plan loudly instead of
// merging two groups onto one key and one retention root. The canonical
// label keeps the key equal across case-variant spellings of one runner
// label, exactly as the grouping is.
// GitHub matches runner labels case-insensitively, so grouping and keying
// compare this canonical form, never the raw spelling.
function canonicalRunnerLabel(label: string): string {
	return label.toLowerCase();
}

function groupKey(prefix: 'seed' | 'adopt', target: PublishTarget): string {
	const os = canonicalRunnerLabel(target.os);
	const mode = target.remote ? 'remote' : 'local';
	const digest = createHash('sha256')
		.update(JSON.stringify([target.system, os, target.remote]))
		.digest('hex')
		.slice(0, 16);

	return `${prefix}-${target.system}-${os}-${mode}-${digest}`;
}

function executionContextKey(target: PublishTarget): string {
	return JSON.stringify([
		target.system,
		canonicalRunnerLabel(target.os),
		target.remote
	]);
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
