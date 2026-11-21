import { SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';

import { recordHandledError, withSpan } from './span.ts';
import { finishedSpans, recordSpans } from './span-recorder.test-support.ts';

describe('span errors', () => {
	it('marks a failed span and records the exception without bound parameters', async () => {
		recordSpans();
		const error = Object.assign(
			new Error('Failed query: select ? from cache\nparams: acme,secret-path', {
				cause: new Error('D1_ERROR: D1 DB is overloaded.')
			}),
			{ query: 'select ? from cache', params: ['acme', 'secret-path'] }
		);

		await expect(
			withSpan('failing', {}, () => Promise.reject(error))
		).rejects.toBe(error);

		const [span] = finishedSpans();
		expect({
			status: span?.status.code,
			errorType: span?.attributes['error.type'],
			exception: span?.events.map((event) => ({
				name: event.name,
				message: event.attributes?.['exception.message']
			})),
			hasParameters: JSON.stringify(span?.events).includes('secret-path')
		}).toStrictEqual({
			status: SpanStatusCode.ERROR,
			errorType: 'Error',
			exception: [
				{
					name: 'exception',
					message:
						'Failed query: select ? from cache <- Error: D1_ERROR: D1 DB is overloaded.'
				}
			],
			hasParameters: false
		});
	});

	it('keeps the driver error of a statement too long for one message', async () => {
		recordSpans();
		const query = `select * from narinfo where hash in (${Array.from({ length: 2000 }, () => '?').join(', ')})`;
		const error = Object.assign(
			new Error(`Failed query: ${query}`, {
				cause: new Error('D1_ERROR: D1 DB is overloaded.')
			}),
			{ query, params: [] }
		);

		await expect(
			withSpan('failing', {}, () => Promise.reject(error))
		).rejects.toBe(error);

		const message = String(
			finishedSpans()[0]?.events[0]?.attributes?.['exception.message']
		);
		expect({
			isTruncated: message.includes('[truncated] <- '),
			cause: message.slice(message.lastIndexOf(' <- ') + 4)
		}).toStrictEqual({
			isTruncated: true,
			cause: 'Error: D1_ERROR: D1 DB is overloaded.'
		});
	});

	it('describes an error whose cause cannot be serialised', async () => {
		recordSpans();
		const cause: Record<string, unknown> = {};
		cause.self = cause;
		const error = new TypeError('outer', { cause });

		await expect(
			withSpan('failing', {}, () => Promise.reject(error))
		).rejects.toBe(error);

		expect(
			finishedSpans()[0]?.events.map((event) => ({
				name: event.attributes?.['exception.type'],
				message: event.attributes?.['exception.message']
			}))
		).toStrictEqual([
			{ name: 'TypeError', message: 'outer <- [object Object]' }
		]);
	});

	it("redacts a credential in the name of a failed span's error", async () => {
		recordSpans();
		// A name is arbitrary text, so a library could put a credential in it.
		class CredentialNamedError extends Error {
			override readonly name = 'Bearer private-token';
		}
		const error = new CredentialNamedError('denied');

		await expect(
			withSpan('failing', {}, () => Promise.reject(error))
		).rejects.toBe(error);

		const [span] = finishedSpans();
		expect({
			errorType: span?.attributes['error.type'],
			names: span?.events.map((event) => event.attributes?.['exception.type'])
		}).toStrictEqual({
			errorType: 'Bearer [redacted]',
			names: ['Bearer [redacted]']
		});
	});

	it('records a handled error without marking the span as failed', async () => {
		recordSpans();

		await withSpan('handled', {}, () => {
			recordHandledError({ code: 'busy' });
			return Promise.resolve();
		});

		const [span] = finishedSpans();
		expect({
			status: span?.status.code,
			errorType: span?.attributes['error.type'],
			messages: span?.events.map(
				(event) => event.attributes?.['exception.message']
			)
		}).toStrictEqual({
			status: SpanStatusCode.UNSET,
			errorType: undefined,
			messages: ['{"code":"busy"}']
		});
	});
});
