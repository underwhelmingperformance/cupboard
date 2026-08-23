import { type LogRecord } from '@logtape/logtape';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	cloudflareSink,
	type ConsoleLike,
	githubActionsSink,
	jsonLinesSink
} from './sinks.ts';

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

function fakeConsole(): {
	target: ConsoleLike;
	calls: Record<'debug' | 'info' | 'warn' | 'error', unknown[]>;
} {
	const calls: Record<'debug' | 'info' | 'warn' | 'error', unknown[]> = {
		debug: [],
		info: [],
		warn: [],
		error: []
	};

	return {
		target: {
			debug: (payload) => {
				calls.debug.push(payload);
			},
			info: (payload) => {
				calls.info.push(payload);
			},
			warn: (payload) => {
				calls.warn.push(payload);
			},
			error: (payload) => {
				calls.error.push(payload);
			}
		},
		calls
	};
}

describe('cloudflareSink', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('emits a plain object with a constant msg and indexed fields', () => {
		const { target, calls } = fakeConsole();

		cloudflareSink(target)(
			record({ properties: { status: 200, rowsRead: 5 } })
		);

		expect(calls.info).toHaveLength(1);
		expect(calls.info[0]).toStrictEqual({
			level: 'info',
			category: 'cupboard',
			msg: 'request finished',
			status: 200,
			rowsRead: 5
		});
	});

	it('routes warnings and errors to the matching console method', () => {
		const { target, calls } = fakeConsole();
		const sink = cloudflareSink(target);

		sink(record({ level: 'warning', message: ['retryable'] }));
		sink(record({ level: 'fatal', message: ['gone'] }));

		expect({
			warn: calls.warn.length,
			error: calls.error.length
		}).toStrictEqual({ warn: 1, error: 1 });
	});

	it('writes an error as indexed name, message and stack fields', () => {
		const { target, calls } = fakeConsole();
		const boom = new Error('boom');

		cloudflareSink(target)(
			record({
				level: 'error',
				message: ['failed'],
				properties: { error: boom }
			})
		);

		expect(calls.error[0]).toStrictEqual(
			expect.objectContaining({
				msg: 'failed',
				errorName: 'Error',
				errorMessage: 'boom',
				errorStack: boom.stack
			})
		);
	});

	it('writes the underlying cause of a wrapped error', () => {
		const { target, calls } = fakeConsole();
		const root = new Error('D1_ERROR: no such column: reconciled_at');
		const wrapped = new Error('Failed query: delete from x', { cause: root });

		cloudflareSink(target)(
			record({
				level: 'error',
				message: ['failed'],
				properties: { error: wrapped }
			})
		);

		expect(calls.error[0]).toStrictEqual(
			expect.objectContaining({
				errorMessage: 'Failed query: delete from x',
				errorCause: 'Error: D1_ERROR: no such column: reconciled_at',
				errorCauseStack: root.stack
			})
		);
	});

	it('stringifies a non-Error error value', () => {
		const { target, calls } = fakeConsole();

		cloudflareSink(target)(
			record({
				level: 'error',
				message: ['failed'],
				properties: { error: 'nope' }
			})
		);

		expect(calls.error[0]).toStrictEqual(
			expect.objectContaining({ errorMessage: 'nope' })
		);
	});
});

describe('githubActionsSink', () => {
	let written: string[];
	let sink: ReturnType<typeof githubActionsSink>;

	beforeEach(() => {
		written = [];
		const stream = {
			write: (chunk: string) => {
				written.push(chunk);
				return true;
			}
		};
		sink = githubActionsSink({
			stdout: stream,
			environment: { GITHUB_ACTIONS: 'true' }
		});
	});

	it.each([
		{
			name: 'writes an error annotation with appended fields',
			overrides: {
				level: 'error',
				message: ['boom'],
				properties: { ray: 'r1' }
			},
			expected: ['::error::boom ray=r1\n']
		},
		{
			name: 'writes a fatal record as an error annotation',
			overrides: { level: 'fatal', message: ['gone'] },
			expected: ['::error::gone\n']
		},
		{
			name: 'writes a warning annotation',
			overrides: { level: 'warning', message: ['careful'] },
			expected: ['::warning::careful\n']
		},
		{
			name: 'writes a debug command',
			overrides: { level: 'debug', message: ['detail'] },
			expected: ['::debug::detail\n']
		},
		{
			name: 'writes trace as a debug command',
			overrides: { level: 'trace', message: ['deep detail'] },
			expected: ['::debug::deep detail\n']
		},
		{
			name: 'writes info as a plain line',
			overrides: { level: 'info', message: ['hello'] },
			expected: ['hello\n']
		}
	] as const)('$name', ({ overrides, expected }) => {
		sink(record(overrides));

		expect(written).toStrictEqual(expected);
	});

	it('appends an error name, message and stack to the annotation', () => {
		const boom = new Error('exploded');

		sink(
			record({
				level: 'error',
				message: ['action dispatch failed'],
				properties: { error: boom }
			})
		);

		const [line] = written;
		expect(line).toContain('::error::action dispatch failed');
		expect(line).toContain('errorName=Error');
		expect(line).toContain('errorMessage=exploded');
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
