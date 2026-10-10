import {
	buildSummaryResultKind,
	buildSummarySchema,
	pushSummaryResultKind,
	pushSummarySchema
} from '@cupboard/protocol/reports';
import type { RootSummary } from '@cupboard/protocol/retention';
import {
	formatBytes,
	formatCount,
	formatDuration,
	type ReporterResultEvent,
	type ResultPayload,
	ResultTable
} from '@cupboard/reporter';

import type { RootRetention } from './root-retention.ts';

const legacyPushSummarySchema = pushSummarySchema.omit({ paths: true });

/**
 * Upload totals from one or more cupboard runs. Older build summaries omit
 * the byte count.
 */
export interface UploadTally {
	readonly paths: number;
	readonly bytes?: number;
	readonly pathReferences?: readonly {
		readonly storePath: string;
		readonly references: readonly string[];
	}[];
	readonly uploads?: readonly {
		readonly storePath: string;
		readonly uploadedBytes: number;
	}[];
}

/**
 * Reads the upload counts from the results of one `cupboard push` or
 * `cupboard build-push` run. Returns `undefined` when the run recorded no
 * summary that matches the protocol.
 */
export function uploadTally(
	results: readonly ReporterResultEvent[]
): UploadTally | undefined {
	const builds = results.filter(
		(event) => event.kind === buildSummaryResultKind
	);
	const relevant = builds.length === 0 ? results : builds;
	let total: UploadTally | undefined;
	for (const event of relevant) {
		total = addUploads(total, eventUploads(event));
	}
	return total;
}

function eventUploads(event: ReporterResultEvent): UploadTally | undefined {
	if (event.kind === buildSummaryResultKind) {
		const summary = buildSummarySchema.safeParse(event.data).data;

		return summary === undefined
			? undefined
			: {
					paths: summary.uploadedPaths,
					...(summary.uploadedBytes !== undefined && {
						bytes: summary.uploadedBytes
					}),
					...(summary.uploads !== undefined && { uploads: summary.uploads }),
					...(summary.pathReferences !== undefined && {
						pathReferences: summary.pathReferences
					})
				};
	}

	if (event.kind !== pushSummaryResultKind) {
		return undefined;
	}

	const summary =
		pushSummarySchema.safeParse(event.data).data ??
		legacyPushSummarySchema.safeParse(event.data).data;

	return summary === undefined
		? undefined
		: { paths: summary.uploadedPaths, bytes: summary.uploadedBytes };
}

/**
 * Attributes an upload to a root only when its recorded closure has one owner.
 * Shared uploads remain in the cohort total.
 */
