import { traceLogFields } from '@cupboard/shared/log-context';
import { type SpanContext, trace } from '@opentelemetry/api';
import { runInDurableObject } from 'cloudflare:test';
import { tracing } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { currentServer, initialise, resetTestServer } from '../test-support.ts';

import { annotateActiveSpan, withSpan } from './span.ts';
import { hasNativeTracing } from './workers-otel-bridge.ts';

// These tests run the Workers tracing bridge that the Worker entrypoints
// register, against the runtime's native spans. They must not call
// `recordSpans()`, which replaces the bridge for the rest of the isolate.

const invalidTraceId = '0'.repeat(32);

interface Observed {
	readonly root: SpanContext | undefined;
	readonly outer: SpanContext | undefined;
	readonly inner: SpanContext | undefined;
	readonly isRecording: boolean | undefined;
	readonly logFields: Record<string, string>;
}

describe('Workers tracing bridge', () => {
	beforeEach(async () => {
		await resetTestServer();
		await initialise();
	});

	it('runs on a runtime with every native tracing API', () => {
		expect(hasNativeTracing()).toBe(true);
	});

	it('opens native spans beneath the invocation and exposes them to logs', async () => {
		const observed = await runInDurableObject(currentServer(), () => {
			const root = tracing.getActiveSpan()?.spanContext();

			return withSpan('outer', { 'test.attribute': 1 }, async () => {
				const outer = trace.getActiveSpan();
				annotateActiveSpan({ 'test.annotation': true });
				const inner = await withSpan('inner', {}, () =>
					Promise.resolve(trace.getActiveSpan()?.spanContext())
				);

				return {
					root,
					outer: outer?.spanContext(),
					inner,
					isRecording: outer?.isRecording(),
					logFields: traceLogFields()
				} satisfies Observed;
			});
		});

		const traceId = observed.root?.traceId;
		expect({
			isTraced: traceId !== undefined && traceId !== invalidTraceId,
			isRecording: observed.isRecording,
			sameTrace: [observed.outer?.traceId, observed.inner?.traceId],
			distinctSpans: new Set([
				observed.root?.spanId,
				observed.outer?.spanId,
				observed.inner?.spanId
			]).size,
			logFields: observed.logFields
		}).toStrictEqual({
			isTraced: true,
			isRecording: true,
			sameTrace: [traceId, traceId],
			distinctSpans: 3,
			logFields: {
				trace_id: traceId,
				span_id: observed.outer?.spanId,
				trace_flags: '00'
			}
		});
	});

	it('propagates a failure from a native span once', async () => {
		let calls = 0;
		let isRecording: boolean | undefined;
		const failure = new RangeError('boom');

		const rejection = await runInDurableObject(currentServer(), async () => {
			try {
				await withSpan('failing', {}, () => {
					calls += 1;
					isRecording = trace.getActiveSpan()?.isRecording();
					return Promise.reject(failure);
				});
			} catch (error: unknown) {
				return error;
			}

			return;
		});

		expect({ rejection, calls, isRecording }).toStrictEqual({
			rejection: failure,
			calls: 1,
			isRecording: true
		});
	});
});
