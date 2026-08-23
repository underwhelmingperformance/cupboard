import Cloudflare from 'cloudflare';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { fakeCliUi } from '../packages/cli-ui/src/testing.ts';
import type { ResultRow } from '../packages/reporter/src/reporter.ts';

import {
	analyse,
	type Analysis,
	bucketForLog,
	bucketForTrace,
	buildVerdict,
	canonicalPath,
	detectSession,
	fetchPaged,
	GitHubJobRequestError,
	hasSessionBoundary,
	InvalidGitHubJobMetadataError,
	InvalidGitHubJobUrlError,
	lookbackWindow,
	mergeBusy,
	minPageLimit,
	normalisePath,
	type OperationGroup,
	operationRows,
	type OperationStat,
	parseGitHubJobUrl,
	parseSpanEvent,
	parseTraceSummary,
	parseWorkerLog,
	percentile,
	renderAnalysis,
	sliceWindow,
	slowestRows,
	type SpanEvent,
	summaryRows,
	type TelemetryQuery,
	type TimeWindow,
	type TraceSummary,
	triggerGroup,
	windowForGitHubJob,
	type WorkerLog
} from './diagnose-push.ts';

const completedGitHubJob: typeof fetch = () =>
	Promise.resolve(
		Response.json({
			id: 30,
			run_id: 20,
			started_at: '2026-08-17T08:00:00Z',
			completed_at: '2026-08-17T08:30:00Z'
		})
	);

const activeGitHubJob: typeof fetch = () =>
	Promise.resolve(
		Response.json({
			id: 30,
			run_id: 20,
			started_at: '2026-08-17T08:00:00Z'
		})
	);

describe('GitHub job window', () => {
	it('parses a GitHub Actions job URL', () => {
		expect(
			parseGitHubJobUrl(
				'https://github.com/iainlane/dotfiles/actions/runs/32007544027/job/95321136432'
			)
		).toStrictEqual({
			owner: 'iainlane',
			repository: 'dotfiles',
			runId: '32007544027',
			jobId: '95321136432'
		});
	});

	it('rejects a URL that does not identify an Actions job', () => {
		expect(() =>
			parseGitHubJobUrl('https://github.com/iainlane/dotfiles/actions')
		).toThrow(InvalidGitHubJobUrlError);
	});

	it('reports a GitHub HTTP refusal as GitHubJobRequestError', async () => {
		const reference = parseGitHubJobUrl(
			'https://github.com/iainlane/dotfiles/actions/runs/20/job/30'
		);
		const request = windowForGitHubJob(reference, 0, () =>
			Promise.resolve(new Response(undefined, { status: 403 }))
		);

		await expect(request).rejects.toBeInstanceOf(GitHubJobRequestError);
	});

	it('reports malformed GitHub job metadata as its own error type', async () => {
		const reference = parseGitHubJobUrl(
			'https://github.com/iainlane/dotfiles/actions/runs/20/job/30'
		);
		const metadata = { id: 30 };
		const request = windowForGitHubJob(reference, 0, () =>
			Promise.resolve(Response.json(metadata))
		);

		await expect(request).rejects.toBeInstanceOf(InvalidGitHubJobMetadataError);
	});

	it('uses the job timestamps and a margin for a completed job', async () => {
		const reference = parseGitHubJobUrl(
			'https://github.com/iainlane/dotfiles/actions/runs/20/job/30'
		);
		expect(
			await windowForGitHubJob(
				reference,
				Date.parse('2026-08-17T09:00:00Z'),
				completedGitHubJob
			)
		).toStrictEqual({
			from: Date.parse('2026-08-17T07:58:00Z'),
			to: Date.parse('2026-08-17T08:32:00Z')
		});
	});

	it('ends an active job window at the current time', async () => {
		const reference = parseGitHubJobUrl(
			'https://github.com/iainlane/dotfiles/actions/runs/20/job/30'
		);
		const now = Date.parse('2026-08-17T08:30:00Z');

		expect(
			await windowForGitHubJob(reference, now, activeGitHubJob)
		).toStrictEqual({
			from: Date.parse('2026-08-17T07:58:00Z'),
			to: now
		});
	});
});

describe('lookbackWindow', () => {
	it('returns the requested interval', () => {
		const now = Date.parse('2026-08-17T09:00:00Z');

		expect(lookbackWindow(now, 45)).toStrictEqual({
			from: Date.parse('2026-08-17T08:15:00Z'),
			to: now
		});
	});
});

