import { tracing } from 'cloudflare:workers';

/**
Attribute values a span accepts; `undefined` entries are skipped.
*/
export type SpanAttributes = Readonly<
	Record<string, boolean | number | string | undefined>
>;

/**
 * Runs `body` inside a custom trace span named `name`, tagged with `attributes`.
 * The span nests under Cloudflare's automatic instrumentation and is exported to
 * the configured OTLP backend. The callback always runs, so wrapping is safe even
 * when tracing records nothing.
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
