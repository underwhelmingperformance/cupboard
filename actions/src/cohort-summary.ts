import {
	buildSummaryResultKind,
	buildSummarySchema,
	pushSummaryResultKind,
	pushSummarySchema
} from '@cupboard/protocol/reports';
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
 * The number of paths and bytes uploaded by one or more cupboard runs. The
 * summary of `cupboard build-push` has no byte count, so `bytes` is absent
 * when a build-push run contributes to the tally.
 */
export interface UploadTally {
	readonly paths: number;
	readonly bytes?: number;
}

/**
 * Reads the upload counts from the results of one `cupboard push` or
 * `cupboard build-push` run. Returns `undefined` when the run recorded no
 * summary that matches the protocol.
 */
export function uploadTally(
	results: readonly ReporterResultEvent[]
): UploadTally | undefined {
	return results
		.values()
		.map((event) => eventUploads(event))
		.find((uploads) => uploads !== undefined);
}

function eventUploads(event: ReporterResultEvent): UploadTally | undefined {
	if (event.kind === buildSummaryResultKind) {
		const summary = buildSummarySchema.safeParse(event.data).data;

		return summary === undefined ? undefined : { paths: summary.uploadedPaths };
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

export function addUploads(
	left: UploadTally | undefined,
	right: UploadTally | undefined
): UploadTally | undefined {
	if (left === undefined || right === undefined) {
		return left ?? right;
	}

	const paths = left.paths + right.paths;

	return left.bytes === undefined || right.bytes === undefined
		? { paths }
		: { paths, bytes: left.bytes + right.bytes };
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
				expiry: retentionText(root.retention)
			}))
		),
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