describe('normalisePath', () => {
	it.each([
		['/t/acme/cache/pr-144/uploads', '/t/:tenant/cache/:cache/uploads'],
		[
			'/t/acme/cache/pr-144/uploads/prepare',
			'/t/:tenant/cache/:cache/uploads/prepare'
		],
		[
			'/cache/pr-144/uploads/0n8w9k2j4h5g6f7d8s9a0p1q2w3e4r5t',
			'/cache/:cache/uploads/:id'
		],
		[
			'/cache/pr-144/roots/github%3Aiainlane%2Fdotfiles%2Fpr-144%2Faarch64-linux',
			'/cache/:cache/roots/:name'
		],
		[
			'/t/acme/cache/pr-144/nar/abcdef0123',
			'/t/:tenant/cache/:cache/nar/:name'
		],
		[
			'/t/acme/cache/pr-144/0n8w9k2j4h5g6f7d8s9a0p1q2w3e4r5t.narinfo',
			'/t/:tenant/cache/:cache/:hash.narinfo'
		],
		['/_version', '/_version']
	])('normalises %s', (input, expected) => {
		expect(normalisePath(input)).toBe(expected);
	});
});

describe('bucketForLog', () => {
	it('keys HTTP logs by method and normalised path', () => {
		expect(
			bucketForLog(
				'PUT',
				undefined,
				'/cache/pr-1/uploads/abc123def456',
				'request finished'
			)
		).toBe('PUT /cache/:cache/uploads/:id');
	});

	it('keys RPC logs by method name', () => {
		expect(
			bucketForLog(undefined, 'verification', undefined, 'method finished')
		).toBe('rpc verification');
	});

	it('uses the message when no HTTP or RPC fields are present', () => {
		expect(
			bucketForLog(
				undefined,
				undefined,
				undefined,
				'verification request not enqueued'
			)
		).toBe('verification request not enqueued');
	});
});

describe('canonicalPath', () => {
	it.each([
		[
			'https://cupboard.supply/t/acme/cache/pr-144/uploads/abc123def456ghij',
			'/cache/:cache/uploads/:id'
		],
		['https://cupboard.supply/t/acme/token', '/token'],
		['/cache/pr-144/uploads/abc123def456ghij', '/cache/:cache/uploads/:id'],
		['https://cupboard.supply/t/acme', '/']
	])('canonicalises %s', (input, expected) => {
		expect(canonicalPath(input)).toBe(expected);
	});
});

describe('bucketForTrace', () => {
	it('drops host and tenant so a trace joins the inner log', () => {
		expect(
			bucketForTrace(
				'PUT https://cupboard.supply/t/acme/cache/pr-144/roots/github%3Aiainlane'
			)
		).toBe('PUT /cache/:cache/roots/:name');
	});

	it('passes a name without a method through unchanged', () => {
		expect(bucketForTrace('alarm')).toBe('alarm');
	});
});

describe('parseWorkerLog', () => {
	it('parses an HTTP request-finished event', () => {
		const event = {
			timestamp: 1000,
			source: {
				message: 'request finished',
				method: 'PUT',
				path: '/cache/pr-1/uploads/abc123def456ghij',
				status: 200,
				rowsRead: 22,
				rowsWritten: 19
			},
			$metadata: { requestId: 'r1' }
		};

		expect(parseWorkerLog(event)).toStrictEqual({
			requestId: 'r1',
			timestamp: 1000,
			message: 'request finished',
			httpMethod: 'PUT',
			rpcMethod: undefined,
			path: '/cache/pr-1/uploads/abc123def456ghij',
			status: 200,
			rowsRead: 22,
			rowsWritten: 19,
			bucket: 'PUT /cache/:cache/uploads/:id'
		});
	});

	it('parses an RPC method-finished event', () => {
		const event = {
			timestamp: 2000,
			source: {
				message: 'method finished',
				method: 'verification',
				rowsRead: 24,
				rowsWritten: 12
			},
			$metadata: { requestId: 'r2' }
		};

		expect(parseWorkerLog(event)).toStrictEqual({
			requestId: 'r2',
			timestamp: 2000,
			message: 'method finished',
			httpMethod: undefined,
			rpcMethod: 'verification',
			path: undefined,
			status: undefined,
			rowsRead: 24,
			rowsWritten: 12,
			bucket: 'rpc verification'
		});
	});

	it('rejects a malformed event', () => {
		expect(parseWorkerLog({ source: 'no timestamp' })).toBeUndefined();
	});

	it.each([
		['a string-source span event', { timestamp: 1, source: 'span' }],
		['a source without a message', { timestamp: 1, source: { rowsRead: 3 } }],
		['an empty message', { timestamp: 1, source: { message: '  ' } }],
		[
			'a trace-root URL message',
			{
				timestamp: 1,
				source: {
					message: 'POST https://cupboard.supply/cache/_default/uploads'
				}
			}
		]
	])('drops %s', (_label, event) => {
		expect(parseWorkerLog(event)).toBeUndefined();
	});
});

