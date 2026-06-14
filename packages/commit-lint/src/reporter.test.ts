import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createReporter } from './reporter.ts';

function captureStream(): { stream: Writable; lines: () => string[] } {
	const chunks: string[] = [];

	const stream = new Writable({
		write(chunk: Buffer | string, _encoding, callback) {
			chunks.push(chunk.toString());
			callback();
		}
	});

	return {
		stream,
		lines: () =>
			chunks
				.join('')
				.split('\n')
				.filter((line) => line !== '')
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

describe('createReporter (json mode)', () => {
	it('emits a successful phase with its facts and returns the body value', async () => {
		const { stream, lines } = captureStream();
		const reporter = createReporter({ mode: 'json', stream });

		const value = await reporter.phase('Checking commit messages', (phase) => {
			phase.fact('messages', 3);

			return 'done';
		});

		const events = lines().map((line): unknown => JSON.parse(line));

		expect(value).toBe('done');
		expect(withoutDurations(events)).toStrictEqual([
			{
				event: 'phase',
				label: 'Checking commit messages',
				status: 'ok',
				durationMs: 'number',
				facts: { messages: '3' }
			}
		]);
	});

	it('emits a failed phase and rethrows', async () => {
		const { stream, lines } = captureStream();
		const reporter = createReporter({ mode: 'json', stream });
		const failure = new Error('boom');

		await expect(
			reporter.phase('Rewording commit messages', () => {
				throw failure;
			})
		).rejects.toBe(failure);

		const events = lines().map((line): unknown => JSON.parse(line));

		expect(withoutDurations(events)).toStrictEqual([
			{
				event: 'phase',
				label: 'Rewording commit messages',
				status: 'failed',
				durationMs: 'number',
				error: 'boom'
			}
		]);
	});
});

describe('createReporter (terminal mode)', () => {
	it('writes the phase label to the stream and returns the body value', async () => {
		const { stream, lines } = captureStream();
		const reporter = createReporter({ mode: 'terminal', stream });

		const value = await reporter.phase('Checking commit messages', (phase) => {
			phase.fact('messages', 1);

			return 42;
		});

		expect(value).toBe(42);
		expect(lines().join('\n')).toContain('Checking commit messages');
	});
});
