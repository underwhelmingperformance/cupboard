import { tracing } from 'cloudflare:workers';

export type SpanAttributes = Readonly<
	Record<string, boolean | number | string | undefined>
>;

/**
 * Runs `body` inside a Cloudflare custom span beneath the active automatic span.
 * Undefined attributes are omitted. The callback still runs when tracing does
 * not record the span.
 */
export function withSpan<T>(
	name: string,
	attributes: SpanAttributes,
	body: () => Promise<T>
): Promise<T> {
	return tracing.enterSpan(name, (span) => {
		for (const [key, value] of Object.entries(attributes)) {
			if (value !== undefined) {
				span.setAttribute(key, value);
			}
		}

		return body();
	});
}