describe('parseTraceSummary', () => {
	it('parses a trace summary', () => {
		const trace = {
			traceId: 't1',
			rootTransactionName: 'POST /cache/pr-1/uploads',
			traceDurationMs: 120,
			spans: 4,
			traceStartMs: 5000,
			errors: ['boom']
		};

		expect(parseTraceSummary(trace)).toStrictEqual({
			traceId: 't1',
			bucket: 'POST /cache/:cache/uploads',
			durationMs: 120,
			spans: 4,
			startMs: 5000,
			errors: ['boom']
		});
	});
});

describe('parseSpanEvent', () => {
	it('parses a span with its duration and tree links', () => {
		const event = {
			timestamp: 1000,
			$metadata: {
				type: 'span',
				traceId: 'tr1',
				spanId: 'sp1',
				parentSpanId: 'sp0',
				spanName: 'd1_run',
				startTime: 1000,
				endTime: 1071
			}
		};

		expect(parseSpanEvent(event)).toStrictEqual({
			traceId: 'tr1',
			spanId: 'sp1',
			parentSpanId: 'sp0',
			name: 'd1_run',
			startMs: 1000,
			endMs: 1071
		});
	});

	it.each([
		['a log event (not a span)', { timestamp: 1, $metadata: { type: 'log' } }],
		[
			'a span without a name',
			{ timestamp: 1, $metadata: { type: 'span', traceId: 't' } }
		]
	])('rejects %s', (_label, event) => {
		expect(parseSpanEvent(event)).toBeUndefined();
	});
});

const noSleep = (): Promise<void> => Promise.resolve();
const noProgress = (): void => {
	/*
	progress unobserved
	*/
};
const timestampRowSchema = z.object({ timestamp: z.unknown() });
const timestampOf = (row: unknown): number | undefined => {
	const timestamp = timestampRowSchema.safeParse(row).data?.timestamp;

	return timestamp === undefined ? undefined : Number(timestamp);
};

const cursorRowSchema = z.object({ id: z.string() });
const cursorOf = (row: unknown): string | undefined =>
	cursorRowSchema.safeParse(row).data?.id;

function tracePage(from: number, count: number): { timestamp: number }[] {
	return Array.from({ length: count }, (_, index) => ({
		timestamp: from - index
	}));
}

