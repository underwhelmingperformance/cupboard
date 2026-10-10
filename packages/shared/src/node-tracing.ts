import { propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';

/**
Initialises trace contexts for the CLI and action processes.
*/
export function initialiseTracing(): void {
	trace.setGlobalTracerProvider(new BasicTracerProvider());
	propagation.setGlobalPropagator(new W3CTraceContextPropagator());
}
