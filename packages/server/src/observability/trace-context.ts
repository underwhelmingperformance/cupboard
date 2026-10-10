import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

import type { SpanAttributes } from './span.ts';

const propagator = new W3CTraceContextPropagator();

/**
 * Extracts upstream trace identifiers for correlation with native Worker spans.
 * These attributes do not change the parent of a native Worker span.
 */
export function upstreamTraceAttributes(headers: Headers): SpanAttributes {
	const context = propagator.extract(ROOT_CONTEXT, headers, {
		keys: (carrier: Headers) => {
			const keys: string[] = [];
			for (const key of carrier.keys()) {
				keys.push(key);
			}
			return keys;
		},
		get: (carrier: Headers, key) => carrier.get(key) ?? undefined
	});
	const upstream = trace.getSpanContext(context);
	if (upstream === undefined) {
		return {};
	}
	return {
		'cupboard.upstream.trace_id': upstream.traceId,
		'cupboard.upstream.span_id': upstream.spanId
	};
}
