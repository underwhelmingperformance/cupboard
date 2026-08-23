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
 * Parses a request body as `application/x-www-form-urlencoded` data and
 * validates it against `schema`. Schema mismatches become OAuth
 * `invalid_request` errors in the RFC 6749 section 5.2 envelope.
 */
export async function parseFormBody<S extends z.ZodType>(
	schema: S,
	request: Request
): Promise<z.output<S>> {
	// Read the bytes directly because the runtime warns when `Request.text()` reads
	// an `application/x-www-form-urlencoded` body.
	const decoder = new TextDecoder();
	const body = decoder.decode(await request.arrayBuffer());
	const parameters = new URLSearchParams(body);
	const result = schema.safeParse(Object.fromEntries(parameters));

	if (!result.success) {
		throw new TokenRequestBodyInvalidError(result.error);
	}

	return result.data;
}

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
