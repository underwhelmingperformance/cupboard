import { uploadIdSchema } from '@cupboard/protocol/upload';
import { Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	MalformedRequestBodyError,
	RequestBodySchemaMismatchError,
	RequestBodyTooLargeError,
	StoredUploadMetadataInvalidError,
	TokenRequestBodyInvalidError,
	TokenRequestBodyTooLargeError
} from '../errors.ts';

import { serverErrorHandler } from './error-response.ts';
import {
	formBodyMaxBytes,
	parseFormBody,
	parseRequestBody,
	parseRequestValue,
	parseStored
} from './parse.ts';

const schema = z.strictObject({ name: z.string() });
const jsonBodyMaxBytes = 1024;

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
			jsonRequest(JSON.stringify({ name: 'a' })),
			jsonBodyMaxBytes
		);

		expect(parsed).toStrictEqual({ name: 'a' });
	});

	it('rejects a malformed JSON body', async () => {
		await expect(
			parseRequestBody(schema, jsonRequest('{'), jsonBodyMaxBytes)
		).rejects.toThrow(MalformedRequestBodyError);
	});

	it.each([
		{ name: 'a field of the wrong type', body: JSON.stringify({ name: 1 }) },
		{ name: 'an unknown key', body: JSON.stringify({ name: 'a', extra: 1 }) }
	])('rejects $name', async ({ body }) => {
		await expect(
			parseRequestBody(schema, jsonRequest(body), jsonBodyMaxBytes)
		).rejects.toThrow(RequestBodySchemaMismatchError);
	});

	it.each<{
		readonly name: string;
		readonly headers: Readonly<Record<string, string>>;
		readonly chunkBytes: number;
		readonly chunks: number;
	}>([
		{
			name: 'Content-Length',
			headers: { 'Content-Length': String(jsonBodyMaxBytes + 1) },
			chunkBytes: 1,
			chunks: 1
		},
		{
			name: 'the streamed body',
			headers: {},
			chunkBytes: jsonBodyMaxBytes / 2,
			chunks: 4
		}
	])(
		'returns HTTP 413 when $name exceeds the byte limit',
		async ({ headers, chunkBytes, chunks }) => {
			let sent = 0;
			let isCancelled = false;
			const app = new Hono();
			app.onError(serverErrorHandler);
			app.post('/missing-paths', async (context) =>
				context.json(
					await parseRequestBody(schema, context.req.raw, jsonBodyMaxBytes)
				)
			);

			const init = {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...headers },
				duplex: 'half',
				body: new ReadableStream({
					pull(controller) {
						controller.enqueue(
							new TextEncoder().encode(' '.repeat(chunkBytes))
						);
						sent += 1;

						if (sent === chunks) {
							controller.close();
						}
					},
					cancel() {
						isCancelled = true;
					}
				})
			};
			const response = await app.request(
				new Request('https://cupboard.test/missing-paths', init)
			);

			expect({
				status: response.status,
				headers: Object.fromEntries(response.headers),
				body: await response.text(),
				isCancelled
			}).toStrictEqual({
				status: StatusCodes.REQUEST_TOO_LONG,
				headers: { 'content-type': 'text/plain;charset=UTF-8' },
				body: `${new RequestBodyTooLargeError(jsonBodyMaxBytes).message}\n`,
				isCancelled: true
			});
		}
	);
});

describe('parseFormBody', () => {
	const grant = z.strictObject({
		grant_type: z.string(),
		subject_token: z.string()
	});

	it('parses a well-formed URL-encoded body', async () => {
		const parsed = await parseFormBody(
			grant,
			formRequest('grant_type=token-exchange&subject_token=abc')
		);

		expect(parsed).toStrictEqual({
			grant_type: 'token-exchange',
			subject_token: 'abc'
		});
	});

	it('rejects a repeated singleton parameter', async () => {
		await expect(
			parseFormBody(
				grant,
				formRequest('grant_type=first&grant_type=second&subject_token=abc')
			)
		).rejects.toThrow(TokenRequestBodyInvalidError);
	});

	it('rejects a repeated parameter even when the schema permits an array', async () => {
		const repeated = z.strictObject({ resource: z.array(z.string()) });

		await expect(
			parseFormBody(repeated, formRequest('resource=one&resource=two'))
		).rejects.toThrow(TokenRequestBodyInvalidError);
	});

	it('rejects a non-form media type', async () => {
		await expect(
			parseFormBody(
				grant,
				new Request('https://cupboard.test', {
					method: 'POST',
					headers: { 'Content-Type': 'text/plain' },
					body: 'grant_type=t&subject_token=a'
				})
			)
		).rejects.toThrow(TokenRequestBodyInvalidError);
	});

	it('rejects a form body which is not valid UTF-8', async () => {
		const malformed = new Request('https://cupboard.test', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: new Uint8Array([0xff])
		});

		await expect(parseFormBody(grant, malformed)).rejects.toThrow(
			TokenRequestBodyInvalidError
		);
	});

	it.each([
		{ name: 'a missing field', body: 'grant_type=token-exchange' },
		{ name: 'an unknown field', body: 'grant_type=t&subject_token=a&extra=x' }
	])('rejects $name', async ({ body }) => {
		await expect(parseFormBody(grant, formRequest(body))).rejects.toThrow(
			TokenRequestBodyInvalidError
		);
	});

	it.each<{
		readonly name: string;
		readonly headers: Readonly<Record<string, string>>;
		readonly chunkBytes: number;
		readonly chunks: number;
	}>([
		{
			name: 'Content-Length',
			headers: { 'Content-Length': String(formBodyMaxBytes + 1) },
			chunkBytes: 1,
			chunks: 1
		},
		{
			name: 'the streamed body',
			headers: {},
			chunkBytes: formBodyMaxBytes / 2,
			chunks: 4
		}
	])(
		'returns a no-store OAuth 413 when $name exceeds the byte limit',
		async ({ headers, chunkBytes, chunks }) => {
			let sent = 0;
			let isCancelled = false;
			const app = new Hono();
			app.onError(serverErrorHandler);
			app.post('/token', async (context) =>
				context.json(await parseFormBody(grant, context.req.raw))
			);

			const init = {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					...headers
				},
				duplex: 'half',
				body: new ReadableStream({
					pull(controller) {
						controller.enqueue(new Uint8Array(chunkBytes));
						sent += 1;

						if (sent === chunks) {
							controller.close();
						}
					},
					cancel() {
						isCancelled = true;
					}
				})
			};
			const response = await app.request(
				new Request('https://cupboard.test/token', init)
			);

			expect({
				status: response.status,
				headers: Object.fromEntries(response.headers),
				body: await response.json(),
				isCancelled
			}).toStrictEqual({
				status: StatusCodes.REQUEST_TOO_LONG,
				headers: {
					'cache-control': 'no-store',
					'content-type': 'application/json',
					pragma: 'no-cache'
				},
				body: {
					error: 'invalid_request',
					error_description: new TokenRequestBodyTooLargeError().message,
					problem: 'request-body-too-large'
				},
				isCancelled: true
			});
		}
	);
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
	])('throws the supplied fault for $name', ({ source }) => {
		expect(() => parseStored(schema, source, storedFault)).toThrow(
			StoredUploadMetadataInvalidError
		);
	});
});
