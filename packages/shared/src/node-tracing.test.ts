import process from 'node:process';

import { context, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { traceLogFields } from './log-context.ts';
import {
	initialiseTracing,
	stopTracing,
	subprocessTraceEnvironment,
	traceOperation
} from './node-tracing.ts';

const originalEnvironment = process.env;

beforeEach(() => {
	process.env = { ...originalEnvironment };
	delete process.env.OTEL_TRACES_SAMPLER;
	delete process.env.OTEL_TRACES_SAMPLER_ARG;
	delete process.env.OTEL_ATTRIBUTE_COUNT_LIMIT;
	delete process.env.OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT;
});

afterEach(async () => {
	await stopTracing();
	vi.unstubAllEnvs();
	process.env = originalEnvironment;
});

it('propagates an active W3C trace context across asynchronous work', async () => {
	process.env.OTEL_TRACES_SAMPLER = 'always_on';
	initialiseTracing();

	const parent = propagation.extract(ROOT_CONTEXT, {
		traceparent: '00-12345678901234567890123456789012-1234567890123456-01'
	});
	await trace
		.getTracer('node-tracing-test')
		.startActiveSpan('child', {}, parent, async (span) => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			const headers: Record<string, string> = {};
			propagation.inject(context.active(), headers);

			expect({ recording: span.isRecording(), headers }).toStrictEqual({
				recording: true,
				headers: {
					traceparent: `00-12345678901234567890123456789012-${span.spanContext().spanId}-01`
				}
			});

			span.end();
		});
});

it.each([
	['always_on', true],
	['always_off', false],
	['traceidratio', false]
] as const)(
	'respects the %s sampler from the environment',
	(sampler, recording) => {
		process.env.OTEL_TRACES_SAMPLER = sampler;
		process.env.OTEL_TRACES_SAMPLER_ARG = '0';
		initialiseTracing();

		const span = trace
			.getTracer('node-tracing-test')
			.startSpan('root', {}, ROOT_CONTEXT);
		expect(span.isRecording()).toBe(recording);
		span.end();
	}
);

it.each(['OTEL_ATTRIBUTE_COUNT_LIMIT', 'OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT'])(
	'respects %s from the environment',
	(variable) => {
		process.env[variable] = '1';
		initialiseTracing();

		const span = trace
			.getTracer('node-tracing-test')
			.startSpan('limited', {}, ROOT_CONTEXT);
		span.setAttribute('first', 'retained');
		span.setAttribute('second', 'discarded');
		const attributes: unknown = Reflect.get(span, 'attributes');
		expect(attributes).toStrictEqual({ first: 'retained' });
		span.end();
	}
);

describe('Node tracing', () => {
	beforeEach(() => {
		initialiseTracing();
	});

	it('continues an owning subprocess context without retaining it outside the operation', async () => {
		const parentTrace = '4bf92f3577b34da6a3ce929d0e0e4736';
		const parentSpan = '00f067aa0ba902b7';
		vi.stubEnv('CUPBOARD_TRACEPARENT', `00-${parentTrace}-${parentSpan}-01`);

		const result = await traceOperation('command', () =>
			Promise.resolve({
				fields: traceLogFields(),
				environment: subprocessTraceEnvironment()
			})
		);

		expect(result).toStrictEqual({
			fields: {
				trace_id: parentTrace,
				span_id: result.fields.span_id,
				trace_flags: '01'
			},
			environment: {
				CUPBOARD_TRACEPARENT: `00-${parentTrace}-${result.fields.span_id ?? ''}-01`
			}
		});
		expect({
			validSpan: /^[0-9a-f]{16}$/u.test(result.fields.span_id ?? ''),
			freshSpan: result.fields.span_id !== parentSpan,
			fields: traceLogFields(),
			environment: subprocessTraceEnvironment()
		}).toStrictEqual({
			validSpan: true,
			freshSpan: true,
			fields: {},
			environment: {}
		});
	});

	it('keeps independent trace context across concurrent asynchronous operations', async () => {
		const tracer = trace.getTracer('test');
		const first = tracer.startSpan('first');
		const second = tracer.startSpan('second');

		const observe = async (): Promise<Record<string, string>> => {
			await Promise.resolve();

			return traceLogFields();
		};
		const firstContext = trace.setSpan(context.active(), first);
		const secondContext = trace.setSpan(context.active(), second);
		const result = await Promise.all([
			context.with(firstContext, observe),
			context.with(secondContext, observe)
		]);

		expect(result).toStrictEqual(
			[first, second].map((span) => ({
				trace_id: span.spanContext().traceId,
				span_id: span.spanContext().spanId,
				trace_flags: span.spanContext().traceFlags.toString(16).padStart(2, '0')
			}))
		);
		expect(traceLogFields()).toStrictEqual({});

		first.end();
		second.end();
	});
});
