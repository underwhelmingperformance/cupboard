import { describe, expect, it } from 'vitest';

import {
	analyse,
	bucketForLog,
	bucketForTrace,
	buildVerdict,
	canonicalPath,
	detectSession,
	mergeBusy,
	normalisePath,
	type OperationGroup,
	operationRows,
	type OperationStat,
	parseSpanEvent,
	parseTraceSummary,
	parseWorkerLog,
	percentile,
	sliceWindow,
	type SpanEvent,
	summaryRows,
	type TimeWindow,
	type TraceSummary,
	triggerGroup,
	type WorkerLog
} from './diagnose-push.ts';

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

	it('falls back to the message', () => {
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
		// A trace's outer URL collapses to the same key as the inner DO log.
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
			errored: true
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
		// Overlapping intervals merge; the disjoint one adds on.
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
		// Two old points, a 10s gap, then a recent cluster.
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
			errored: false
		},
		{
			traceId: 't2',
			bucket: 'PUT /cache/:cache/uploads/:id',
			durationMs: 800,
			spans: 3,
			startMs: 2000,
			errored: true
		},
		{
			traceId: 't3',
			bucket: 'POST /cache/:cache/uploads',
			durationMs: 100,
			spans: 2,
			startMs: 3000,
			errored: false
		}
	];

	// A root span per trace wraps its children, so the root is a container and is
	// left out of the breakdown. The two r2_head leaves in t1 overlap, so their
	// busy time merges into one interval rather than summing.
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
		const analysis = analyse(
			'cupboard-tenant',
			window,
			'session',
			logs,
			traces,
			spans
		);

		expect(analysis.tracingAvailable).toBe(true);
		expect(analysis.tracedServerMs).toBe(1300);
		expect(analysis.invocations).toBe(3);
		expect(analysis.totals).toStrictEqual({
			rowsRead: 55,
			rowsWritten: 25,
			errors: 2
		});
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
			errored: false
		};

		const analysis = analyse(
			'cupboard-tenant',
			window,
			'session',
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
		const analysis = analyse(
			'cupboard-tenant',
			window,
			'session',
			logs,
			[],
			[]
		);

		expect(analysis.tracingAvailable).toBe(false);
		expect(analysis.verdict).toContain('No traces in the window');
	});

	it('leads the summary rows with the verdict', () => {
		const analysis = analyse(
			'cupboard-tenant',
			window,
			'session',
			logs,
			traces,
			spans
		);
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
		const analysis = analyse(
			'cupboard-tenant',
			window,
			'session',
			logs,
			traces,
			spans
		);
		const fetchGroup = analysis.groups.find((group) => group.group === 'fetch');

		expect(operationRows(fetchGroup?.operations ?? [])).toStrictEqual([
			{
				label: 'PUT /cache/:cache/uploads/:id',
				value: '1.2s · p95 800ms · 2× · 6 spans (3/call) · r/w 50/25 · 2 err'
			},
			{ label: '  ↳ unaccounted (idle/blocked/compute)', value: '875ms' },
			{ label: '  ↳ r2_head', value: '3× · 320ms busy' },
			{ label: '  ↳ d1_run', value: '2× · 12ms busy' },
			{ label: '  ↳ durable_object_storage_exec', value: '1× · 0ms busy' },
			{
				label: 'POST /cache/:cache/uploads',
				value: '100ms · p95 100ms · 1× · 2 spans (2/call) · r/w 5/0'
			},
			{ label: '  ↳ unaccounted (idle/blocked/compute)', value: '70ms' },
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
	it('blames idle/blocked time when subrequests are tiny', () => {
		const roots = operationStat({
			bucket: 'PUT /cache/:cache/roots/:name',
			traceCount: 10,
			totalMs: 412_000,
			p95Ms: 408_000,
			unaccountedMs: 411_000,
			spans: [{ name: 'r2_head', count: 50, busyMs: 419 }]
		});

		expect(buildVerdict([fetchGroupOf([roots])], true)).toBe(
			'Push path: most time (412.0s over 10 calls, 100% of fetch) is PUT /cache/:cache/roots/:name, 411.0s not in subrequests (idle/blocked/compute).'
		);
	});

	it('blames the busiest subrequest kind when it dominates', () => {
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
		expect(buildVerdict([], true)).toBe('Traces carried no duration.');
	});
});
