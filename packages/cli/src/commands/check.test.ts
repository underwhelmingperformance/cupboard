import type { CheckReport } from '@cupboard/protocol/reports';
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
		phase(_label, body) {
			return Promise.resolve(
				body({
					fact() {
						return;
					},
					warn: recordWarn
				})
			);
		},
		progress(_label, _options, body) {
			return Promise.resolve(
				body({
					advance() {
						return;
					},
					fact() {
						return;
					},
					warn: recordWarn
				})
			);
		},
		steps(_label, body) {
			return Promise.resolve(
				body({
					message() {
						return;
					},
					group() {
						return {
							message() {
								return;
							},
							success() {
								return;
							},
							error() {
								return;
							}
						};
					},
					warn: recordWarn
				})
			);
		},
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

function checkClient(
	report: CheckReport,
	calls: { deep: boolean }[]
): CheckClient {
	return {
		run(input) {
			calls.push(input);

			return Promise.resolve(report);
		}
	};
}

const narHash = `sha256:${'1'.repeat(52)}`;

describe('runCheck', () => {
	it('reports the counts and a clean bill of health', async () => {
		const calls: { deep: boolean }[] = [];
		const captured: Captured = { results: [], infos: [], warnings: [] };
		const report: CheckReport = {
			narInfosChecked: 3,
			narBlobsChecked: 2,
			complete: true,
			discrepancies: []
		};

		await runCheck(false, reporter(captured), checkClient(report, calls));

		expect({ calls, captured }).toStrictEqual({
			calls: [{ deep: false }],
			captured: {
				results: [
					[
						{ label: 'Narinfos checked', value: '3' },
						{ label: 'NAR blobs checked', value: '2' },
						{ label: 'Complete', value: 'yes' },
						{ label: 'Discrepancies', value: '0' }
					]
				],
				infos: ['No discrepancies.'],
				warnings: []
			}
		});
	});

	it('forwards a deep check and warns once per discrepancy', async () => {
		const calls: { deep: boolean }[] = [];
		const captured: Captured = { results: [], infos: [], warnings: [] };
		const report: CheckReport = {
			narInfosChecked: 2,
			narBlobsChecked: 1,
			complete: false,
			discrepancies: [
				{
					kind: 'missing-nar',
					cache: '',
					storePathHash: 'a'.repeat(32),
					narHash
				},
				{
					kind: 'missing-narinfo-object',
					cache: 'builds',
					storePathHash: 'b'.repeat(32),
					narHash
				}
			]
		};

		await runCheck(true, reporter(captured), checkClient(report, calls));

		expect({ calls, captured }).toStrictEqual({
			calls: [{ deep: true }],
			captured: {
				results: [
					[
						{ label: 'Narinfos checked', value: '2' },
						{ label: 'NAR blobs checked', value: '1' },
						{ label: 'Complete', value: 'no' },
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
