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
