export interface TraceContext {
	readonly traceId?: string;
	readonly spanId?: string;
}

export function stampTraceContext(): TraceContext {
	return {};
}
