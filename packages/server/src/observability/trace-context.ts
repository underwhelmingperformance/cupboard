import { defaultTextMapGetter, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

import type { SpanAttributes } from './span.ts';

const propagator = new W3CTraceContextPropagator();

/**
Extracts upstream trace identifiers for correlation with native Worker spans.
These attributes do not change the parent of a native Worker span.
*/
export function upstreamTraceAttributes(headers: Headers): SpanAttributes {
	const clientTraceId = headers.get('x-cupboard-client-trace-id');
	const clientSpanId = headers.get('x-cupboard-client-span-id');
	const forwarded =
		clientTraceId === null || clientSpanId === null
			? undefined
			: `00-${clientTraceId}-${clientSpanId}-00`;
	const context = propagator.extract(
		ROOT_CONTEXT,
		{
			traceparent: headers.get('traceparent') ?? forwarded
		},
		defaultTextMapGetter
	);
	const upstream = trace.getSpanContext(context);
	if (upstream === undefined) {
		return {};
	}
	return {
		'cupboard.upstream.trace_id': upstream.traceId,
		'cupboard.upstream.span_id': upstream.spanId
	};
}
