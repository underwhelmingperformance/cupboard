import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
import { type StorePathString } from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	pushSummaryResultKind,
	pushSummarySchema
} from '@cupboard/protocol/reports';
import { parseReporterResults } from '@cupboard/reporter';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { formatErrorWithCauses } from '@cupboard/shared/errors';
import { type ReadUser } from '@cupboard/shared/http';

import { type EnsureRunner, type PlanInputs } from './commands/plan.ts';
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

export interface ReferencePlanInputs extends PlanInputs {
	readonly referenceSource: string;
	readonly fallbackReadUser: ReadUser | '';
	readonly fallbackReadPassword: string;
}

export interface PlanReferenceOutcome {
	readonly attr: string;
	readonly root: string;
	readonly source: string;
	readonly paths: readonly StorePathString[];
	readonly status: 'published' | 'unavailable' | 'failed';
	readonly reason?: string;
}

export interface ReferencePlanDependencies {
	readonly runner: EnsureRunner;
	readonly fetcher?: typeof fetch;
	readonly signal?: AbortSignal;
}

export async function publishReferenceTargets(
	inputs: ReferencePlanInputs,
	evaluations: readonly TargetEvaluation[],
	dependencies: ReferencePlanDependencies
): Promise<readonly PlanReferenceOutcome[]> {
	dependencies.signal?.throwIfAborted();
	if (
		inputs.referenceSource === '' ||
		inputs.build !== 'missing' ||
		inputs.publish !== 'outputs'
	) {
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
		const source = parseTenantCacheUrl(new URL(inputs.referenceSource));
		available = await availableCachePaths({
			baseUrl: source.tenantUrl,
			cache: source.cache,
			paths: eligible.flatMap((group) =>
				group.flatMap((evaluation) => evaluation.targetPaths)
			),
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
		dependencies.signal?.throwIfAborted();
		if (
			!(error instanceof CacheAvailabilityQueryError) ||
			error.status !== 404
		) {
			return eligible.flatMap((group) =>
				outcomes(inputs, group, 'failed', error)
			);
		}
		available = new Set();
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
			...(inputs.fallbackReadUser === ''
				? []
				: [
						'--read-user',
						inputs.fallbackReadUser,
						'--read-password',
						inputs.fallbackReadPassword
					])
		],
		dependencies.signal
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
