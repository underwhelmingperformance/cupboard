import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
	createReporter,
	formatCount,
	formatDuration,
	formatTimestamp
} from './reporter.ts';

describe('formatDuration', () => {
	it.each([
		[0, '0ms'],
		[750, '750ms'],
		[999, '999ms'],
		[1000, '1.0s'],
		[1500, '1.5s'],
		[59_900, '59.9s'],
		[60_000, '1m 0.0s'],
		[65_000, '1m 5.0s'],
		[90_000, '1m 30.0s']
	])('formats %ims as %s', (milliseconds, expected) => {
		expect(formatDuration(milliseconds)).toBe(expected);
	});
});

describe('formatCount', () => {
	it.each([
		[0, '0'],
		[42, '42'],
		[1000, '1,000'],
		[1_234_567, '1,234,567']
	])('groups %i as %s', (count, expected) => {
		expect(formatCount(count)).toBe(expected);
	});
});

describe('formatTimestamp', () => {
	it.each([
		['2026-06-13T14:30:45.123Z', '2026-06-13 14:30 UTC'],
		['2026-01-02T03:04:05.000Z', '2026-01-02 03:04 UTC'],
		// A non-UTC offset is normalised to UTC.
		['2026-06-13T14:30:00+02:00', '2026-06-13 12:30 UTC'],
		// An unparseable value passes through unchanged.
		['not a date', 'not a date']
	])('renders %s as %s', (value, expected) => {
		expect(formatTimestamp(value)).toBe(expected);
	});
});

describe('createReporter (json mode)', () => {
	it('emits a successful phase with its facts and return value', async () => {
		const { events, reporter } = jsonReporter();

		const value = await reporter.phase('Building', (phase) => {
			phase.fact('files', 3);
			return 'done';
		});

		expect(value).toBe('done');
		expect(withoutDurations(events())).toStrictEqual([
			{
				durationMs: 'number',
				event: 'phase',
				facts: { files: '3' },
				label: 'Building',
				status: 'ok'
			}
		]);
	});

	it('emits a failed phase and rethrows', async () => {
		const { events, reporter } = jsonReporter();

		await expect(
			reporter.phase('Building', () => {
				throw new Error('boom');
			})
		).rejects.toThrow('boom');

		expect(withoutDurations(events())).toStrictEqual([
			{
				durationMs: 'number',
				error: 'boom',
				event: 'phase',
				label: 'Building',
				status: 'failed'
			}
		]);
	});

	it('emits result, warn, and info events', () => {
		const { events, reporter } = jsonReporter();

		reporter.result([
			{ label: 'paths', value: '5' },
			{ label: 'bytes', value: '1,024' }
		]);
		reporter.warn('skipped', 'already present');
		reporter.warn('detached');
		reporter.info('all done');

		expect(events()).toStrictEqual([
			{ data: { bytes: '1,024', paths: '5' }, event: 'result' },
			{ event: 'warn', label: 'skipped', value: 'already present' },
			{ event: 'warn', label: 'detached' },
			{ event: 'info', message: 'all done' }
		]);
	});

	it('writes data payloads to stdout and emits one error event', () => {
		const { events, payloads, reporter } = jsonReporter();

		reporter.data('{"public_key":"abc"}');
		reporter.error(new RangeError('too big'));

		expect({ payloads: payloads(), events: events() }).toStrictEqual({
			payloads: ['{"public_key":"abc"}\n'],
			events: [{ event: 'error', name: 'RangeError', message: 'too big' }]
		});
	});
});

describe('createReporter (terminal mode)', () => {
	it('writes a data payload to stdout and an error marker to stderr', () => {
		const { lines, payloads, reporter } = terminalReporter();

		reporter.data('netrc contents');
		reporter.error(new RangeError('too big'));

		expect({
			payloads: payloads(),
			errorLine: stripAnsi(lines().join('')).trim()
		}).toStrictEqual({
			payloads: ['netrc contents\n'],
			errorLine: '✖ RangeError: too big'
		});
	});
});

function captureStream(): {
	readonly lines: () => string[];
	readonly stream: Writable;
} {
	const lines: string[] = [];

	return {
		lines: () => lines,
		stream: new Writable({
			write(chunk: Buffer | string, _encoding, callback) {
				lines.push(String(chunk));
				callback();
			}
		})
	};
}

function jsonReporter(): {
	readonly events: () => readonly unknown[];
	readonly payloads: () => string[];
	readonly reporter: ReturnType<typeof createReporter>;
} {
	const diagnostics = captureStream();
	const payloads = captureStream();

	return {
		events: () =>
			diagnostics.lines().map((line) => JSON.parse(line) as unknown),
		payloads: payloads.lines,
		reporter: createReporter({
			mode: 'json',
			stream: diagnostics.stream,
			out: payloads.stream
		})
	};
}

function terminalReporter(): {
	readonly lines: () => string[];
	readonly payloads: () => string[];
	readonly reporter: ReturnType<typeof createReporter>;
} {
	const diagnostics = captureStream();
	const payloads = captureStream();

	return {
		lines: diagnostics.lines,
		payloads: payloads.lines,
		reporter: createReporter({
			mode: 'terminal',
			stream: diagnostics.stream,
			out: payloads.stream
		})
	};
}

// Drops SGR colour escapes so a terminal line can be asserted exactly regardless
// of whether picocolors emitted them in this environment.
function stripAnsi(value: string): string {
	const escape = String.fromCodePoint(27);

	return value.replaceAll(new RegExp(String.raw`${escape}\[[0-9;]*m`, 'g'), '');
}

function withoutDurations(events: readonly unknown[]): readonly unknown[] {
	return events.map((event) =>
		isRecord(event) && typeof event.durationMs === 'number'
			? { ...event, durationMs: 'number' }
			: event
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
