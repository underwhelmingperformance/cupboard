import { redactText } from '@cupboard/logger';
import { telemetryErrorText } from '@cupboard/shared/errors';
import {
	type Attributes,
	type Exception,
	type Span,
	SpanStatusCode,
	trace
} from '@opentelemetry/api';

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

const maximumCauses = 5;

function describeValue(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}

	// JSON has no form for these.
	if (
		value === undefined ||
		typeof value === 'function' ||
		typeof value === 'symbol'
	) {
		return typeof value;
	}

	return JSON.stringify(value);
}

function causeTexts(error: Error): string[] {
	const texts: string[] = [];
	const seen = new Set<unknown>([error]);
	let current: unknown = error.cause;

	while (
		current !== undefined &&
		!seen.has(current) &&
		texts.length < maximumCauses
	) {
		seen.add(current);

		if (!(current instanceof Error)) {
			texts.push(describeValue(current));
			break;
		}

		texts.push(`${current.name}: ${telemetryErrorText(current).message}`);
		current = current.cause;
	}

	return texts;
}

/**
The exception event of `error`, redacted and bounded as the logs are. The
message ends with up to five causes, so a failed statement shows its driver's
error. A failed Drizzle statement keeps its SQL text and drops its bound
parameters.
*/
function spanException(error: unknown): Exception {
	try {
		if (!(error instanceof Error)) {
			return redactText(describeValue(error));
		}

		const { message, stack } = telemetryErrorText(error);

		return {
			name: error.name,
			message: redactText([message, ...causeTexts(error)].join(' <- ')),
			...(stack !== undefined && { stack: redactText(stack) })
		};
	} catch {
		// Telemetry must never replace the error that the Worker throws.
		return 'The error could not be described.';
	}
}

/**
Marks `span` as failed with `error`: its type as `error.type`, an error status
and an exception event.
*/
export function recordSpanError(span: Span, error: unknown): void {
	span.setAttribute(
		'error.type',
		error instanceof Error ? error.name : 'Error'
	);
	span.setStatus({ code: SpanStatusCode.ERROR });
	span.recordException(spanException(error));
}

/**
Records an error that the Worker handled as an exception event on the active
span. The span's operation can still succeed, so the span is not marked as
failed.
*/
export function recordHandledError(error: unknown): void {
	trace.getActiveSpan()?.recordException(spanException(error));
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
				recordSpanError(span, error);

				throw error;
			} finally {
				span.end();
			}
		}
	);
}
