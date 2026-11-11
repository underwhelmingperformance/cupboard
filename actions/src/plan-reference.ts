import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
import { type StorePathString } from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import { type PlanReferenceOutcome } from '@cupboard/protocol/publish-plan';
import {
	pushSummaryResultKind,
	pushSummarySchema
} from '@cupboard/protocol/reports';
import { parseReporterResults } from '@cupboard/reporter';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { formatErrorWithCauses } from '@cupboard/shared/errors';
import { type ReadUser } from '@cupboard/shared/http';
import { StatusCodes } from 'http-status-codes';

import { type EnsureRunner, type PlanInputs } from './commands/plan.ts';
import { readCredentialInvocation } from './cupboard-run.ts';
import {
	CacheAvailabilityQueryError,
	PlanReferencePublicationIncompleteError
} from './errors.ts';
import {
	availableCachePaths,
	joinRoot,
	type TargetEvaluation
} from './publish-plan.ts';
import { cacheUrlFor } from './substituters.ts';

const notFoundStatus: number = StatusCodes.NOT_FOUND;

export interface ReferencePlanInputs extends PlanInputs {
	readonly referenceSource: string;
	readonly fallbackReadUser: ReadUser | '';
	readonly fallbackReadPassword: string;
}

export interface ReferencePlanDependencies {
	readonly runner: EnsureRunner;
	readonly fetcher?: typeof fetch;
	readonly signal?: AbortSignal;
}

/**
Whether the plan job publishes targets by reference from the reference
source. The publication runs `cupboard push` with the reference source's read
credential.
*/
export function isPublishingByReference(
	inputs: Pick<ReferencePlanInputs, 'referenceSource' | 'build' | 'publish'>
): boolean {
	return (
		inputs.referenceSource !== '' &&
		inputs.build === 'missing' &&
		inputs.publish === 'outputs'
	);
}

export async function publishReferenceTargets(
	inputs: ReferencePlanInputs,
	evaluations: readonly TargetEvaluation[],
	dependencies: ReferencePlanDependencies
): Promise<readonly PlanReferenceOutcome[]> {
	dependencies.signal?.throwIfAborted();
	if (!isPublishingByReference(inputs)) {
		return [];
	}

	const groups = Map.groupBy(
		evaluations,
		(evaluation) => evaluation.target.rootSuffix
	);
	const eligible = groups
		.values()
		.filter(
			(group) =>
				group.length ===
					inputs.targets.filter(
						(target) => target.rootSuffix === group[0]?.target.rootSuffix
					).length &&
				group.every(
					(evaluation) =>
						evaluation.target.outputs.length === 1 &&
						evaluation.targetPaths.length === 1
				)
		)
		.toArray();
	if (eligible.length === 0) {
		return [];
	}

	let available: ReadonlySet<StorePathString>;
	try {
		available = await referenceAvailablePaths(
			inputs,
			eligible.flatMap((group) =>
				group.flatMap((evaluation) => evaluation.targetPaths)
			),
			dependencies
		);
	} catch (error) {
		dependencies.signal?.throwIfAborted();
		return eligible.flatMap((group) =>
			outcomes(inputs, group, 'failed', error)
		);
	}

	const results = await mapWithConcurrency(eligible, 8, async (group) => {
		const paths = [
			...new Set(group.flatMap((evaluation) => evaluation.targetPaths))
		];
		if (paths.some((storePath) => !available.has(storePath))) {
			return outcomes(inputs, group, 'unavailable');
		}

		try {
			const first = group[0];
			if (first === undefined) {
				return [];
			}
			await publishRoot(
				inputs,
				joinRoot(inputs.rootPrefix, first.target.rootSuffix),
				paths,
				dependencies
			);
			return outcomes(inputs, group, 'published');
		} catch (error) {
			dependencies.signal?.throwIfAborted();
			return outcomes(inputs, group, 'failed', error);
		}
	});
	return results.flat();
}

/**
Whether the plan asks the reference source which target outputs it serves so
that cohort jobs can skip freeing disk space. The cohort job publishes those
targets by reference together with their dependency outputs, so the plan
publishes nothing itself. Without `maximise-space`, the answer cannot change
what a cohort job does, so the plan does not ask.
*/
function isCheckingReferenceForCohorts(
	inputs: Pick<
		ReferencePlanInputs,
		'referenceSource' | 'build' | 'publish' | 'maximiseSpace'
	>
): boolean {
	return (
		inputs.maximiseSpace &&
		inputs.referenceSource !== '' &&
		inputs.build === 'missing' &&
		inputs.publish === 'built'
	);
}

type ReferenceCohortCheck =
	| {
			readonly status: 'checked';
			readonly servedPaths: ReadonlySet<StorePathString>;
	  }
	| { readonly status: 'failed'; readonly reason: string };

