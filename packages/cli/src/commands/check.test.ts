import {
	type CheckReport,
	checkReportSchema,
	type SharedAccessReport,
	sharedAccessReportSchema
} from '@cupboard/protocol/reports';
import type {
	MessagePresentation,
	Reporter,
	ResultRow
} from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import { CheckDiscrepanciesError } from '../errors.ts';

import { type CheckClient, runCheck, runSharedAccess } from './check.ts';

interface Warning {
	readonly label: string;
	readonly value: string | undefined;
}

interface Captured {
	readonly results: ResultRow[][];
	readonly infos: string[];
	readonly warnings: Warning[];
}

function reporter(captured: Captured): Reporter {
	const recordWarn = (
		label: string,
		value?: string,
		presentation?: MessagePresentation
	): void => {
		captured.warnings.push({
			label: presentation?.humanMessage ?? label,
			value: presentation?.humanMessage === undefined ? value : undefined
		});
	};

	return {
		phase: (_label, body) =>
			Promise.resolve(
				body({
					fact() {
						return;
					},
					warn: recordWarn
				})
			),
		progress: (_label, _options, body) =>
			Promise.resolve(
				body({
					advance() {
						return;
					},
					fact() {
						return;
					},
					warn: recordWarn
				})
			),
		steps: (_label, body) =>
			Promise.resolve(
				body({
					message() {
						return;
					},
					group: () => ({
						message() {
							return;
						},
						success() {
							return;
						},
						error() {
							return;
						}
					}),
					warn: recordWarn
				})
			),
		result(payload) {
			captured.results.push([...payload.rows]);
		},
		data() {
			return;
		},
		error() {
			return;
		},
		warn: recordWarn,
		info(message, presentation) {
			captured.infos.push(presentation?.humanMessage ?? message);
		},
		success(message) {
			captured.infos.push(message);
		},
		step(message) {
			captured.infos.push(message);
		}
	};
}

interface CheckCall {
	readonly deep: boolean;
	readonly cursor: string;
	readonly cursorCache: number;
}

// Answers each call with the next page, so a test states the pages the server
// would return and the command follows their cursors.
function checkClient(
	pages: readonly CheckReport[],
	calls: CheckCall[]
): CheckClient {
	let index = 0;

	return {
		run(input) {
			calls.push(input);
			const page = pages[index];
			index += 1;

			if (page === undefined) {
				throw new Error('the command asked for more pages than the test has');
			}

			return Promise.resolve(page);
		}
	};
}

const endOfScan = { cursor: '', cursorCache: 0 } as const;

const narHash = `sha256:${'1'.repeat(52)}`;

describe('runCheck', () => {
	it('reports the counts and a clean bill of health', async () => {
		const calls: CheckCall[] = [];
		const captured: Captured = { results: [], infos: [], warnings: [] };
		const report = checkReportSchema.parse({
			narInfosChecked: 3,
			narBlobsChecked: 2,
			...endOfScan,
			discrepancies: []
		});

		await runCheck(false, reporter(captured), checkClient([report], calls));

		expect({ calls, captured }).toStrictEqual({
			calls: [{ deep: false, cursor: '', cursorCache: 0 }],
			captured: {
				results: [
					[
						{ label: 'Cache metadata checked', value: '3' },
						{ label: 'Stored archives checked', value: '2' },
						{ label: 'Problems found', value: '0' }
					]
				],
				infos: ['No problems found.'],
				warnings: []
			}
		});
	});

	// The scan reports where it stopped, and the command follows that cursor
	// until it comes back empty.
	it('follows the cursor to the end of the scan', async () => {
		const calls: CheckCall[] = [];
		const captured: Captured = { results: [], infos: [], warnings: [] };
		const pages = [
			checkReportSchema.parse({
				narInfosChecked: 1000,
				narBlobsChecked: 900,
				cursor: 'c'.repeat(32),
				cursorCache: 1,
				discrepancies: []
			}),
			checkReportSchema.parse({
				narInfosChecked: 7,
				narBlobsChecked: 5,
				...endOfScan,
				discrepancies: []
			})
		];

		await runCheck(false, reporter(captured), checkClient(pages, calls));

		expect({
			calls,
			results: captured.results,
			infos: captured.infos
		}).toStrictEqual({
			calls: [
				{ deep: false, cursor: '', cursorCache: 0 },
				{ deep: false, cursor: 'c'.repeat(32), cursorCache: 1 }
			],
			results: [
				[
					{ label: 'Cache metadata checked', value: '1,007' },
					{ label: 'Stored archives checked', value: '905' },
					{ label: 'Problems found', value: '0' }
				]
			],
			infos: ['No problems found.']
		});
	});

	it('forwards a deep check, warns once per discrepancy and fails', async () => {
		const calls: CheckCall[] = [];
		const captured: Captured = { results: [], infos: [], warnings: [] };
		const report = checkReportSchema.parse({
			narInfosChecked: 2,
			narBlobsChecked: 1,
			...endOfScan,
			discrepancies: [
				{
					kind: 'missing-nar',
					cache: { kind: 'default' },
					storePathHash: 'a'.repeat(32),
					narHash
				},
				{
					kind: 'missing-narinfo-object',
					cache: { kind: 'named', name: 'builds' },
					storePathHash: 'b'.repeat(32),
					narHash
				}
			]
		});

		await expect(
			runCheck(true, reporter(captured), checkClient([report], calls))
		).rejects.toStrictEqual(new CheckDiscrepanciesError(2));

		expect({ calls, captured }).toStrictEqual({
			calls: [{ deep: true, cursor: '', cursorCache: 0 }],
			captured: {
				results: [
					[
						{ label: 'Cache metadata checked', value: '2' },
						{ label: 'Stored archives checked', value: '1' },
						{ label: 'Problems found', value: '2' }
					]
				],
				infos: [],
				warnings: [
					{
						label: `Stored archive is missing: (default) ${'a'.repeat(32)}. Ask the tenant administrator to investigate and restore the published path.`,
						value: undefined
					},
					{
						label: `Cache metadata file is missing: builds ${'b'.repeat(32)}. Ask the tenant administrator to investigate and restore the published path.`,
						value: undefined
					}
				]
			}
		});
	});
});

describe('shared-access report', () => {
	it('follows every report page and lists shared NARs without changing them', async () => {
		const secondHash = `sha256:${'2'.repeat(52)}`;
		const calls: { cursor: SharedAccessReport['cursor'] }[] = [];
		const pages = [
			{ narHashes: [narHash], cursor: narHash },
			{ narHashes: [secondHash], cursor: '' }
		].map((page) => sharedAccessReportSchema.parse(page));
		const captured: Captured = { results: [], infos: [], warnings: [] };
		await runSharedAccess(reporter(captured), {
			sharedAccess(input) {
				calls.push(input);
				const page = pages.shift();
				if (page === undefined) {
					throw new Error('Unexpected report page');
				}
				return Promise.resolve(page);
			}
		});
		expect({ calls, captured }).toStrictEqual({
			calls: [{ cursor: '' }, { cursor: narHash }],
			captured: {
				results: [
					[
						{ label: 'Shared NARs', value: '2' },
						{ label: 'NAR', value: narHash },
						{ label: 'NAR', value: secondHash }
					]
				],
				infos: [],
				warnings: []
			}
		});
	});
});
