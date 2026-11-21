import { type Attributes, type Span, trace } from '@opentelemetry/api';

export type SpanAttributes = Readonly<
	Record<string, boolean | number | string | undefined>
>;

const tracer = trace.getTracer('cupboard');

function definedAttributes(attributes: SpanAttributes): Attributes {
	return Object.fromEntries(
		Object.entries(attributes).filter(([, value]) => value !== undefined)
	);
}

/**
Whether the active span records attributes. None does outside an invocation,
in an event whose span the runtime does not expose, after the span has ended,
or where tracing is unavailable.
*/
export function isActiveSpanRecording(): boolean {
	return trace.getActiveSpan()?.isRecording() === true;
}

/**
Sets `attributes` on the active span, which is the invocation's root span
outside any span that the Worker opens. Undefined attributes are omitted.
*/
export function annotateActiveSpan(attributes: SpanAttributes): void {
	trace.getActiveSpan()?.setAttributes(definedAttributes(attributes));
}

/**
Runs `body` inside a span beneath the active span, and ends the span when
`body` settles. Undefined attributes are omitted. The callback runs
synchronously, and still runs when no tracer provider is registered.
*/
export function withSpan<T>(
	name: string,
	attributes: SpanAttributes,
	body: (span: Span) => Promise<T>
): Promise<T> {
	return tracer.startActiveSpan(
		name,
		{ attributes: definedAttributes(attributes) },
		async (span) => {
			try {
				return await body(span);
			} catch (error) {
				span.setAttribute(
					'error.type',
					error instanceof Error ? error.name : 'Error'
				);

				throw error;
			} finally {
				span.end();
			}
		}
	);
}
