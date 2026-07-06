import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
	createReporter,
	formatCount,
	formatDuration,
	formatTimestamp
} from './reporter.ts';

class ReporterTestError extends Error {
	constructor(public readonly code: string) {
		super('reporter test failure');
	}
}

function expectReporterTestError(
	error: unknown
): asserts error is ReporterTestError {
	expect(error).toBeInstanceOf(ReporterTestError);
}

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

describe('createReporter', () => {
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

	it('emits throttled interim progress events while a long phase runs', async () => {
		let clock = 0;
		const { events, reporter } = jsonReporter(() => clock);

		const value = await reporter.phase('Fetching', (phase) => {
			phase.fact('rows', '1k'); // t=0, just started: no interim event yet
			clock = 2000;
			phase.fact('rows', '2k'); // a full interval on: emits the facts so far
			clock = 2500;
			phase.fact('rows', '3k'); // 500ms since the last emit: throttled, no event
			clock = 4000;
			phase.fact('rows', '4k'); // another interval on: emits again
			return 'done';
		});

		expect(value).toBe('done');
		expect(withoutDurations(events())).toStrictEqual([
			{
				event: 'progress',
				label: 'Fetching',
				durationMs: 'number',
				facts: { rows: '2k' }
			},
			{
				event: 'progress',
				label: 'Fetching',
				durationMs: 'number',
				facts: { rows: '4k' }
			},
			{
				durationMs: 'number',
				event: 'phase',
				facts: { rows: '4k' },
				label: 'Fetching',
				status: 'ok'
			}
		]);
	});

	it('emits a warning raised inside a phase as its own warn event', async () => {
		const { events, reporter } = jsonReporter();

		const value = await reporter.phase('Uploading', (phase) => {
			phase.warn('upload failed', 'abc: timeout');
			phase.fact('paths', 1);
			return 'done';
		});

		expect(value).toBe('done');
		expect(withoutDurations(events())).toStrictEqual([
			{ event: 'warn', label: 'upload failed', value: 'abc: timeout' },
			{
				durationMs: 'number',
				event: 'phase',
				facts: { paths: '1' },
				label: 'Uploading',
				status: 'ok'
			}
		]);
	});

	it('emits a warning raised inside a steps task as its own warn event', async () => {
		const { events, reporter } = jsonReporter();

		await reporter.steps('Attestations', (log) => {
			log.warn('pending verification');
			return 0;
		});

		expect(withoutDurations(events())).toStrictEqual([
			{ event: 'warn', label: 'pending verification' },
			{
				durationMs: 'number',
				event: 'phase',
				groups: [],
				label: 'Attestations',
				status: 'ok'
			}
		]);
	});

	it('emits a failed phase and rethrows', async () => {
		const { events, reporter } = jsonReporter();
		const failure = new ReporterTestError('build-failed');

		let error: unknown;
		try {
			await reporter.phase('Building', () => Promise.reject(failure));
		} catch (error_: unknown) {
			error = error_;
		}

		expectReporterTestError(error);
		expect({
			error: { code: error.code },
			events: withoutDurations(events()).map((event) =>
				isRecord(event)
					? {
							...event,
							error: event.error === undefined ? undefined : typeof event.error
						}
					: event
			)
		}).toStrictEqual({
			error: { code: 'build-failed' },
			events: [
				{
					durationMs: 'number',
					error: 'string',
					event: 'phase',
					label: 'Building',
					status: 'failed'
				}
			]
		});
	});

	it('emits a progress phase with its total, completed count and facts', async () => {
		const { events, reporter } = jsonReporter();

		const value = await reporter.progress(
			'Uploading',
			{ total: 100 },
			(bar) => {
				bar.advance(40);
				bar.advance(60);
				bar.fact('blobs', '2/2');
				return 'uploaded';
			}
		);

		expect(value).toBe('uploaded');
		expect(withoutDurations(events())).toStrictEqual([
			{
				durationMs: 'number',
				event: 'phase',
				label: 'Uploading',
				status: 'ok',
				total: 100,
				completed: 100,
				facts: { blobs: '2/2' }
			}
		]);
	});

	it('emits throttled interim progress events while a long phase runs', async () => {
		let clock = 0;
		const { events, reporter } = jsonReporter(() => clock);

		const value = await reporter.progress(
			'Preparing',
			{ total: 100 },
			(bar) => {
				bar.advance(10); // t=0, just started: no interim event yet
				clock = 2000;
				bar.advance(10); // a full interval on: emits completed=20
				clock = 2500;
				bar.advance(10); // 500ms since the last emit: throttled, no event
				clock = 4000;
				bar.fact('rate', '5/s');
				bar.advance(10); // another interval on: emits completed=40 with the fact
				return 'prepared';
			}
		);

		expect(value).toBe('prepared');
		expect(withoutDurations(events())).toStrictEqual([
			{
				event: 'progress',
				label: 'Preparing',
				durationMs: 'number',
				total: 100,
				completed: 20,
				facts: {}
			},
			{
				event: 'progress',
				label: 'Preparing',
				durationMs: 'number',
				total: 100,
				completed: 40,
				facts: { rate: '5/s' }
			},
			{
				event: 'phase',
				label: 'Preparing',
				status: 'ok',
				durationMs: 'number',
				total: 100,
				completed: 40,
				facts: { rate: '5/s' }
			}
		]);
	});

	it('emits a failed progress phase with the bytes completed so far', async () => {
		const { events, reporter } = jsonReporter();
		const failure = new ReporterTestError('progress-failed');

		let error: unknown;
		try {
			await reporter.progress('Uploading', { total: 100 }, (bar) => {
				bar.advance(30);
				throw failure;
			});
		} catch (error_: unknown) {
			error = error_;
		}

		expectReporterTestError(error);
		expect({
			error: { code: error.code },
			events: withoutDurations(events()).map((event) =>
				isRecord(event)
					? {
							...event,
							error: event.error === undefined ? undefined : typeof event.error
						}
					: event
			)
		}).toStrictEqual({
			error: { code: 'progress-failed' },
			events: [
				{
					durationMs: 'number',
					event: 'phase',
					label: 'Uploading',
					status: 'failed',
					total: 100,
					completed: 30,
					facts: {},
					error: 'string'
				}
			]
		});
	});

	it('emits a steps phase with its groups and messages', async () => {
		const { events, reporter } = jsonReporter();

		const value = await reporter.steps('Attestations', (log) => {
			const read = log.group('read');
			read.message('opening');
			read.success('3 bundles');

			const upload = log.group('upload');
			upload.error('network down');

			log.message('done');
			return 7;
		});

		expect(value).toBe(7);
		expect(withoutDurations(events())).toStrictEqual([
			{
				durationMs: 'number',
				event: 'phase',
				label: 'Attestations',
				status: 'ok',
				groups: [
					{ name: 'read', status: 'ok', messages: ['opening', '3 bundles'] },
					{ name: 'upload', status: 'failed', messages: ['network down'] }
				],
				messages: ['done']
			}
		]);
	});

	it('emits a failed steps phase and rethrows', async () => {
		const { events, reporter } = jsonReporter();
		const failure = new ReporterTestError('steps-failed');

		let error: unknown;
		try {
			await reporter.steps('Attestations', (log) => {
				log.group('read').message('opening');
				throw failure;
			});
		} catch (error_: unknown) {
			error = error_;
		}

		expectReporterTestError(error);
		expect({
			error: { code: error.code },
			events: withoutDurations(events()).map((event) =>
				isRecord(event)
					? {
							...event,
							error: event.error === undefined ? undefined : typeof event.error
						}
					: event
			)
		}).toStrictEqual({
			error: { code: 'steps-failed' },
			events: [
				{
					durationMs: 'number',
					event: 'phase',
					label: 'Attestations',
					status: 'failed',
					groups: [{ name: 'read', status: 'open', messages: ['opening'] }],
					error: 'string'
				}
			]
		});
	});

	it('emits result, warn, and info events', () => {
		const { events, reporter } = jsonReporter();

		reporter.result({
			kind: 'push-summary',
			data: { uploaded: 5, bytes: 1024 },
			rows: [
				{ label: 'paths', value: '5' },
				{ label: 'bytes', value: '1,024' }
			]
		});
		reporter.warn('skipped', 'already present');
		reporter.warn('detached');
		reporter.info('all done');

		expect(events()).toStrictEqual([
			{
				event: 'result',
				kind: 'push-summary',
				data: { uploaded: 5, bytes: 1024 }
			},
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

function jsonReporter(now?: () => number): {
	readonly events: () => readonly unknown[];
	readonly payloads: () => string[];
	readonly reporter: ReturnType<typeof createReporter>;
} {
	const diagnostics = captureStream();
	const payloads = captureStream();

	return {
		events: () => diagnostics.lines().map((line): unknown => JSON.parse(line)),
		payloads: payloads.lines,
		reporter: createReporter({
			stream: diagnostics.stream,
			out: payloads.stream,
			...(now !== undefined && { now })
		})
	};
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