/**
Asks the reference source about the outputs of targets that the destination
does not serve. A cohort job compares only the expected path of a target with
one output with the reference source, so the check covers only those targets.
It sends no request when no such target remains.
*/
export async function checkReferenceForCohorts(
	inputs: ReferencePlanInputs,
	evaluations: readonly TargetEvaluation[],
	destinationPaths: ReadonlySet<StorePathString>,
	dependencies: Omit<ReferencePlanDependencies, 'runner'>
): Promise<ReferenceCohortCheck> {
	if (!isCheckingReferenceForCohorts(inputs)) {
		return { status: 'checked', servedPaths: new Set() };
	}

	const paths = evaluations
		.filter(
			(evaluation) =>
				evaluation.target.outputs.length === 1 &&
				evaluation.targetPaths.length === 1
		)
		.flatMap((evaluation) => evaluation.targetPaths)
		.filter((storePath) => !destinationPaths.has(storePath));

	if (paths.length === 0) {
		return { status: 'checked', servedPaths: new Set() };
	}

	try {
		return {
			status: 'checked',
			servedPaths: await referenceAvailablePaths(inputs, paths, dependencies)
		};
	} catch (error) {
		dependencies.signal?.throwIfAborted();
		return { status: 'failed', reason: formatErrorWithCauses(error) };
	}
}

// A reference cache that does not exist yet serves nothing, so a 404 is an
// empty answer. Any other failure leaves availability unknown.
async function referenceAvailablePaths(
	inputs: ReferencePlanInputs,
	paths: readonly StorePathString[],
	dependencies: Omit<ReferencePlanDependencies, 'runner'>
): Promise<ReadonlySet<StorePathString>> {
	const source = parseTenantCacheUrl(new URL(inputs.referenceSource));

	try {
		return await availableCachePaths({
			baseUrl: source.tenantUrl,
			cache: source.cache,
			paths,
			...(inputs.fallbackReadUser !== '' && {
				credentials: {
					user: inputs.fallbackReadUser,
					password: inputs.fallbackReadPassword
				}
			}),
			...(dependencies.fetcher !== undefined && {
				fetcher: dependencies.fetcher
			})
		});
	} catch (error) {
		if (
			error instanceof CacheAvailabilityQueryError &&
			error.status === notFoundStatus
		) {
			return new Set();
		}
		throw error;
	}
}

function outcomes(
	inputs: ReferencePlanInputs,
	group: readonly TargetEvaluation[],
	status: PlanReferenceOutcome['status'],
	error?: unknown
): PlanReferenceOutcome[] {
	return group.map((evaluation) => ({
		attr: evaluation.target.attr,
		root: joinRoot(inputs.rootPrefix, evaluation.target.rootSuffix),
		source: inputs.referenceSource,
		paths: evaluation.targetPaths,
		status,
		...(error !== undefined && { reason: formatErrorWithCauses(error) })
	}));
}

async function publishRoot(
	inputs: ReferencePlanInputs,
	root: string,
	paths: readonly StorePathString[],
	dependencies: ReferencePlanDependencies
): Promise<void> {
	const stem = path.join(
		inputs.temporaryDirectory,
		`cupboard-plan-reference-${randomUUID()}`
	);
	const pathsFile = `${stem}.paths`;
	const resultFile = `${stem}.jsonl`;
	await writeFile(pathsFile, `${paths.join('\n')}\n`);
	const credential = readCredentialInvocation(
		inputs.fallbackReadUser,
		inputs.fallbackReadPassword,
		'reference-source'
	);
	await dependencies.runner(
		inputs.cupboardPath,
		[
			'--output-mode',
			'json',
			'--no-colour',
			'--result-file',
			resultFile,
			'push',
			canonicalHref(cacheUrlFor(inputs.url, inputs.cache)),
			'--reference-paths-file',
			pathsFile,
			'--reference-source',
			inputs.referenceSource,
			'--github-oidc',
			'--root',
			root,
			...(inputs.audience === '' ? [] : ['--audience', inputs.audience]),
			...(inputs.ttl === '' ? [] : ['--ttl', inputs.ttl]),
			...(inputs.permanent ? ['--permanent'] : []),
			...credential.arguments
		],
		dependencies.signal,
		credential.environment
	);
	const event = parseReporterResults(await readFile(resultFile, 'utf8')).find(
		(result) => result.kind === pushSummaryResultKind
	);
	const summary = pushSummarySchema.parse(event?.data);
	const committed = new Set(
		summary.paths
			.filter(
				(entry) =>
					entry.outcome === 'committed' || entry.outcome === 'already-present'
			)
			.map((entry) => entry.storePath)
	);
	if (
		summary.failures.length > 0 ||
		summary.uploadedPaths !== 0 ||
		paths.some((storePath) => !committed.has(storePath))
	) {
		throw new PlanReferencePublicationIncompleteError(root);
	}
}
