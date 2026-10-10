import type { ReporterResultEvent } from '@cupboard/reporter';
import { expect, it } from 'vitest';

import {
	attributedUploads,
	cohortFailureResult,
	uploadTally
} from './cohort-summary.ts';

function buildSummary(paths: number, bytes: number): ReporterResultEvent {
	return {
		kind: 'build-summary',
		data: {
			mode: 'streamed',
			store: '/nix/store',
			targetPaths: 1,
			intermediatePaths: 0,
			queueDepth: 1,
			uploadedPaths: paths,
			uploadedBytes: bytes,
			skipped: 0,
			childExitStatus: 0,
			unconfirmedPaths: []
		}
	};
}

it('totals every supervised build without counting its nested publication twice', () => {
	expect(
		uploadTally([
			{
				kind: 'push-summary',
				data: {
					uploadedPaths: 1,
					reusedBlobs: 0,
					uploadedBytes: 10,
					skipped: 0,
					failures: [],
					paths: []
				}
			},
			buildSummary(1, 10),
			buildSummary(2, 30)
		])
	).toStrictEqual({ paths: 3, bytes: 40 });
});

it('attributes exclusive closure uploads and keeps shared uploads in the cohort total', () => {
	const owners = new Map([
		['app', new Set(['app-root'])],
		['lib', new Set(['lib-root'])]
	]);
	expect(
		attributedUploads(
			{
				paths: 3,
				bytes: 60,
				uploads: [
					{ storePath: 'app', uploadedBytes: 10 },
					{ storePath: 'lib', uploadedBytes: 20 },
					{ storePath: 'shared', uploadedBytes: 30 }
				],
				pathReferences: [
					{ storePath: 'app', references: ['shared'] },
					{ storePath: 'lib', references: ['shared'] },
					{ storePath: 'shared', references: [] }
				]
			},
			owners
		)
	).toStrictEqual(
		new Map([
			['app-root', { paths: 1, bytes: 10 }],
			['lib-root', { paths: 1, bytes: 20 }]
		])
	);
});

it('reports a stopped publication with its cohort and completed uploads', () => {
	expect(
		cohortFailureResult({
			durationMs: 1000,
			cause: 'build failed',
			targets: [{ attr: '.#app', root: 'app-root' }],
			uploads: { paths: 2, bytes: 40 }
		})
	).toStrictEqual({
		kind: 'cohort-failure',
		title: 'Publication stopped',
		data: {
			durationMs: 1000,
			cause: 'build failed',
			targets: [{ attr: '.#app', root: 'app-root' }],
			uploads: { paths: 2, bytes: 40 }
		},
		rows: [
			{ label: 'Duration', value: '1.0s' },
			{ label: 'Targets', value: '.#app (root app-root)' },
			{ label: 'Uploaded before the failure', value: '2 paths, 40 B' },
			{ label: 'Cause', value: 'build failed' }
		],
		jobSummary: true
	});
});

it('does not claim exclusive dependency uploads when another root has an incomplete graph', () => {
	const owners = new Map([
		['app', new Set(['app-root'])],
		['cached', new Set(['cached-root'])]
	]);
	const uploads = {
		paths: 1,
		bytes: 100,
		uploads: [{ storePath: 'dependency', uploadedBytes: 100 }],
		pathReferences: [
			{ storePath: 'app', references: ['dependency'] },
			{ storePath: 'dependency', references: [] }
		]
	};
	expect(attributedUploads(uploads, owners)).toStrictEqual(new Map());
});

it('does not attribute an unowned upload from incomplete possible ownership', () => {
	const owners = new Map([['app', new Set(['app-root'])]]);
	const uploads = {
		paths: 1,
		bytes: 100,
		uploads: [{ storePath: 'unrelated', uploadedBytes: 100 }],
		pathReferences: [{ storePath: 'app', references: ['missing'] }]
	};
	expect(attributedUploads(uploads, owners)).toStrictEqual(new Map());
});
