import { context, isSpanContextValid, trace } from '@opentelemetry/api';

/**
Returns the active local identity using OTel's JSON log field conventions.
*/
export function traceLogFields(): Record<string, string> {
	const span = trace.getSpanContext(context.active());
	if (span === undefined || !isSpanContextValid(span)) {
		return {};
	}
	return {
		trace_id: span.traceId,
		span_id: span.spanId,
		trace_flags: span.traceFlags.toString(16).padStart(2, '0')
	};
}
