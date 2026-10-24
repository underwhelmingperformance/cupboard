import process from 'node:process';

import {
	context,
	logs,
	propagation,
	ROOT_CONTEXT,
	trace
} from '@opentelemetry/api';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { initialiseTracing } from './node-tracing.ts';

const originalEnvironment = process.env;

beforeEach(() => {
	process.env = { ...originalEnvironment };
	delete process.env.OTEL_TRACES_SAMPLER;
	delete process.env.OTEL_TRACES_SAMPLER_ARG;
	delete process.env.OTEL_ATTRIBUTE_COUNT_LIMIT;
	delete process.env.OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT;
});

afterEach(() => {
	trace.disable();
	context.disable();
	propagation.disable();
	logs.disable();
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
