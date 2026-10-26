import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, onTestFinished } from 'vitest';

import {
	analyseClientLogs,
	type ClientLogCollection,
	clientLogWindow,
	discoverLogArtifacts,
	readClientLogs,
	selectClientTelemetry
} from './diagnostic-client-logs.ts';

function collection(
	records: readonly Record<string, unknown>[]
): ClientLogCollection {
	return {
		files: 1,
		records,
		incompleteFiles: [],
		unreadableFiles: [],
		truncated: false
	};
}

describe('client diagnostic logs', () => {
	it('keeps transport operations separate from logical probe results and old unknown failures', () => {
		const result = analyseClientLogs(
			collection([
				{ msg: 'probe attempt finished', outcome: 'timed out' },
				{ msg: 'probe attempt finished', outcome: 'timed out' },
				{ msg: 'HTTP operation failed', disposition: 'deadline' },
				{ msg: 'HTTP operation completed', disposition: 'recovered' },
				{ msg: 'HTTP attempt failed' },
				{ msg: 'HTTP attempt failed', failureKind: 'transport' },
				{ msg: 'HTTP attempt failed', failureKind: 'deadline' },
				{ msg: 'HTTP attempt failed', failureKind: 'cancelled' },
				{ msg: 'HTTP attempt started' },
				{ msg: 'HTTP attempt started' },
				{ msg: 'HTTP attempt started' },
				{ msg: 'HTTP attempt started' },
				{ msg: 'logical probe finished', disposition: 'recovered' },
				{ msg: 'logical probe finished', disposition: 'exhausted' },
				{ msg: 'logical probe finished', disposition: 'cancelled' }
			]),
			[]
		);
		expect(result).toStrictEqual({
			files: 1,
			records: 15,
			incompleteFiles: [],
			unreadableFiles: [],
			truncated: false,
			attempts: 4,
			responses: 0,
			transportFailures: 2,
			bodyFailures: 0,
			recoveredOperations: 1,
			exhaustedOperations: 0,
			cancelledOperations: 0,
			deadlineOperations: 1,
			attemptDeadlines: 2,
			httpAttemptDeadlines: 1,
			httpAttemptCancellations: 1,
			unclassifiedTransportFailures: 1,
			logicalProbes: {
				succeeded: 0,
				recovered: 1,
				exhausted: 1,
				cancelled: 1,
				failed: 0,
				unknown: 0
			},
			droppedRecords: 0,
			transportFailureFraction: 0.5,
			refusalFraction: undefined,
			correlation: {
				requestId: 0,
				ray: 0,
				untrustedClientParent: 0,
				pathTimeCandidate: 0,
				unmatched: 4
			},
			caveats: [
				'server-telemetry',
				'untrusted-client-parent',
				'path-and-time',
				'client-log-coverage'
			]
		});
	});

	it('follows a no-response client attempt across both Workers without selecting a concurrent job', () => {
		const client = collection([
			{ msg: 'HTTP attempt failed', trace_id: 'client', span_id: 'attempt' }
		]);
		const control = {
			source: {
				clientTraceId: 'client',
				clientSpanId: 'attempt',
				requestId: 'shared'
			},
			$metadata: { service: 'cupboard', traceId: 'control' }
		};
		const tenant = {
			source: { requestId: 'shared' },
			$metadata: { service: 'cupboard-tenant', traceId: 'tenant' }
		};
		const late = {
			source: { msg: 'storage request completed after timeout' },
			$metadata: { traceId: 'tenant' }
		};
		const unrelated = {
			source: {
				clientTraceId: 'client',
				clientSpanId: 'other',
				requestId: 'other'
			},
			$metadata: { traceId: 'unrelated' }
		};
		expect(
			selectClientTelemetry(
				client,
				[late, unrelated, tenant, control],
				[
					{ traceId: 'control' },
					{ traceId: 'tenant' },
					{ traceId: 'unrelated' }
				]
			)
		).toStrictEqual({
			events: [late, tenant, control],
			traces: [{ traceId: 'control' }, { traceId: 'tenant' }],
			selection: {
				kind: 'client-identifiers',
				matchedBy: { requestId: 0, ray: 0, untrustedClientParent: 1 },
				excludedEvents: 1,
				excludedTraces: 1
			}
		});
	});

	it('selects one client across overlapping jobs and long quiet intervals', () => {
		const client = collection([
			{ requestId: 'server-request', timestamp: 1000 },
			{ cfRay: '0123456789abcdef-LHR', timestamp: 100_000 },
			{ trace_id: 'client-trace', span_id: 'client-span' }
		]);
		const first = {
			source: { requestId: 'server-request' },
			$metadata: { traceId: 'native-first' },
			timestamp: 1000
		};
		const concurrent = {
			source: { requestId: 'another-client', method: 'POST', path: '/roots' },
			$metadata: { traceId: 'native-other' },
			timestamp: 1000
		};
		const delayed = {
			source: { msg: 'late storage completion' },
			$metadata: { traceId: 'native-first' },
			timestamp: 100_000
		};
		const viaRay = {
			source: { ray: '0123456789abcdef' },
			$metadata: { traceId: 'native-ray' }
		};
		const viaParent = {
			source: {
				'cupboard.upstream.trace_id': 'client-trace',
				'cupboard.upstream.span_id': 'client-span'
			},
			$metadata: { traceId: 'native-parent' }
		};
		const traces = [
			{ traceId: 'native-first' },
			{ traceId: 'native-other' },
			{ traceId: 'native-ray' },
			{ traceId: 'native-parent' },
			{ traceId: 'client-trace' }
		];

		expect(
			selectClientTelemetry(
				client,
				[first, concurrent, delayed, viaRay, viaParent],
				traces
			)
		).toStrictEqual({
			events: [first, delayed, viaRay, viaParent],
			traces: [traces[0], traces[2], traces[3]],
			selection: {
				kind: 'client-identifiers',
				matchedBy: { requestId: 1, ray: 1, untrustedClientParent: 1 },
				excludedEvents: 1,
				excludedTraces: 2
			}
		});
	});

	it('does not substitute time or path matches when client identifiers are absent', () => {
		expect(
			selectClientTelemetry(
				collection([
					{
						timestamp: 1000,
						method: 'POST',
						url: 'https://cupboard.example.test/roots'
					}
				]),
				[{ timestamp: 1000, source: { method: 'POST', path: '/roots' } }],
				[{ traceId: 'unrelated' }]
			)
		).toStrictEqual({
			events: [],
			traces: [],
			selection: {
				kind: 'client-identifiers',
				matchedBy: { requestId: 0, ray: 0, untrustedClientParent: 0 },
				excludedEvents: 1,
				excludedTraces: 1
			}
		});
	});

	it('follows native identifier connections transitively in any event order', () => {
		const anchor = {
			source: { requestId: 'owned' },
			$metadata: { requestId: 'native-request' }
		};
		const connection = {
			$metadata: { requestId: 'native-request', traceId: 'native-trace' }
		};
		const span = { $metadata: { traceId: 'native-trace' } };
		const unrelated = { $metadata: { traceId: 'native-request' } };
		const traces = [{ traceId: 'native-trace' }, { traceId: 'native-request' }];

		expect(
			selectClientTelemetry(
				collection([{ requestId: 'owned' }]),
				[span, unrelated, connection, anchor],
				traces
			)
		).toStrictEqual({
			events: [span, connection, anchor],
			traces: [traces[0]],
			selection: {
				kind: 'client-identifiers',
				matchedBy: { requestId: 1, ray: 0, untrustedClientParent: 0 },
				excludedEvents: 1,
				excludedTraces: 1
			}
		});
	});

	it('uses client timestamps only to bound the query, with a clock-skew allowance', () => {
		expect(
			clientLogWindow(
				collection([
					{ timestamp: 1000 },
					{ timestamp: 100_000 },
					{ timestamp: 'invalid' }
				])
			)
		).toStrictEqual({ from: -59_000, to: 160_000 });
		expect(clientLogWindow(collection([]))).toBeUndefined();
	});

	it('reads compressed rotations and reports incomplete and unreadable files', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-client-logs-')
		);
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		await mkdir(path.join(directory, 'nested'));
		await writeFile(
			path.join(directory, 'a.jsonl.gz.1'),
			gzipSync('{"msg":"rotated"}\n')
		);
		await writeFile(
			path.join(directory, 'nested/b.jsonl'),
			'{"msg":"complete"}\n{"msg":'
		);
		await writeFile(
			path.join(directory, 'c.jsonl.gz'),
			gzipSync('invalid JSON\n')
		);
		await writeFile(path.join(directory, 'ignored.txt'), 'not a log');

		expect(await readClientLogs(directory)).toStrictEqual({
			files: 3,
			records: [{ msg: 'rotated' }, { msg: 'complete' }],
			incompleteFiles: ['nested/b.jsonl'],
			unreadableFiles: ['c.jsonl.gz'],
			truncated: false
		});
	});

	it('prefers response IDs, then Ray IDs, then untrusted parent attributes, then time candidates', () => {
		const records = collection([
			{
				msg: 'HTTP response headers received',
				requestId: 'request-1',
				cfRay: '0123456789abcdef-LHR',
				status: StatusCodes.OK
			},
			{
				msg: 'HTTP response headers received',
				cfRay: '0123456789abcdef-LHR',
				status: StatusCodes.SERVICE_UNAVAILABLE
			},
			{
				msg: 'HTTP attempt failed',
				trace_id: 'client-trace',
				span_id: 'client-span'
			},
			{
				msg: 'HTTP attempt failed',
				method: 'POST',
				url: 'https://cupboard.example.test/t/acme/roots',
				timestamp: 1000
			},
			{
				msg: 'HTTP attempt failed',
				method: 'POST',
				url: 'https://cupboard.example.test/t/acme/roots',
				timestamp: 20_000
			},
			{ msg: 'HTTP attempt started' },
			{ msg: 'HTTP attempt started' },
			{ msg: 'HTTP attempt started' },
			{ msg: 'HTTP attempt started' },
			{ msg: 'HTTP attempt started' },
			{ msg: 'HTTP response body failed' },
			{ msg: 'HTTP operation completed', disposition: 'recovered' },
			{ msg: 'HTTP operation failed', disposition: 'exhausted' },
			{ msg: 'HTTP operation failed', disposition: 'cancelled' },
			{ msg: 'diagnostic records dropped', droppedRecords: 3 }
		]);
		const result = analyseClientLogs(records, [
			{
				timestamp: 4000,
				source: {
					requestId: 'request-1',
					ray: '0123456789abcdef',
					clientTraceId: 'client-trace',
					clientSpanId: 'client-span',
					method: 'POST',
					path: '/roots'
				}
			}
		]);

		expect(result).toStrictEqual({
			files: 1,
			records: 15,
			incompleteFiles: [],
			unreadableFiles: [],
			truncated: false,
			attempts: 5,
			responses: 2,
			transportFailures: 3,
			bodyFailures: 1,
			recoveredOperations: 1,
			exhaustedOperations: 1,
			cancelledOperations: 1,
			deadlineOperations: 0,
			attemptDeadlines: 0,
			httpAttemptDeadlines: 0,
			httpAttemptCancellations: 0,
			unclassifiedTransportFailures: 3,
			logicalProbes: {
				succeeded: 0,
				recovered: 0,
				exhausted: 0,
				cancelled: 0,
				failed: 0,
				unknown: 0
			},
			droppedRecords: 3,
			transportFailureFraction: 0.6,
			refusalFraction: 0.5,
			correlation: {
				requestId: 1,
				ray: 1,
				untrustedClientParent: 1,
				pathTimeCandidate: 1,
				unmatched: 2
			},
			caveats: [
				'server-telemetry',
				'untrusted-client-parent',
				'path-and-time',
				'client-log-coverage'
			]
		});
	});

	it('reports missing denominators without inventing zero failure rates', () => {
		const result = analyseClientLogs(collection([]), []);
		expect({
			transport: result.transportFailureFraction,
			refusal: result.refusalFraction
		}).toStrictEqual({ transport: undefined, refusal: undefined });
	});

	it('discovers diagnostic artifacts without inferring a job from the artifact name', async () => {
		const urls: string[] = [];
		const result = await discoverLogArtifacts(
			{ owner: 'acme', repository: 'app', runId: '123' },
			{
				fetcher: (input) => {
					urls.push(input instanceof Request ? input.url : String(input));
					return Promise.resolve(
						Response.json({
							artifacts: [
								{ id: 1, name: 'cupboard-diagnostics-job-1', expired: false },
								{ id: 2, name: 'other', expired: false }
							]
						})
					);
				}
			}
		);

		expect({ result, urls }).toStrictEqual({
			result: {
				artifacts: [
					{ id: 1, name: 'cupboard-diagnostics-job-1', expired: false }
				],
				incomplete: false
			},
			urls: [
				'https://api.github.com/repos/acme/app/actions/runs/123/artifacts?per_page=100&page=1'
			]
		});
	});

	it.each([
		{
			failure: 'invalid structure',
			kind: 'invalid-response',
			fetcher: () => Promise.resolve(Response.json({ invalid: true }))
		},
		{
			failure: 'malformed JSON',
			kind: 'invalid-response',
			fetcher: () => Promise.resolve(new Response('{'))
		},
		{
			failure: 'transport failure',
			kind: 'request-failed',
			fetcher: () => Promise.reject(new TypeError('network unavailable'))
		},
		{
			failure: 'body read failure',
			kind: 'request-failed',
			fetcher: () =>
				Promise.resolve(
					new Response(
						new ReadableStream({
							start(controller) {
								controller.error(new TypeError('body read failed'));
							}
						})
					)
				)
		}
	] as const)(
		'reports unavailable artifacts for $failure',
		async ({ kind, fetcher }) => {
			expect(
				await discoverLogArtifacts(
					{ owner: 'acme', repository: 'app', runId: '123' },
					{ fetcher }
				)
			).toStrictEqual({
				artifacts: [],
				incomplete: true,
				unavailable: { kind }
			});
		}
	);

	it.each([StatusCodes.FORBIDDEN, StatusCodes.NOT_FOUND])(
		'reports unavailable artifact coverage for HTTP %s',
		async (status) => {
			expect(
				await discoverLogArtifacts(
					{ owner: 'acme', repository: 'app', runId: '123' },
					{
						fetcher: () => Promise.resolve(new Response(undefined, { status }))
					}
				)
			).toStrictEqual({
				artifacts: [],
				incomplete: true,
				unavailable: { kind: 'http', status }
			});
		}
	);
});
