import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { NoopSpanProcessor } from '@opentelemetry/sdk-trace';

/**
Initialises trace contexts for the CLI and action processes.
*/
export function initialiseTracing(): void {
	new NodeSDK({
		autoDetectResources: false,
		// NodeSDK registers a tracer provider only when it has a span processor.
		spanProcessors: [new NoopSpanProcessor()],
		logRecordProcessors: [],
		metricReaders: [],
		textMapPropagator: new W3CTraceContextPropagator()
	}).start();
}
