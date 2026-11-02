import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { storePathSchema } from '@cupboard/nix-store/scalars';
import { compactPublicationSetSchema } from '@cupboard/protocol/publication-manifests';
import {
	buildSummaryV4ResultKind,
	buildSummaryV4Schema
} from '@cupboard/protocol/reports';
import { afterEach, describe, expect, it } from 'vitest';

import { uploadTally } from './cohort-summary.ts';
import { mergeCohortReceipts } from './commands/build-cohort.ts';
import { mergePublishedBuildSubjects } from './commands/push.ts';
import {
	publicationReceiptSchema,
	receiptPublicationSets
} from './publication-receipt.ts';

const resultPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const set = compactPublicationSetSchema.parse({
	result: {
		storePath: resultPath,
		narHash: `sha256:${'0'.repeat(52)}`,
		generation: 1,
		cache: { kind: 'default' },
		cacheGeneration: 1
	},
	digest: 'a'.repeat(64),
	memberCount: 100,
	origin: 'build-selection',
	materialisation: 'complete'
});
const receipt = publicationReceiptSchema.parse({
	version: 4,
	paths: [resultPath],
	subjects: [],
	publicationSets: [set]
});
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

describe('publication receipt readers', () => {
	it('retains overlapping sets without adding members or signing subjects', () => {
		const second = { ...set, digest: 'b'.repeat(64) };
		const parsed = publicationReceiptSchema.parse({
			...receipt,
			publicationSets: [set, second]
		});
		expect(receiptPublicationSets([receipt, parsed])).toEqual([set, second]);
		expect(parsed.paths).toEqual([resultPath]);
		expect(parsed.subjects).toEqual([]);
	});

	it('keeps legacy V3 as V3 when no producer selected V4', () => {
		expect(
			mergePublishedBuildSubjects([], { version: 3, paths: [], subjects: [] })
				.version
		).toBe(3);
	});

	it('reconciles an explicit V4 result without demanding member subjects', () => {
		const merged = mergePublishedBuildSubjects([receipt], {
			version: 3,
			paths: [],
			subjects: []
		});
		expect(merged).toStrictEqual({
			...receipt,
			uploaded: [],
			failed: [],
			collected: []
		});
	});

	it('keeps a V4 failure while reconciling only actual accepted results', () => {
		const merged = mergePublishedBuildSubjects([receipt], {
			...receipt,
			failed: [
				storePathSchema.parse(
					'/nix/store/1123456789abcdfghijklmnpqrsvwxyz-failed'
				)
			],
			childExitStatus: 1,
			terminalFailure: { kind: 'target-build', failedTargets: ['.#failed'] }
		});
		expect(merged).toStrictEqual({
			...receipt,
			failed: ['/nix/store/1123456789abcdfghijklmnpqrsvwxyz-failed'],
			childExitStatus: 1,
			terminalFailure: { kind: 'target-build', failedTargets: ['.#failed'] },
			uploaded: [],
			collected: []
		});
	});

	it('reads the V4 summary envelope without counting overlapping members as uploads', () => {
		const data = buildSummaryV4Schema.parse({
			version: 4,
			mode: 'streamed',
			store: 'auto',
			targetPaths: 1,
			intermediatePaths: 0,
			queueDepth: 0,
			uploadedPaths: 2,
			uploadedBytes: 42,
			skipped: 0,
			childExitStatus: 0,
			unconfirmedPaths: [],
			publicationSets: [set, { ...set, digest: 'b'.repeat(64) }]
		});
		expect(
			uploadTally([
				{
					kind: buildSummaryV4ResultKind,
					data
				}
			])
		).toMatchObject({ paths: 2, bytes: 42 });
	});

	it('does not use sets to excuse an unrelated missing publication subject', () => {
		const unrelated = '/nix/store/1123456789abcdfghijklmnpqrsvwxyz-other';
		expect(() =>
			mergePublishedBuildSubjects(
				[
					{
						version: 3,
						paths: [storePathSchema.parse(unrelated)],
						subjects: []
					}
				],
				receipt
			)
		).toThrow('omits subjects');
	});

	it('merges V3 and V4 while preserving failure reconciliation and compact sets', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-publication-receipt-')
		);
		directories.push(directory);
		const main = path.join(directory, 'main.json');
		const additional = path.join(directory, 'additional.json');
		await writeFile(
			main,
			JSON.stringify({
				version: 3,
				paths: [],
				subjects: [],
				childExitStatus: 1,
				terminalFailure: { kind: 'target-build', failedTargets: ['.#failed'] }
			})
		);
		await writeFile(additional, JSON.stringify(receipt));
		await mergeCohortReceipts(main, true, [additional]);
		const merged = publicationReceiptSchema.parse(
			JSON.parse(await readFile(main, 'utf8'))
		);
		expect(merged).toMatchObject({
			version: 4,
			paths: [resultPath],
			subjects: [],
			childExitStatus: 1,
			terminalFailure: { kind: 'target-build' },
			publicationSets: [set]
		});
	});
});
