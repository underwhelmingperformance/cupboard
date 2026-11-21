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