describe('fetchPaged', () => {
	it('continues past a short page and stops on the empty one', async () => {
		const timeframes: { from: number; to: number }[] = [];
		const pages = [tracePage(1000, 500), tracePage(500, 100), []];
		const query: TelemetryQuery = (parameters) => {
			timeframes.push({ ...parameters.timeframe });

			return Promise.resolve({ traces: pages.shift() ?? [] });
		};

		const rows = await fetchPaged(
			query,
			'traces',
			{ from: 0, to: 1000 },
			timestampOf,
			undefined,
			noProgress,
			noSleep
		);

		expect({ rowCount: rows.length, timeframes }).toStrictEqual({
			rowCount: 600,
			timeframes: [
				{ from: 0, to: 1000 },
				{ from: 0, to: 501 },
				{ from: 0, to: 401 }
			]
		});
	});

	it('walks through a same-millisecond boundary without dropping rows', async () => {
		const timeframes: { from: number; to: number }[] = [];
		const pages = [
			[
				{ timestamp: 800, id: 'a' },
				{ timestamp: 700, id: 'b' },
				{ timestamp: 700, id: 'c' }
			],
			[
				{ timestamp: 700, id: 'b' },
				{ timestamp: 700, id: 'c' },
				{ timestamp: 700, id: 'd' },
				{ timestamp: 650, id: 'e' }
			],
			[]
		];
		const query: TelemetryQuery = (parameters) => {
			timeframes.push({ ...parameters.timeframe });

			return Promise.resolve({ traces: pages.shift() ?? [] });
		};

		const rows = await fetchPaged(
			query,
			'traces',
			{ from: 0, to: 1000 },
			timestampOf,
			undefined,
			noProgress,
			noSleep
		);

		expect({ rows, timeframes }).toStrictEqual({
			rows: [
				{ timestamp: 800, id: 'a' },
				{ timestamp: 700, id: 'b' },
				{ timestamp: 700, id: 'c' },
				{ timestamp: 700, id: 'd' },
				{ timestamp: 650, id: 'e' }
			],
			timeframes: [
				{ from: 0, to: 1000 },
				{ from: 0, to: 700 },
				{ from: 0, to: 650 }
			]
		});
	});

	it('stops on a burst page that yields nothing new', async () => {
		const timeframes: { from: number; to: number }[] = [];
		const burst = [
			{ timestamp: 700, id: 'a' },
			{ timestamp: 700, id: 'b' }
		];
		const query: TelemetryQuery = (parameters) => {
			timeframes.push({ ...parameters.timeframe });

			return Promise.resolve({ traces: [...burst] });
		};

		const rows = await fetchPaged(
			query,
			'traces',
			{ from: 0, to: 1000 },
			timestampOf,
			undefined,
			noProgress,
			noSleep
		);

		expect({ rows, timeframes }).toStrictEqual({
			rows: burst,
			timeframes: [
				{ from: 0, to: 1000 },
				{ from: 0, to: 700 }
			]
		});
	});

	it('retries a transient telemetry refusal and then succeeds', async () => {
		const sleeps: number[] = [];
		let failures = 2;
		const query: TelemetryQuery = () => {
			if (failures > 0) {
				failures -= 1;

				return Promise.reject(
					new Cloudflare.APIError(401, undefined, 'unauthorized', undefined)
				);
			}

			return Promise.resolve({ traces: [] });
		};

		const rows = await fetchPaged(
			query,
			'traces',
			{ from: 0, to: 1000 },
			timestampOf,
			undefined,
			noProgress,
			(ms) => {
				sleeps.push(ms);

				return Promise.resolve();
			}
		);

		expect({ rows, retries: sleeps.length }).toStrictEqual({
			rows: [],
			retries: 2
		});
	});

	it('surfaces the refusal once the retries are exhausted', async () => {
		let attempts = 0;
		const query: TelemetryQuery = () => {
			attempts += 1;

			return Promise.reject(
				new Cloudflare.APIError(429, undefined, 'rate limited', undefined)
			);
		};

		await expect(
			fetchPaged(
				query,
				'traces',
				{ from: 0, to: 1000 },
				timestampOf,
				undefined,
				noProgress,
				noSleep
			)
		).rejects.toBeInstanceOf(Cloudflare.APIError);
		expect(attempts).toBe(5);
	});

	it('does not retry a refusal that will not change', async () => {
		let attempts = 0;
		const query: TelemetryQuery = () => {
			attempts += 1;

			return Promise.reject(
				new Cloudflare.APIError(400, undefined, 'bad query', undefined)
			);
		};

		await expect(
			fetchPaged(
				query,
				'traces',
				{ from: 0, to: 1000 },
				timestampOf,
				undefined,
				noProgress,
				noSleep
			)
		).rejects.toBeInstanceOf(Cloudflare.APIError);
		expect(attempts).toBe(1);
	});

	it('steps a truncated page down repeatedly until the body fits', async () => {
		const limits: number[] = [];
		const query: TelemetryQuery = (parameters) => {
			limits.push(parameters.limit);

			if (parameters.limit > 250) {
				return Promise.reject(
					new Error(
						'invalid json response body reason: Unterminated string in JSON'
					)
				);
			}

			const page = parameters.timeframe.to === 1000 ? tracePage(1000, 10) : [];

			return Promise.resolve({ traces: page });
		};

		const rows = await fetchPaged(
			query,
			'traces',
			{ from: 0, to: 1000 },
			timestampOf,
			undefined,
			noProgress,
			noSleep
		);

		expect({ rowCount: rows.length, limits }).toStrictEqual({
			rowCount: 10,
			limits: [1000, 500, 250, 250]
		});
	});

	it('surfaces a truncation that persists at the smallest page', async () => {
		const limits: number[] = [];
		const query: TelemetryQuery = (parameters) => {
			limits.push(parameters.limit);

			return Promise.reject(
				new Error(
					'invalid json response body reason: Unterminated string in JSON'
				)
			);
		};

		await expect(
			fetchPaged(
				query,
				'traces',
				{ from: 0, to: 1000 },
				timestampOf,
				undefined,
				noProgress,
				noSleep
			)
		).rejects.toThrow('Unterminated string');
		expect(limits).toStrictEqual([1000, 500, 250, 125, 62, 31, minPageLimit]);
	});

	it('pages a same-millisecond burst by its smallest id', async () => {
		const requests: {
			offset: string | undefined;
			direction: string | undefined;
			timeframe: { from: number; to: number };
		}[] = [];
		const pages = [
			[
				{ timestamp: 700, id: 'g' },
				{ timestamp: 700, id: 'f' }
			],
			[
				{ timestamp: 700, id: 'e' },
				{ timestamp: 700, id: 'd' }
			],
			[]
		];
		const query: TelemetryQuery = (parameters) => {
			requests.push({
				offset: parameters.offset,
				direction: parameters.offsetDirection,
				timeframe: { ...parameters.timeframe }
			});

			return Promise.resolve({ events: { events: pages.shift() ?? [] } });
		};

		const rows = await fetchPaged(
			query,
			'events',
			{ from: 0, to: 1000 },
			timestampOf,
			cursorOf,
			noProgress,
			noSleep
		);

		expect({ rows, requests }).toStrictEqual({
			rows: [
				{ timestamp: 700, id: 'g' },
				{ timestamp: 700, id: 'f' },
				{ timestamp: 700, id: 'e' },
				{ timestamp: 700, id: 'd' }
			],
			requests: [
				{
					offset: undefined,
					direction: undefined,
					timeframe: { from: 0, to: 1000 }
				},
				{ offset: 'f', direction: 'next', timeframe: { from: 0, to: 1000 } },
				{ offset: 'd', direction: 'next', timeframe: { from: 0, to: 1000 } }
			]
		});
	});

	it('drops rows the view replays across pages', async () => {
		const pages = [
			[
				{ timestamp: 700, id: 'g' },
				{ timestamp: 700, id: 'f' }
			],
			[
				{ timestamp: 700, id: 'g' },
				{ timestamp: 650, id: 'e' }
			],
			[]
		];
		const query: TelemetryQuery = () =>
			Promise.resolve({ events: { events: pages.shift() ?? [] } });

		const rows = await fetchPaged(
			query,
			'events',
			{ from: 0, to: 1000 },
			timestampOf,
			cursorOf,
			noProgress,
			noSleep
		);

		expect(rows).toStrictEqual([
			{ timestamp: 700, id: 'g' },
			{ timestamp: 700, id: 'f' },
			{ timestamp: 650, id: 'e' }
		]);
	});

	it('stops the timeframe walk once the collected rows bracket a gap', async () => {
		let requests = 0;
		const pages = [
			[{ timestamp: 1000 }, { timestamp: 950 }],
			[{ timestamp: 950 }, { timestamp: -2000 }],
			[]
		];
		const query: TelemetryQuery = () => {
			requests += 1;

			return Promise.resolve({ traces: pages.shift() ?? [] });
		};

		const rows = await fetchPaged(
			query,
			'traces',
			{ from: -10_000, to: 1000 },
			timestampOf,
			undefined,
			noProgress,
			noSleep,
			1000
		);

		expect({ rows, requests }).toStrictEqual({
			rows: [{ timestamp: 1000 }, { timestamp: 950 }, { timestamp: -2000 }],
			requests: 2
		});
	});

	it('stops the cursor walk once the collected rows bracket a gap', async () => {
		let requests = 0;
		const pages = [
			[
				{ timestamp: 1000, id: 'd' },
				{ timestamp: 950, id: 'c' }
			],
			[{ timestamp: -2000, id: 'a' }],
			[]
		];
		const query: TelemetryQuery = () => {
			requests += 1;

			return Promise.resolve({ events: { events: pages.shift() ?? [] } });
		};

		const rows = await fetchPaged(
			query,
			'events',
			{ from: -10_000, to: 1000 },
			timestampOf,
			cursorOf,
			noProgress,
			noSleep,
			1000
		);

		expect({ rows, requests }).toStrictEqual({
			rows: [
				{ timestamp: 1000, id: 'd' },
				{ timestamp: 950, id: 'c' },
				{ timestamp: -2000, id: 'a' }
			],
			requests: 2
		});
	});

	it('steps the bound below the oldest row when the cursor stalls', async () => {
		const requests: {
			offset: string | undefined;
			to: number;
		}[] = [];
		const query: TelemetryQuery = (parameters) => {
			requests.push({ offset: parameters.offset, to: parameters.timeframe.to });

			if (parameters.timeframe.to === 1000) {
				return Promise.resolve({
					events: {
						events: [
							{ timestamp: 700, id: 'g' },
							{ timestamp: 700, id: 'f' }
						]
					}
				});
			}

			return Promise.resolve({
				events: {
					events:
						parameters.timeframe.to === 699 && parameters.offset === undefined
							? [{ timestamp: 650, id: 'e' }]
							: []
				}
			});
		};

		const rows = await fetchPaged(
			query,
			'events',
			{ from: 0, to: 1000 },
			timestampOf,
			cursorOf,
			noProgress,
			noSleep
		);

		expect({ rows, requests }).toStrictEqual({
			rows: [
				{ timestamp: 700, id: 'g' },
				{ timestamp: 700, id: 'f' },
				{ timestamp: 650, id: 'e' }
			],
			requests: [
				{ offset: undefined, to: 1000 },
				{ offset: 'f', to: 1000 },
				{ offset: undefined, to: 699 },
				{ offset: 'e', to: 699 }
			]
		});
	});
});

