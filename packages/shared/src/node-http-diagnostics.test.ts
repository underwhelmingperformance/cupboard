import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';

import { configureSync, resetSync, withContext } from '@logtape/logtape';
import { context, trace } from '@opentelemetry/api';
import { StatusCodes } from 'http-status-codes';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { traceLogFields } from './log-context.ts';
import { httpDiagnosticCounters } from './node-http-diagnostics.ts';
import { initialiseTracing, stopTracing } from './node-tracing.ts';
import { retryingFetcher } from './retry.ts';

interface CapturedEvent {
	readonly properties: Record<string, unknown>;
}

afterEach(async () => {
	await stopTracing();
	resetSync();
	vi.restoreAllMocks();
});

function carrierFields(carrier: string): Record<string, unknown> {
	const [, traceId, spanId, flags] = carrier.split('-', 4);

	return { trace_id: traceId, span_id: spanId, trace_flags: flags };
}

describe('Node HTTP diagnostics', () => {
	it('restores each request context and clears request context for connection events', async () => {
		const records: CapturedEvent[] = [];
		vi.spyOn(performance, 'now').mockReturnValue(0);
		configureSync({
			contextLocalStorage: new AsyncLocalStorage<Record<string, unknown>>(),
			sinks: {
				capture: (record) => {
					if (record.category.join('.') === 'cupboard.http.undici') {
						records.push({
							properties: { ...record.properties, ...traceLogFields() }
						});
					}
				}
			},
			loggers: [
				{ category: ['cupboard'], sinks: ['capture'], lowestLevel: 'trace' },
				{
					category: ['logtape', 'meta'],
					sinks: ['capture'],
					lowestLevel: 'warning'
				}
			]
		});
		withContext({ requestId: 'initialisation' }, initialiseTracing);
		const before = httpDiagnosticCounters();
		const first = Promise.withResolvers<Response>();
		const second = Promise.withResolvers<Response>();
		const requests = [
			{ origin: 'https://cupboard.example.test', path: '/api', method: 'GET' },
			{
				origin: 'https://redirect.example.test',
				path: '/object?token=private',
				method: 'POST'
			}
		];
		const carriers: string[] = [];
		const start = (
			index: number,
			operation: string,
			completed: Promise<Response>
		): Promise<Response> =>
			retryingFetcher(
				(_input, init) => {
					carriers[index] = new Headers(init?.headers).get('traceparent') ?? '';
					channel('undici:request:create').publish({
						request: requests[index]
					});
					return completed;
				},
				'replay-unsafe',
				{ operation, trustedOrigin: 'https://cupboard.example.test' }
			)('https://cupboard.example.test/api', { redirect: 'manual' });
		const pending = [
			start(0, 'first', first.promise),
			start(1, 'second', second.promise)
		];
		const wrongSpan = trace.getTracer('test').startSpan('unrelated request');
		const connectionError = new Error('connect failed');

		context.with(trace.setSpan(context.active(), wrongSpan), () => {
			withContext({ requestId: 'wrong request', attempt: 99 }, () => {
				for (const [index, request] of requests.entries()) {
					channel('undici:client:sendHeaders').publish({ request });
					channel('undici:request:headers').publish({
						request,
						response: {
							statusCode: StatusCodes.OK,
							headers: [
								Buffer.from('x-request-id'),
								Buffer.from(`server-${String(index)}`)
							]
						}
					});
					channel('undici:request:trailers').publish({ request });
					channel('undici:request:error').publish({
						request,
						error: new Error('late duplicate')
					});
				}

				channel('undici:client:connectError').publish({
					connectParams: {
						hostname: 'cupboard.example.test',
						protocol: 'https:',
						port: 443,
						password: 'never log this'
					},
					error: connectionError
				});
			});
		});
		wrongSpan.end();
		first.resolve(new Response(undefined));
		second.resolve(new Response(undefined));
		await Promise.all(pending);
		const expected: CapturedEvent[] = [];
		const fields = (index: number): Record<string, unknown> => ({
			operation: index === 0 ? 'first' : 'second',
			method: index === 0 ? 'GET' : 'POST',
			url:
				index === 0
					? 'https://cupboard.example.test/api'
					: 'https://redirect.example.test/object',
			attempt: 1,
			replaySafety: 'replay-unsafe',
			transportRequestId: before.requests + index + 1,
			...carrierFields(carriers[index] ?? '')
		});

		for (const index of [0, 1]) {
			expected.push({
				properties: { ...fields(index), event: 'created', elapsedMs: 0 }
			});
		}

		for (const index of [0, 1]) {
			expected.push(
				{
					properties: { ...fields(index), event: 'sendHeaders', elapsedMs: 0 }
				},
				{
					properties: {
						...fields(index),
						event: 'headers',
						elapsedMs: 0,
						statusCode: StatusCodes.OK,
						requestId: `server-${String(index)}`
					}
				},
				{
					properties: {
						...fields(index),
						event: 'trailers',
						elapsedMs: 0,
						statusCode: StatusCodes.OK,
						requestId: `server-${String(index)}`
					}
				}
			);
		}

		expected.push({
			properties: {
				event: 'connectError',
				hostname: 'cupboard.example.test',
				protocol: 'https:',
				port: 443,
				error: connectionError
			}
		});
		const after = httpDiagnosticCounters();

		expect({
			records,
			propagated: carriers.map((carrier) =>
				/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u.test(carrier)
			),
			counters: {
				requests: after.requests - before.requests,
				completed: after.completed - before.completed,
				transportErrors: after.transportErrors - before.transportErrors,
				instrumentationFailures:
					after.instrumentationFailures - before.instrumentationFailures
			}
		}).toStrictEqual({
			records: expected,
			propagated: [true, true],
			counters: {
				requests: 2,
				completed: 2,
				transportErrors: 0,
				instrumentationFailures: 0
			}
		});
	});
});
