/**
The trace-context fields available to stamp on a request logger.
*/
export interface TraceContext {
	readonly traceId?: string;
	readonly spanId?: string;
}

/**
 * The active trace context, for correlating logs with traces. Cloudflare's
 * native tracing does not yet expose the running span's `trace_id`/`span_id`
 * (`spanContext()` is planned), so this returns nothing today and the request's
 * `cf-ray` remains the correlation key. Once the runtime exposes span context,
 * fill this in and every log line gains `traceId`/`spanId` without touching the
 * call sites.
 */
export function stampTraceContext(): TraceContext {
	return {};
}