describe('sliceWindow', () => {
	const hour = 60 * 60 * 1000;

	it('returns the whole window when it is short', () => {
		expect(sliceWindow({ from: 0, to: 1000 })).toStrictEqual([
			{ from: 0, to: 1000 }
		]);
	});

	it('covers the window exactly, last slice reaching the end', () => {
		const slices = sliceWindow({ from: 0, to: hour });

		expect(slices).toStrictEqual([
			{ from: 0, to: 1_799_999 },
			{ from: 1_800_000, to: hour }
		]);
	});

	it('caps the number of slices', () => {
		const slices = sliceWindow({ from: 0, to: 1000 * hour });

		expect(slices).toHaveLength(48);
		expect(slices.at(0)?.from).toBe(0);
		expect(slices.at(-1)?.to).toBe(1000 * hour);
	});
});

describe('mergeBusy', () => {
	it.each([
		[
			'merges overlaps and sums gaps',
			[
				[0, 100],
				[50, 120],
				[200, 250]
			],
			170
		],
		['is zero for no intervals', [], 0]
	])('%s', (_label, intervals, expected) => {
		expect(mergeBusy(intervals as [number, number][])).toBe(expected);
	});
});

describe('detectSession', () => {
	it('returns undefined with no activity', () => {
		expect(detectSession([], 1000)).toBeUndefined();
	});

	it('keeps only the trailing cluster after a long gap', () => {
		expect(detectSession([0, 500, 11_000, 11_400, 11_900], 1000)).toStrictEqual(
			{
				from: 11_000,
				to: 11_900
			}
		);
	});

	it('spans the whole range when gaps stay small', () => {
		expect(detectSession([0, 500, 900, 1300], 1000)).toStrictEqual({
			from: 0,
			to: 1300
		});
	});
});

