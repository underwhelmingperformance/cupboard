import {
	type CheckReport,
	checkReportSchema
} from '@cupboard/protocol/reports';
import type { Reporter, ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import { type CheckClient, runCheck } from './check.ts';

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
	const recordWarn = (label: string, value?: string): void => {
		captured.warnings.push({ label, value });
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
		info(message) {
			captured.infos.push(message);
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
	readonly cursorCache: string;
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

const endOfScan = { cursor: '', cursorCache: '' } as const;

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
			calls: [{ deep: false, cursor: '', cursorCache: '' }],
			captured: {
				results: [
					[
						{ label: 'Narinfos checked', value: '3' },
						{ label: 'NAR blobs checked', value: '2' },
						{ label: 'Discrepancies', value: '0' }
					]
				],
				infos: ['No discrepancies.'],
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
				cursorCache: 'builds',
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
				{ deep: false, cursor: '', cursorCache: '' },
				{ deep: false, cursor: 'c'.repeat(32), cursorCache: 'builds' }
			],
			results: [
				[
					{ label: 'Narinfos checked', value: '1,007' },
					{ label: 'NAR blobs checked', value: '905' },
					{ label: 'Discrepancies', value: '0' }
				]
			],
			infos: ['No discrepancies.']
		});
	});

	it('forwards a deep check and warns once per discrepancy', async () => {
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

		await runCheck(true, reporter(captured), checkClient([report], calls));

		expect({ calls, captured }).toStrictEqual({
			calls: [{ deep: true, cursor: '', cursorCache: '' }],
			captured: {
				results: [
					[
						{ label: 'Narinfos checked', value: '2' },
						{ label: 'NAR blobs checked', value: '1' },
						{ label: 'Discrepancies', value: '2' }
					]
				],
				infos: [],
				warnings: [
					{ label: 'missing-nar', value: `(default) ${'a'.repeat(32)}` },
					{
						label: 'missing-narinfo-object',
						value: `builds ${'b'.repeat(32)}`
					}
				]
			}
		});
	});
});
