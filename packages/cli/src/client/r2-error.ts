/**
 * R2 (and any S3-compatible endpoint) reports a failed request as an XML error
 * envelope, e.g. `<Error><Code>ExpiredRequest</Code><Message>...</Message></Error>`.
 * Parsing it into a typed value lets callers match on the error code rather than
 * grepping the raw body.
 */
export interface R2ErrorBody {
	readonly code: string;
	readonly message: string;
}

/** The R2 error code returned when a presigned URL is used past its expiry. */
export const expiredRequestCode = 'ExpiredRequest';

function extractTag(body: string, tag: string): string | undefined {
	const match = new RegExp(String.raw`<${tag}>([\s\S]*?)</${tag}>`).exec(body);

	return match?.[1];
}

/**
 * Parse an R2 XML error envelope into its code and message. Returns `undefined`
 * for a body that carries no `<Code>`, so a non-XML or empty response is not
 * mistaken for a structured error.
 */
export function parseR2Error(body: string): R2ErrorBody | undefined {
	const code = extractTag(body, 'Code');

	if (code === undefined) {
		return undefined;
	}

	return { code, message: extractTag(body, 'Message') ?? '' };
}
