import { type LogRecord } from '@logtape/logtape';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cloudflareSink, jsonLinesSink } from './sinks.ts';

function record(overrides: Partial<LogRecord> = {}): LogRecord {
	return {
		category: ['cupboard'],
		level: 'info',
		message: ['request finished'],
		rawMessage: 'request finished',
		timestamp: 1_700_000_000_000,
		properties: {},
		...overrides
	};
}

describe('cloudflareSink', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('emits a plain object with a constant msg and indexed fields', () => {
		const info = vi.spyOn(console, 'info').mockImplementation(vi.fn());

		cloudflareSink()(record({ properties: { status: 200, rowsRead: 5 } }));

		expect(info).toHaveBeenCalledWith({
			level: 'info',
			category: 'cupboard',
			msg: 'request finished',
			status: 200,
			rowsRead: 5
		});
	});

	it('routes warnings and errors to the matching console method', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(vi.fn());
		const error = vi.spyOn(console, 'error').mockImplementation(vi.fn());

		cloudflareSink()(record({ level: 'warning', message: ['retryable'] }));
		cloudflareSink()(record({ level: 'fatal', message: ['gone'] }));

		expect(warn).toHaveBeenCalledOnce();
		expect(error).toHaveBeenCalledOnce();
	});

	it('explodes an error field into name, message and stack', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(vi.fn());
		const boom = new Error('boom');

		cloudflareSink()(
			record({
				level: 'error',
				message: ['failed'],
				properties: { error: boom }
			})
		);

		expect(error).toHaveBeenCalledWith(
			expect.objectContaining({
				msg: 'failed',
				errorName: 'Error',
				errorMessage: 'boom',
				errorStack: boom.stack
			})
		);
	});

	it('stringifies a non-Error error value', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(vi.fn());

		cloudflareSink()(
			record({
				level: 'error',
				message: ['failed'],
				properties: { error: 'nope' }
			})
		);

		expect(error).toHaveBeenCalledWith(
			expect.objectContaining({ errorMessage: 'nope' })
		);
	});
});

describe('jsonLinesSink', () => {
	it('writes one JSON object per line through the supplied writer', () => {
		const lines: string[] = [];

		jsonLinesSink((line) => {
			lines.push(line);
		})(record({ properties: { tenant: 't1' } }));

		expect(lines).toHaveLength(1);
		expect(lines[0]?.endsWith('\n')).toBe(true);
		expect(JSON.parse(lines[0] ?? '')).toMatchObject({
			level: 'info',
			category: 'cupboard',
			msg: 'request finished',
			tenant: 't1',
			timestamp: 1_700_000_000_000
		});
	});
});