describe('hasSessionBoundary', () => {
	it.each([
		['is false with fewer than two points', [5], false],
		['is false when every gap is within the limit', [0, 500, 900, 1300], false],
		['is true when a gap exceeds the limit', [0, 500, 2000], true],
		['ignores the order of the points', [11_000, 0, 500], true]
	])('%s', (_label, timestamps, expected) => {
		expect(hasSessionBoundary(timestamps, 1000)).toBe(expected);
	});
});

describe('percentile', () => {
	it.each([
		[50, 30],
		[95, 50],
		[100, 50]
	])('p%i of 10..50 is %i', (p, expected) => {
		expect(percentile([10, 20, 30, 40, 50], p)).toBe(expected);
	});

	it('is zero for an empty series', () => {
		expect(percentile([], 95)).toBe(0);
	});
});

describe('analyse', () => {
	const window: TimeWindow = { from: 0, to: 10_000 };

	const logs: WorkerLog[] = [
		{
			requestId: 'r1',
			timestamp: 1000,
			message: 'request finished',
			httpMethod: 'PUT',
			rpcMethod: undefined,
			path: '/cache/c/uploads/aaa111bbb222ccc3',
			status: 200,
			rowsRead: 20,
			rowsWritten: 10,
			bucket: 'PUT /cache/:cache/uploads/:id'
		},
		{
			requestId: 'r2',
			timestamp: 2000,
			message: 'request finished',
			httpMethod: 'PUT',
			rpcMethod: undefined,
			path: '/cache/c/uploads/ddd444eee555fff6',
			status: 500,
			rowsRead: 30,
			rowsWritten: 15,
			bucket: 'PUT /cache/:cache/uploads/:id'
		},
		{
			requestId: 'r3',
			timestamp: 3000,
			message: 'request finished',
			httpMethod: 'POST',
			rpcMethod: undefined,
			path: '/cache/c/uploads',
			status: 200,
			rowsRead: 5,
			rowsWritten: 0,
			bucket: 'POST /cache/:cache/uploads'
		}
	];

	const traces: TraceSummary[] = [
		{
			traceId: 't1',
			bucket: 'PUT /cache/:cache/uploads/:id',
			durationMs: 400,
			spans: 3,
			startMs: 1000,
			errors: []
		},
		{
			traceId: 't2',
			bucket: 'PUT /cache/:cache/uploads/:id',
			durationMs: 800,
			spans: 3,
			startMs: 2000,
			errors: ['staging object missing', 'staging object missing']
		},
		{
			traceId: 't3',
			bucket: 'POST /cache/:cache/uploads',
			durationMs: 100,
			spans: 2,
			startMs: 3000,
			errors: []
		}
	];

	const span = (
		traceId: string,
		spanId: string,
		parentSpanId: string | undefined,
		name: string,
		startMs: number,
		endMs: number
	): SpanEvent => ({
		traceId,
		spanId,
		parentSpanId,
		name,
		startMs,
		endMs
	});

	const spans: SpanEvent[] = [
		span('t1', 's0', undefined, 'PUT', 0, 400),
		span('t1', 's1', 's0', 'r2_head', 0, 100),
		span('t1', 's2', 's0', 'r2_head', 50, 120),
		span('t1', 's3', 's0', 'd1_run', 120, 125),
		span('t1', 's9', 's0', 'durable_object_storage_exec', 125, 125),
		span('t2', 's4', undefined, 'PUT', 0, 800),
		span('t2', 's5', 's4', 'r2_head', 0, 200),
		span('t2', 's6', 's4', 'd1_run', 10, 17),
		span('t3', 's7', undefined, 'POST', 0, 100),
		span('t3', 's8', 's7', 'r2_put', 0, 30)
	];

	it('rolls traces, logs and spans up by operation, busiest first', () => {
		const analysis = analyse('cupboard-tenant', window, logs, traces, spans);

		expect(analysis.tracingAvailable).toBe(true);
		expect(analysis.tracedServerMs).toBe(1300);
		expect(analysis.invocations).toBe(3);
		expect(analysis.totals).toStrictEqual({
			rowsRead: 55,
			rowsWritten: 25,
			errors: 2
		});
		expect(analysis.traceErrors).toStrictEqual([
			{
				bucket: 'PUT /cache/:cache/uploads/:id',
				message: 'staging object missing',
				occurrences: 2
			}
		]);
		expect(analysis.groups).toStrictEqual([
			{
				group: 'fetch',
				tracedServerMs: 1300,
				traceCount: 3,
				operations: [
					{
						bucket: 'PUT /cache/:cache/uploads/:id',
						group: 'fetch',
						traceCount: 2,
						totalMs: 1200,
						p50Ms: 400,
						p95Ms: 800,
						maxMs: 800,
						logCount: 2,
						rowsRead: 50,
						rowsWritten: 25,
						errors: 2,
						spanCount: 6,
						unaccountedMs: 875,
						spans: [
							{ name: 'r2_head', count: 3, busyMs: 320 },
							{ name: 'd1_run', count: 2, busyMs: 12 },
							{ name: 'durable_object_storage_exec', count: 1, busyMs: 0 }
						]
					},
					{
						bucket: 'POST /cache/:cache/uploads',
						group: 'fetch',
						traceCount: 1,
						totalMs: 100,
						p50Ms: 100,
						p95Ms: 100,
						maxMs: 100,
						logCount: 1,
						rowsRead: 5,
						rowsWritten: 0,
						errors: 0,
						spanCount: 2,
						unaccountedMs: 70,
						spans: [{ name: 'r2_put', count: 1, busyMs: 30 }]
					}
				]
			}
		]);
	});

	it('splits operations into one group per trigger', () => {
		const queueTrace: TraceSummary = {
			traceId: 'q1',
			bucket: 'queue',
			durationMs: 5000,
			spans: 1,
			startMs: 4000,
			errors: []
		};

		const analysis = analyse(
			'cupboard-tenant',
			window,
			logs,
			[...traces, queueTrace],
			[]
		);

		expect(analysis.groups.map((group) => group.group)).toStrictEqual([
			'queue',
			'fetch'
		]);
	});

	it('reports a no-trace fallback in the verdict', () => {
		const analysis = analyse('cupboard-tenant', window, logs, [], []);

		expect(analysis.tracingAvailable).toBe(false);
		expect(analysis.verdict).toContain('No traces in the window');
	});

	it('leads the summary rows with the verdict', () => {
		const analysis = analyse('cupboard-tenant', window, logs, traces, spans);
		const rows = summaryRows(analysis);

		expect(rows[0]).toStrictEqual({
			label: 'Verdict',
			value: analysis.verdict
		});
		expect(rows.map((row) => row.label)).toStrictEqual([
			'Verdict',
			'Window',
			'Invocations',
			'Traced server time',
			'Concurrency',
			'Rows read/written',
			'Errors'
		]);
	});

	it('renders an operation row with its span breakdown beneath it', () => {
		const analysis = analyse('cupboard-tenant', window, logs, traces, spans);
		const fetchGroup = analysis.groups.find((group) => group.group === 'fetch');

		expect(operationRows(fetchGroup?.operations ?? [])).toStrictEqual([
			{
				label: 'PUT /cache/:cache/uploads/:id',
				value: '1.2s · p95 800ms · 2× · 6 spans (3/call) · r/w 50/25 · 2 err'
			},
			{ label: '  ↳ outside traced leaf spans', value: '875ms' },
			{ label: '  ↳ r2_head', value: '3× · 320ms busy' },
			{ label: '  ↳ d1_run', value: '2× · 12ms busy' },
			{ label: '  ↳ durable_object_storage_exec', value: '1× · 0ms busy' },
			{
				label: 'POST /cache/:cache/uploads',
				value: '100ms · p95 100ms · 1× · 2 spans (2/call) · r/w 5/0'
			},
			{ label: '  ↳ outside traced leaf spans', value: '70ms' },
			{ label: '  ↳ r2_put', value: '1× · 30ms busy' }
		]);
	});
});