export function attributedUploads(
	uploads: UploadTally | undefined,
	owners: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlyMap<string, UploadTally> {
	if (uploads?.uploads === undefined || uploads.pathReferences === undefined) {
		return new Map();
	}
	const references = new Map(
		uploads.pathReferences.map((info) => [info.storePath, info.references])
	);
	const rootsByPath = new Map<string, Set<string>>();
	const incompleteRoots = new Set<string>();
	for (const [target, roots] of owners) {
		for (const root of roots) {
			const visited = new Set<string>();
			const pending = [target];
			while (pending.length > 0) {
				const current = pending.pop();
				if (current === undefined || visited.has(current)) {
					continue;
				}
				visited.add(current);
				const pathRoots = rootsByPath.get(current) ?? new Set<string>();
				pathRoots.add(root);
				rootsByPath.set(current, pathRoots);
				const next = references.get(current);
				if (next === undefined) {
					incompleteRoots.add(root);
					continue;
				}
				pending.push(...next);
			}
		}
	}
	const totals = new Map<string, UploadTally>();
	for (const upload of uploads.uploads) {
		const knownRoots = rootsByPath.get(upload.storePath);
		if (knownRoots === undefined) {
			continue;
		}
		const roots = knownRoots.union(incompleteRoots);
		if (roots.size !== 1) {
			continue;
		}
		const root = roots.values().next().value;
		if (root === undefined) {
			continue;
		}
		const total = totals.get(root) ?? { paths: 0, bytes: 0 };
		totals.set(root, {
			paths: total.paths + 1,
			bytes: (total.bytes ?? 0) + upload.uploadedBytes
		});
	}
	return totals;
}

export function recordedRoots(
	results: readonly ReporterResultEvent[]
): readonly RootSummary[] {
	return results.flatMap((event) =>
		event.kind === pushSummaryResultKind
			? (pushSummarySchema.safeParse(event.data).data?.roots ?? [])
			: []
	);
}

export function addUploads(
	left: UploadTally | undefined,
	right: UploadTally | undefined
): UploadTally | undefined {
	if (left === undefined || right === undefined) {
		return left ?? right;
	}

	const paths = left.paths + right.paths;

	return {
		paths,
		...(left.pathReferences !== undefined &&
			right.pathReferences !== undefined && {
				pathReferences: [...left.pathReferences, ...right.pathReferences]
			}),
		...(left.bytes !== undefined &&
			right.bytes !== undefined && { bytes: left.bytes + right.bytes }),
		...(left.uploads !== undefined &&
			right.uploads !== undefined && {
				uploads: [...left.uploads, ...right.uploads]
			})
	};
}

/**
 * What the cohort job did with a target. A root can list more than one
 * outcome.
 */
export type TargetOutcome =
	| 'built'
	| 'already-served'
	| 'reused'
	| 'left-upstream'
	| 'failed'
	| 'not-built';

const outcomeText: Readonly<Record<TargetOutcome, string>> = {
	built: 'Built',
	'already-served': 'Already served',
	reused: 'Reused',
	'left-upstream': 'Left upstream',
	failed: 'Failed',
	'not-built': 'Not built'
};

export const outcomeOrder: readonly TargetOutcome[] = [
	'built',
	'already-served',
	'reused',
	'left-upstream',
	'failed',
	'not-built'
];

export interface CohortRootSummary {
	/**
	The attributes of the targets that publish under this root.
	*/
	readonly attrs: readonly string[];
	readonly root: string;
	readonly outcomes: readonly TargetOutcome[];
	/**
	The uploads of the pushes for this root. Absent when none ran.
	*/
	readonly uploads?: UploadTally;
	/**
	Absent when the job did not set this root.
	*/
	readonly retention?: RootRetention;
	readonly recordedRetention?: RootSummary;
}

export interface CohortSummary {
	readonly durationMs: number;
	/**
	The uploads that happened before the job set the roots.
	*/
	readonly buildUploads?: UploadTally;
	readonly roots: readonly CohortRootSummary[];
}

/**
 * The cohort job's summary: its duration, the uploads that happened while it
 * built, and one row for each root with the root's targets, outcome, uploads
 * and expiry.
 */
export function cohortSummaryResult(
	summary: CohortSummary
): ResultPayload<CohortSummary> {
	return {
		kind: 'cohort-summary',
		title: 'Targets',
		data: summary,
		rows: [
			{ label: 'Duration', value: formatDuration(summary.durationMs) },
			...(summary.buildUploads === undefined
				? []
				: [
						{
							label: 'Uploaded during the build',
							value: uploadText(summary.buildUploads)
						}
					])
		],
		table: ResultTable.of(
			[
				{ key: 'target', label: 'Target' },
				{ key: 'root', label: 'Root' },
				{ key: 'outcome', label: 'Outcome' },
				{ key: 'paths', label: 'Uploaded paths' },
				{ key: 'bytes', label: 'Uploaded bytes' },
				{ key: 'expiry', label: 'Root expiry' }
			],
			summary.roots.map((root) => ({
				target: root.attrs.join(', '),
				root: root.root,
				outcome: root.outcomes
					.map((outcome) => outcomeText[outcome])
					.join(', '),
				paths:
					root.uploads === undefined ? '-' : formatCount(root.uploads.paths),
				bytes:
					root.uploads?.bytes === undefined
						? '-'
						: formatBytes(root.uploads.bytes),
				expiry:
					root.recordedRetention === undefined
						? retentionText(root.retention)
						: (root.recordedRetention.expiresAt ?? 'Permanent')
			}))
		),
		note: [
			'Duration is for the shared cohort. Root rows include uploads with one established owner and subsequent root pushes. Shared uploads and paths with incomplete ownership remain in the cohort total.'
		],
		jobSummary: true
	};
}

interface CohortFailureSummary {
	readonly durationMs: number;
	readonly cause: string;
	readonly targets: readonly { readonly attr: string; readonly root: string }[];
	readonly uploads?: UploadTally;
}

/**
 * Records the completed transfers when publication stops before roots are set.
 */
export function cohortFailureResult(
	summary: CohortFailureSummary
): ResultPayload<CohortFailureSummary> {
	return {
		kind: 'cohort-failure',
		title: 'Publication stopped',
		data: summary,
		rows: [
			{ label: 'Duration', value: formatDuration(summary.durationMs) },
			{
				label: 'Targets',
				value: summary.targets
					.map(({ attr, root }) => `${attr} (root ${root})`)
					.join(', ')
			},
			...(summary.uploads === undefined
				? []
				: [
						{
							label: 'Uploaded before the failure',
							value: uploadText(summary.uploads)
						}
					]),
			{ label: 'Cause', value: summary.cause }
		],
		jobSummary: true
	};
}

function uploadText(uploads: UploadTally): string {
	const paths = `${formatCount(uploads.paths)} ${uploads.paths === 1 ? 'path' : 'paths'}`;

	return uploads.bytes === undefined
		? paths
		: `${paths}, ${formatBytes(uploads.bytes)}`;
}

function retentionText(retention: RootRetention | undefined): string {
	if (retention === undefined) {
		return 'Not set';
	}

	if (retention.kind === 'permanent') {
		return 'Permanent';
	}

	return retention.kind === 'ttl'
		? `${retention.ttl} after this run`
		: 'Cache retention setting';
}
