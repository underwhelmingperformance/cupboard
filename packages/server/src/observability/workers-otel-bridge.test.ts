import { AsyncLocalStorage } from 'node:async_hooks';

import { traceLogFields } from '@cupboard/shared/log-context';
import { context, SpanKind, trace } from '@opentelemetry/api';
import { afterAll, describe, expect, it, vi } from 'vitest';

interface NativeSpanContext {
	readonly traceId: string;
	readonly spanId: string;
	readonly traceFlags: number;
}

/**
Records what the bridge does with a native span, in place of the Workers
runtime's `Span`.
*/
class FakeNativeSpan {
	readonly isTraced = true;
	readonly attributes: Record<string, boolean | number | string> = {};
	readonly exceptions: unknown[] = [];
	isEnded = false;

	constructor(
		public name: string,
		readonly ids: NativeSpanContext,
		readonly parentSpanId: string | undefined
	) {}

	spanContext(): NativeSpanContext {
		return this.ids;
	}

	setAttribute(key: string, value: boolean | number | string): this {
		this.attributes[key] = value;
		return this;
	}

	setAttributes(
		attributes: Record<string, boolean | number | string | undefined>
	): this {
		for (const [key, value] of Object.entries(attributes)) {
			if (value !== undefined) {
				this.attributes[key] = value;
			}
		}
		return this;
	}

	recordException(exception: unknown): void {
		this.exceptions.push(exception);
	}

	updateName(name: string): this {
		this.name = name;
		return this;
	}

	setStatus(): this {
		return this;
	}

	end(): void {
		this.isEnded = true;
	}
}

// The fake runtime's native span tree: each span is active while its callback
// runs, as `tracing.startActiveSpan` makes it in the Workers runtime.
const native = vi.hoisted(() => ({
	spans: [] as FakeNativeSpan[],
	nextSpanId: 1
}));
const activeNative = new AsyncLocalStorage<FakeNativeSpan>();

function childOf(
	name: string,
	parent: FakeNativeSpan | undefined
): FakeNativeSpan {
	const spanId = native.nextSpanId.toString(16).padStart(16, '0');
	native.nextSpanId += 1;
	const span = new FakeNativeSpan(
		name,
		{
			traceId: parent?.ids.traceId ?? 'a'.repeat(32),
			spanId,
			traceFlags: 1
		},
		parent?.ids.spanId
	);
	native.spans.push(span);
	return span;
}

vi.mock('cloudflare:workers', () => ({
	tracing: {
		Span: FakeNativeSpan,
		getActiveSpan: () => activeNative.getStore(),
		startSpan: (name: string) => childOf(name, activeNative.getStore()),
		startActiveSpan: <T>(
			name: string,
			callback: (span: FakeNativeSpan) => T
		): T => {
			const span = childOf(name, activeNative.getStore());
			return activeNative.run(span, () => callback(span));
		}
	}
}));

const { tracing } = await import('cloudflare:workers');
const { hasNativeTracing, registerWorkersTracing } =
	await import('./workers-otel-bridge.ts');
const { withSpan } = await import('./span.ts');

/**
Runs `body` as one Worker invocation, whose root span the runtime opens.
*/
function invocation<T>(body: () => T): T {
	return activeNative.run(childOf('fetch', undefined), body);
}

function nativeSpan(name: string): FakeNativeSpan | undefined {
	return native.spans.find((span) => span.name === name);
}

const provider = registerWorkersTracing();

afterAll(() => {
	trace.disable();
	context.disable();
});

describe('Workers tracing bridge', () => {
	it('registers once and returns the same provider when called again', () => {
		expect(registerWorkersTracing()).toBe(provider);
	});

	it('reports a runtime without every native tracing API', () => {
		const getActiveSpan = Reflect.get(tracing, 'getActiveSpan');
		Reflect.deleteProperty(tracing, 'getActiveSpan');
		try {
			expect(hasNativeTracing()).toBe(false);
		} finally {
			Reflect.set(tracing, 'getActiveSpan', getActiveSpan);
		}
		expect(hasNativeTracing()).toBe(true);
	});

	it('opens nested native spans with their attributes and ends them', async () => {
		await invocation(() =>
			withSpan('outer', { label: 'first', skipped: undefined }, () =>
				withSpan('inner', {}, (span) => {
					span.setAttribute('count', 2);
					return Promise.resolve();
				})
			)
		);

		const root = native.spans.find((span) => span.name === 'fetch');
		const outer = nativeSpan('outer');
		const inner = nativeSpan('inner');
		expect({
			outer: {
				parent: outer?.parentSpanId,
				attributes: outer?.attributes,
				isEnded: outer?.isEnded
			},
			inner: {
				parent: inner?.parentSpanId,
				attributes: inner?.attributes,
				isEnded: inner?.isEnded
			}
		}).toStrictEqual({
			outer: {
				parent: root?.ids.spanId,
				attributes: { label: 'first' },
				isEnded: true
			},
			inner: {
				parent: outer?.ids.spanId,
				attributes: { count: 2 },
				isEnded: true
			}
		});
	});

	it('exposes the active native span to the OTel API and log fields', async () => {
		const observed = await invocation(() =>
			withSpan('observed', {}, () =>
				Promise.resolve({
					context: trace.getActiveSpan()?.spanContext(),
					fields: traceLogFields()
				})
			)
		);

		const span = nativeSpan('observed');
		expect(observed).toStrictEqual({
			context: { ...span?.ids },
			fields: {
				trace_id: span?.ids.traceId,
				span_id: span?.ids.spanId,
				trace_flags: '01'
			}
		});
	});

	it('propagates a failure once and ends the span with its error type', async () => {
		const body = vi.fn(() => Promise.reject(new RangeError('boom')));

		await expect(
			invocation(() => withSpan('failing', {}, body))
		).rejects.toThrow('boom');

		const span = nativeSpan('failing');
		expect({
			calls: body.mock.calls.length,
			attributes: span?.attributes,
			isEnded: span?.isEnded
		}).toStrictEqual({
			calls: 1,
			attributes: { 'error.type': 'RangeError' },
			isEnded: true
		});
	});

	it('creates no native span for a span kind the runtime cannot represent', () => {
		const span = invocation(() =>
			trace.getTracer('test').startSpan('client', { kind: SpanKind.CLIENT })
		);

		expect({
			isRecording: span.isRecording(),
			native: nativeSpan('client')
		}).toStrictEqual({ isRecording: false, native: undefined });
	});

	// Some hibernatable WebSocket events have a native parent that the runtime
	// does not expose through `getActiveSpan()`, so default creation leaves the
	// parent to the runtime.
	it('leaves the parent to the runtime when no native span is exposed', async () => {
		const isRecording = await withSpan('ambient', {}, (span) =>
			Promise.resolve(span.isRecording())
		);
		const span = nativeSpan('ambient');

		expect({
			isRecording,
			parent: span?.parentSpanId,
			isEnded: span?.isEnded
		}).toStrictEqual({ isRecording: true, parent: undefined, isEnded: true });
	});
});
