import {
	readResponseBytes,
	RemoteBodyTooLargeError
} from '@cupboard/shared/response-body';
import { z } from 'zod';

import {
	MalformedRequestBodyError,
	RequestBodySchemaMismatchError,
	type ServerHttpError,
	TokenRequestBodyInvalidError,
	TokenRequestBodyTooLargeError
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

export const formBodyMaxBytes = 128 * 1024;

/**
 * Validates an `application/x-www-form-urlencoded` request body against a
 * schema, returning the parsed (branded) value. The form boundary rejects every
 * repeated parameter before the schema can strip an unknown extension. When the
 * schema rejects the body, the error is an OAuth `invalid_request` with the
 * schema's diagnostics, so the `/token` endpoint reports it in the RFC 6749
 * §5.2 envelope. A body larger than {@link formBodyMaxBytes} is refused with
 * HTTP 413 before it is decoded.
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

	const bytes = await readFormBytes(request);
	const decoder = new TextDecoder('utf-8', {
		fatal: true,
		ignoreBOM: false
	});
	let body: string;

	try {
		body = decoder.decode(bytes);
	} catch {
		throw invalidForm('Form body is not valid UTF-8');
	}

	const parameters = new URLSearchParams(body);
	const names = new Set<string>();

	for (const name of parameters.keys()) {
		if (names.has(name)) {
			throw invalidForm('Form parameters must not occur more than once');
		}

		names.add(name);
	}

	const values = Object.fromEntries(parameters);

	return parseFormValue(schema, values);
}

/**
Validates singleton fields from a form which has already passed raw parsing.
*/
export function parseFormValue<S extends z.ZodType>(
	schema: S,
	value: unknown
): z.output<S> {
	const result = schema.safeParse(value);

	if (!result.success) {
		throw new TokenRequestBodyInvalidError(result.error);
	}

	return result.data;
}

async function readFormBytes(request: Request): Promise<Uint8Array> {
	try {
		return await readResponseBytes(request, {
			description: 'Form body',
			maximumBytes: formBodyMaxBytes
		});
	} catch (error) {
		if (error instanceof RemoteBodyTooLargeError) {
			throw new TokenRequestBodyTooLargeError();
		}

		throw error;
	}
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
