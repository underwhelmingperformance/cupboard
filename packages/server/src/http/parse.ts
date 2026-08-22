import { z } from 'zod';

import {
	MalformedRequestBodyError,
	RequestBodySchemaMismatchError,
	type ServerHttpError,
	TokenRequestBodyInvalidError
} from '../errors.ts';

/**
 * Parses a JSON request body and validates it against `schema`. Invalid JSON
 * and schema mismatches become HTTP 400 errors; schema failures retain Zod's
 * diagnostics.
 */
export async function parseRequestBody<S extends z.ZodType>(
	schema: S,
	request: Request
): Promise<z.output<S>> {
	let json: unknown;

	try {
		json = await request.json();
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new MalformedRequestBodyError(error);
		}

		throw error;
	}

	return parseRequestValue(schema, json);
}

/**
 * Validates an `application/x-www-form-urlencoded` request body against a
 * schema, returning the parsed (branded) value. Repeated keys become arrays, so
 * a schema for a singleton OAuth parameter rejects duplicates. A body the schema
 * rejects becomes an OAuth `invalid_request` carrying the schema's diagnostics,
 * so the `/token` endpoint reports it in the RFC 6749 §5.2 envelope.
 */
export async function parseFormBody<S extends z.ZodType>(
	schema: S,
	request: Request
): Promise<z.output<S>> {
	const mediaType = request.headers
		.get('content-type')
		?.split(';', 1)[0]
		?.trim();

	if (mediaType?.toLowerCase() !== 'application/x-www-form-urlencoded') {
		throw invalidForm('Content-Type must be application/x-www-form-urlencoded');
	}

	// Decode the raw bytes directly: the runtime warns when
	// `.text()` is called on a body whose type is not `text/*`, and a urlencoded
	// body parses identically from its UTF-8 bytes.
	const decoder = new TextDecoder('utf-8', {
		fatal: true,
		ignoreBOM: false
	});
	let body: string;

	try {
		body = decoder.decode(await request.arrayBuffer());
	} catch {
		throw invalidForm('Form body is not valid UTF-8');
	}

	const parameters = new URLSearchParams(body);
	const values: Record<string, string | string[]> = {};

	for (const [name, value] of parameters) {
		const current = values[name];

		if (current === undefined) {
			values[name] = value;
			continue;
		}

		values[name] = Array.isArray(current)
			? [...current, value]
			: [current, value];
	}

	const result = schema.safeParse(values);

	if (!result.success) {
		throw new TokenRequestBodyInvalidError(result.error);
	}

	return result.data;
}

function invalidForm(message: string): TokenRequestBodyInvalidError {
	return new TokenRequestBodyInvalidError(
		new z.ZodError([{ code: 'custom', path: [], message }])
	);
}

/**
Validates a value taken from the request path or query string.
*/
export function parseRequestValue<S extends z.ZodType>(
	schema: S,
	value: unknown
): z.output<S> {
	const result = schema.safeParse(value);

	if (!result.success) {
		throw new RequestBodySchemaMismatchError(result.error);
	}

	return result.data;
}

/**
 * Parses and validates JSON owned by the server. Syntax and schema failures are
 * internal faults, so `onInvalid` supplies the contextual typed 500 error.
 */
export function parseStored<S extends z.ZodType>(
	schema: S,
	source: string,
	onInvalid: (cause: Error) => ServerHttpError
): z.output<S> {
	const json = parseStoredJson(source, onInvalid);
	const result = schema.safeParse(json);

	if (!result.success) {
		throw onInvalid(result.error);
	}

	return result.data;
}

export function parseStoredJson(
	source: string,
	onInvalid: (cause: Error) => ServerHttpError
): unknown {
	try {
		return JSON.parse(source);
	} catch (error) {
		if (error instanceof Error) {
			throw onInvalid(error);
		}

		throw error;
	}
}
