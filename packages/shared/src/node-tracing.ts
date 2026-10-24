import {
	type Attributes,
	context,
	logs,
	propagation,
	ROOT_CONTEXT,
	type Span,
	SpanStatusCode,
	trace
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { NoopSpanProcessor } from '@opentelemetry/sdk-trace';

import {
	initialiseHttpDiagnostics,
	stopHttpDiagnostics
} from './node-http-diagnostics.ts';

export { httpDiagnosticCounters } from './node-http-diagnostics.ts';

class NodeTracingRuntime {
	#sdk: NodeSDK | undefined;

	initialise(): void {
		if (this.#sdk !== undefined) {
			return;
		}

		const sdk = new NodeSDK({
			autoDetectResources: false,
			// NodeSDK registers a tracer provider only when it has a span processor.
			spanProcessors: [new NoopSpanProcessor()],
			logRecordProcessors: [],
			metricReaders: [],
			textMapPropagator: new W3CTraceContextPropagator()
		});
		sdk.start();
		this.#sdk = sdk;
		initialiseHttpDiagnostics();
	}

	async stop(): Promise<void> {
		if (this.#sdk === undefined) {
			return;
		}

		stopHttpDiagnostics();

		try {
			await this.#sdk.shutdown();
		} finally {
			context.disable();
			propagation.disable();
			trace.disable();
			logs.disable();
			this.#sdk = undefined;
		}
	}
}

const runtime = new NodeTracingRuntime();

/**
Initialises trace contexts for the CLI and action processes.
*/
export function initialiseTracing(): void {
	runtime.initialise();
}

/**
Removes process tracing context and diagnostic subscriptions.
*/
export function stopTracing(): Promise<void> {
	return runtime.stop();
}

/**
Runs an entrypoint in its own span, optionally continuing an owning subprocess.
*/
export async function traceOperation<T>(
	operation: string,
	run: (span: Span) => Promise<T>,
	attributes: Attributes = {}
): Promise<T> {
	const parent =
		trace.getSpanContext(context.active()) === undefined
			? propagation.extract(ROOT_CONTEXT, {
					traceparent: process.env.CUPBOARD_TRACEPARENT
				})
			: context.active();

	return trace
		.getTracer('cupboard')
		.startActiveSpan(operation, { attributes }, parent, async (span) => {
			try {
				return await run(span);
			} catch (error) {
				span.setStatus({ code: SpanStatusCode.ERROR });
				throw error;
			} finally {
				span.end();
			}
		});
}

/**
Supplies trace context only to subprocesses owned by Cupboard.
*/
export function subprocessTraceEnvironment(): Record<string, string> {
	const headers: Record<string, string> = {};
	propagation.inject(context.active(), headers);

	return headers.traceparent === undefined
		? {}
		: { CUPBOARD_TRACEPARENT: headers.traceparent };
}
