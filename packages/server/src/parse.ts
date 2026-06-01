import { z } from 'zod';

import {
	InvalidRequestError,
	MalformedRequestBodyError,
	RequestBodySchemaMismatchError,
	type ServerHttpError
} from './errors.ts';

/**
 * Validates a JSON request body against a schema, returning the parsed
 * (branded) value. A body that is not JSON, or that the schema rejects, becomes
 * a 400 carrying the schema's own diagnostics.
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
 * schema, returning the parsed (branded) value. Repeated keys collapse to their
 * last value. A body the schema rejects becomes an OAuth `invalid_request`
 * carrying the schema's diagnostics, so the `/token` endpoint reports it in the
 * RFC 6749 §5.2 envelope.
 */
export async function parseFormBody<S extends z.ZodType>(
	schema: S,
	request: Request
): Promise<z.output<S>> {
	const parameters = new URLSearchParams(await request.text());
	const result = schema.safeParse(Object.fromEntries(parameters));

	if (!result.success) {
		throw new InvalidRequestError(z.prettifyError(result.error));
	}

	return result.data;
}

/** Validates a value taken from the request path or query string. */
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
 * Validates server-stored JSON against a schema. Stored state the server wrote
 * itself should always parse, so a failure is an internal fault: the caller
 * supplies the typed 500 to raise, with whatever context it holds.
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

/** Parses stored JSON text, mapping a syntax error to a typed fault. */
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