describe('triggerGroup', () => {
	it.each([
		['PUT /cache/:cache/uploads/:id', 'fetch'],
		['POST /token', 'fetch'],
		['rpc verification', 'rpc'],
		['queue', 'queue'],
		['alarm', 'alarm'],
		['scheduled', 'scheduled'],
		['verification request not enqueued', 'other']
	])('groups %s as %s', (bucket, expected) => {
		expect(triggerGroup(bucket)).toBe(expected);
	});
});

const operationStat = (
	over: Partial<OperationStat> & { bucket: string }
): OperationStat => ({
	group: 'fetch',
	traceCount: 1,
	totalMs: 0,
	p50Ms: 0,
	p95Ms: 0,
	maxMs: 0,
	logCount: 0,
	rowsRead: 0,
	rowsWritten: 0,
	errors: 0,
	spanCount: 0,
	unaccountedMs: 0,
	spans: [],
	...over
});

const fetchGroupOf = (operations: OperationStat[]): OperationGroup => ({
	group: 'fetch',
	tracedServerMs: operations.reduce((sum, o) => sum + o.totalMs, 0),
	traceCount: operations.reduce((sum, o) => sum + o.traceCount, 0),
	operations
});

describe('buildVerdict', () => {
	it('reports time outside traced leaf spans when it dominates', () => {
		const roots = operationStat({
			bucket: 'PUT /cache/:cache/roots/:name',
			traceCount: 10,
			totalMs: 412_000,
			p95Ms: 408_000,
			unaccountedMs: 411_000,
			spans: [{ name: 'r2_head', count: 50, busyMs: 419 }]
		});

		expect(buildVerdict([fetchGroupOf([roots])], true)).toBe(
			'Push path: most time (412.0s over 10 calls, 100% of fetch) is PUT /cache/:cache/roots/:name, 411.0s outside traced leaf spans.'
		);
	});

	it('reports the busiest traced leaf-span kind when it dominates', () => {
		const uploads = operationStat({
			bucket: 'POST /cache/:cache/uploads',
			totalMs: 5000,
			unaccountedMs: 100,
			spans: [{ name: 'r2_head', count: 634, busyMs: 4800 }]
		});

		expect(buildVerdict([fetchGroupOf([uploads])], true)).toBe(
			'Push path: most time (5.0s over 1 calls, 100% of fetch) is POST /cache/:cache/uploads, 4.8s in r2_head (634 calls).'
		);
	});

	it('explains an empty window', () => {
		expect(buildVerdict([], true)).toBe('No trace has a positive duration.');
	});
});

