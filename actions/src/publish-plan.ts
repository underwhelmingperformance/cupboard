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
	cacheAvailabilityResponseSchema,
	reuseViewAvailabilityMaxPaths
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

// A cohort label composes into a cohort's key (see cohortKey), which is
// destined for the same role a matrix job's key plays today, so it is bounded
// like any other job-identifying string rather than left to grow without
// limit.
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
 * One member of a component-publication target: its own attr and, once
 * evaluated, its own derivation path. Everything else a component needs
 * (execution context, retention root, best-effort and cohort membership) it
 * takes from the aggregate target that declares it; see {@link expandComponents}.
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

/**
 * Expands every component-publication target into one synthetic target per
 * component, each carrying the aggregate's execution context (system, os,
 * remote), best-effort flag and cohort label, and its own rootSuffix, so
 * every component publishes under the one retention root the aggregate
 * declares (the component-root shape: the root's target list is the
 * component list, capped by the caller against `rootSetMaxTargets`). A
 * target with no components passes through unchanged. The aggregate's own
 * attr and rootDrvPath never appear in the result: an aggregate is never
 * evaluated, queried for realisation, or built here, only substituted by the
 * machine that activates it from the components this expansion publishes in
 * its place.
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
	readonly seedGroups: readonly SeedGroup[];
	readonly fallbackGroups: readonly FallbackGroup[];
	// Shared outputs that qualified for seeding but are already served by the
	// destination, so their seeds are omitted. Grace mode confirms these before
	// relying on them, refreshing each one's retention deadline.
	readonly destinationIntermediates: readonly StorePathString[];
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
		seedGroups,
		fallbackGroups,
		destinationIntermediates,
		cohorts: cohortsFor(allTargets),
		derivationToTargets: derivationToTargetsFor(options.evaluations)
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

/**
 * The subset of `paths` substitutable through a reuse view. View
 * substitutability is a separate fact from destination availability: it says
 * only that a build job can substitute the path, never that the destination
 * holds or retains it.
 */
export function availableViewPaths(
	options: ProbeOptions & {
		readonly baseUrl: URL;
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

/**
 * Partitions targets into cohorts: the manifest's own statement of which
 * targets run together in one job. A target's cohort is its explicit
 * `cohort` label when it has one, and its own identity (`attr`) otherwise, so
 * per-target cohorts are the default and a shared label is the only way two
 * targets join one cohort; nothing here groups or splits a manifest on its
 * own initiative. Partitions the whole manifest, not only what still needs
 * building, because cohort identity is a property of the manifest, not of
 * what the destination happens to hold this run.
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

// Follows groupKey's shape: the readable context parts, hyphen-joined, plus a
// digest disambiguating look-alike contexts. The label joins the digest
// rather than the readable prefix, because per-target cohorts are the
// default and every target in one execution context needs a key distinct
// from its siblings there; assertDistinctGroupKeys backstops any residual
// collision the digest cannot rule out.
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
 * Inverts each evaluated target's recursive graph into a map from a
 * derivation to the target identities (attrs) whose graph contains it. Built
 * once from evaluation, ahead of any build, so a streamed build's post-build
 * hook can resolve a `DRV_PATH` to its owning target without asking Nix
 * again; the recursive graph already holds evidence about the dependency
 * graph, not an instruction to build every node it names.
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
 * Whether the advisory pre-filter found one target already covered: either
 * its root's last reconciled list carries every one of its current outputs,
 * or an absent one is recorded in the previous run's receipt as left
 * upstream (the store path matches, so the content is unchanged). A target
 * whose output paths are not all known before building never reaches
 * `covered`, and a failed read or ensure call never reaches `not-covered`
 * silently: both carry their own status so a cohort decision can tell "does
 * not need building" from "could not tell".
 */
export interface TargetCoverage {
	readonly attr: string;
	readonly status: TargetCoverageStatus;
	readonly reason?: string;
}

/**
 * Decides one known-output target's coverage from facts already gathered:
 * whether its root's reconciled list, freshly re-ensured, is still valid,
 * and whether that list plus the previous receipt's left-upstream paths
 * between them name every one of its current outputs. Callers assemble
 * `unknown-output` and `failed` directly, since both are facts about
 * reaching the check at all, not about what it found.
 */
export function evaluateTargetCoverage(
	target: PublishTarget,
	targetPaths: readonly StorePathString[],
	check: {
		readonly retained: boolean;
		readonly reconciledPaths: ReadonlySet<StorePathString>;
	},
	leftUpstreamPaths: ReadonlySet<StorePathString>
): TargetCoverage {
	if (!check.retained) {
		return { attr: target.attr, status: 'not-covered' };
	}

	const isCovered = targetPaths.every(
		(path) => check.reconciledPaths.has(path) || leftUpstreamPaths.has(path)
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
