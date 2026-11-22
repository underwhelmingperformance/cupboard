import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
	TracerProvider
} from '@opentelemetry/sdk-trace';

// The isolate's one recorder, created by the first `recordSpans()`.
const registration: { exporter?: InMemorySpanExporter } = {};

/**
Replaces the Workers tracing bridge with an in-memory OTel tracer provider for
the rest of this isolate on first use, and clears the spans that it has
recorded. The bridge sends spans to the runtime, which a test cannot read back.

Call it at the start of each test that reads spans, then read the spans that
ended since with {@link finishedSpans}.
*/
export function recordSpans(): void {
	if (registration.exporter !== undefined) {
		registration.exporter.reset();
		return;
	}

	const recorder = new InMemorySpanExporter();

	trace.disable();
	context.disable();

	if (
		!context.setGlobalContextManager(
			new AsyncLocalStorageContextManager().enable()
		) ||
		!trace.setGlobalTracerProvider(
			new TracerProvider({
				spanProcessors: [new SimpleSpanProcessor({ exporter: recorder })]
			})
		)
	) {
		throw new Error('Another OTel provider is already registered.');
	}

	registration.exporter = recorder;
}

/**
Returns the spans that ended since the last call to {@link recordSpans}, in
the order that they ended.
*/
export function finishedSpans(): readonly ReadableSpan[] {
	if (registration.exporter === undefined) {
		throw new Error('Call recordSpans() before reading spans.');
	}

	return registration.exporter.getFinishedSpans();
}
