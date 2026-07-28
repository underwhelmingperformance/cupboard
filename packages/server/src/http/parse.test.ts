import { uploadIdSchema } from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	MalformedRequestBodyError,
	RequestBodySchemaMismatchError,
	StoredUploadMetadataInvalidError,
	TokenRequestBodyInvalidError
} from '../errors.ts';

import {
	parseFormBody,
	parseRequestBody,
	parseRequestValue,
	parseStored
} from './parse.ts';

const schema = z.strictObject({ name: z.string() });

function jsonRequest(body: string): Request {
	return new Request('https://cupboard.test', { method: 'POST', body });
}

function formRequest(body: string): Request {
	return new Request('https://cupboard.test', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});
}

function storedFault(cause: Error): StoredUploadMetadataInvalidError {
	return new StoredUploadMetadataInvalidError(
		uploadIdSchema.parse('upload-1'),
		cause
	);
}

describe('parseRequestValue', () => {
	it('returns the parsed value', () => {
		expect(parseRequestValue(z.number(), 1)).toBe(1);
	});

	it('rejects a value the schema does not accept', () => {
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

	it('rejects a malformed JSON body', async () => {
		await expect(parseRequestBody(schema, jsonRequest('{'))).rejects.toThrow(
			MalformedRequestBodyError
		);
	});

	it.each([
		{ name: 'a field of the wrong type', body: JSON.stringify({ name: 1 }) },
		{ name: 'an unknown key', body: JSON.stringify({ name: 'a', extra: 1 }) }
	])('rejects $name', async ({ body }) => {
		await expect(parseRequestBody(schema, jsonRequest(body))).rejects.toThrow(
			RequestBodySchemaMismatchError
		);
	});
});

describe('parseFormBody', () => {
	const grant = z.strictObject({
		grant_type: z.string(),
		subject_token: z.string()
	});

	it('parses a well-formed urlencoded body', async () => {
		const parsed = await parseFormBody(
			grant,
			formRequest('grant_type=token-exchange&subject_token=abc')
		);

		expect(parsed).toStrictEqual({
			grant_type: 'token-exchange',
			subject_token: 'abc'
		});
	});

	it('collapses a repeated key to its last value', async () => {
		const parsed = await parseFormBody(
			grant,
			formRequest('grant_type=first&grant_type=second&subject_token=abc')
		);

		expect(parsed).toStrictEqual({
			grant_type: 'second',
			subject_token: 'abc'
		});
	});

	it.each([
		{ name: 'a missing field', body: 'grant_type=token-exchange' },
		{ name: 'an unknown field', body: 'grant_type=t&subject_token=a&extra=x' }
	])('rejects $name', async ({ body }) => {
		await expect(parseFormBody(grant, formRequest(body))).rejects.toThrow(
			TokenRequestBodyInvalidError
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
