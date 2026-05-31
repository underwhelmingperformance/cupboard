import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	MalformedRequestBodyError,
	RequestBodySchemaMismatchError,
	StoredUploadMetadataInvalidError
} from './errors.ts';
import { parseRequestBody, parseRequestValue, parseStored } from './parse.ts';

const schema = z.strictObject({ name: z.string() });

function jsonRequest(body: string): Request {
	return new Request('https://cupboard.test', { method: 'POST', body });
}

function storedFault(cause: Error): StoredUploadMetadataInvalidError {
	return new StoredUploadMetadataInvalidError('upload-1', cause);
}

describe('parseRequestValue', () => {
	it('returns the parsed value', () => {
		expect(parseRequestValue(z.number(), 1)).toBe(1);
	});

	it('throws RequestBodySchemaMismatchError on a mismatch', () => {
		expect(() => parseRequestValue(z.number(), 'nope')).toThrow(
			RequestBodySchemaMismatchError
		);
	});
});

describe('parseRequestBody', () => {
	it('parses a well-formed body', async () => {
		const parsed = await parseRequestBody(
			schema,
			jsonRequest(JSON.stringify({ name: 'a' }))
		);

		expect(parsed).toStrictEqual({ name: 'a' });
	});

	it('rejects malformed JSON with MalformedRequestBodyError', async () => {
		await expect(parseRequestBody(schema, jsonRequest('{'))).rejects.toThrow(
			MalformedRequestBodyError
		);
	});

	it.each([
		{ name: 'a schema mismatch', body: JSON.stringify({ name: 1 }) },
		{ name: 'an unknown key', body: JSON.stringify({ name: 'a', extra: 1 }) }
	])('rejects $name with RequestBodySchemaMismatchError', async ({ body }) => {
		await expect(parseRequestBody(schema, jsonRequest(body))).rejects.toThrow(
			RequestBodySchemaMismatchError
		);
	});
});

describe('parseStored', () => {
	it('parses well-formed stored JSON', () => {
		expect(
			parseStored(schema, JSON.stringify({ name: 'a' }), storedFault)
		).toStrictEqual({ name: 'a' });
	});

	it.each([
		{ name: 'corrupt JSON', source: '{' },
		{ name: 'a schema mismatch', source: JSON.stringify({ name: 1 }) }
	])('raises the supplied fault on $name', ({ source }) => {
		expect(() => parseStored(schema, source, storedFault)).toThrow(
			StoredUploadMetadataInvalidError
		);
	});
});