const noteBody = (rows: readonly ResultRow[]): string =>
	rows.map((row) => `${row.label}\t${row.value}`).join('\n');

describe('renderAnalysis', () => {
	const operations = [
		operationStat({
			bucket: 'PUT /cache/:cache/roots/:name',
			totalMs: 400,
			p95Ms: 400,
			unaccountedMs: 300,
			spans: [{ name: 'r2_head', count: 2, busyMs: 100 }]
		})
	];

	const analysis: Analysis = {
		worker: 'cupboard-tenant',
		window: { from: 0, to: 10_000 },
		invocations: 1,
		tracedServerMs: 400,
		wallSpanMs: 10_000,
		tracingAvailable: true,
		verdict: 'fine',
		groups: [fetchGroupOf(operations)],
		slowest: [
			{
				traceId: 't1',
				bucket: 'PUT /cache/:cache/roots/:name',
				durationMs: 400,
				spans: 3,
				startMs: 0,
				errors: []
			}
		],
		traceErrors: [],
		totals: { rowsRead: 20, rowsWritten: 10, errors: 0 }
	};

	it('writes the analysis alone to stdout in JSON mode', () => {
		const { ui, captured } = fakeCliUi();

		renderAnalysis(ui, ui.reporter(), 'json', analysis);

		expect(captured.data).toStrictEqual([JSON.stringify(analysis)]);
		expect(captured.results).toStrictEqual([]);
		expect(captured.notes).toStrictEqual([]);
	});

	it('renders the result card and notes in terminal mode', () => {
		const { ui, captured } = fakeCliUi();

		renderAnalysis(ui, ui.reporter(), 'terminal', analysis);

		expect(captured.data).toStrictEqual([]);
		expect(captured.results).toStrictEqual([
			{
				kind: 'push-diagnostic',
				data: analysis,
				rows: summaryRows(analysis)
			}
		]);
		expect(captured.notes).toStrictEqual([
			{
				title: 'fetch · 400ms · 1 traced',
				body: noteBody(operationRows(operations))
			},
			{
				title: 'Slowest invocations',
				body: noteBody(slowestRows(analysis))
			}
		]);
	});
});
