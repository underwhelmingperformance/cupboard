import { StatusCodes } from 'http-status-codes';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	type LogRecord,
	resolveSink,
	rootLogger,
	withContext
} from './config.ts';
import { type Capture, CaptureStoppedError, startCapture } from './testing.ts';

function record(overrides: Partial<LogRecord> = {}): LogRecord {
	return {
		category: ['cupboard'],
		level: 'info',
		message: ['a message'],
		rawMessage: 'a message',
		timestamp: 0,
		properties: {},
		...overrides
	};
}

describe('rootLogger with capture', () => {
	it('captures asynchronous request context independently', async () => {
		const scoped = startCapture();

		try {
			await Promise.all(
				['first', 'second'].map((requestId) =>
					withContext({ requestId }, async () => {
						await Promise.resolve();
						rootLogger().info('scoped record');
					})
				)
			);
			expect(scoped.logs.map((record) => record.properties)).toStrictEqual([
				{ requestId: 'first' },
				{ requestId: 'second' }
			]);
		} finally {
			scoped.stop();
		}
	});

	it('resolves until for a record that is captured before and one that is captured after the call', async () => {
		const scoped = startCapture();

		try {
			rootLogger().info('first');
			const earlier = scoped.until((entry) => entry.message === 'first');
			const later = scoped.until((entry) => entry.message === 'third');
			rootLogger().info('second');
			rootLogger().info('third', { index: 3 });

			expect({ earlier: await earlier, later: await later }).toStrictEqual({
				earlier: {
					level: 'info',
					category: ['cupboard'],
					message: 'first',
					properties: {}
				},
				later: {
					level: 'info',
					category: ['cupboard'],
					message: 'third',
					properties: { index: 3 }
				}
			});
		} finally {
			scoped.stop();
		}
	});

	it('rejects until when the capture stops before a record matches', async () => {
		const scoped = startCapture();
		const pending = scoped.until((entry) => entry.message === 'never');

		scoped.stop();

		await expect(pending).rejects.toBeInstanceOf(CaptureStoppedError);
		await expect(
			scoped.until((entry) => entry.message === 'never')
		).rejects.toBeInstanceOf(CaptureStoppedError);
	});

	// Vitest fails the run with an unhandled rejection when stop() rejects a
	// promise that has no handler.
	it('does not leave an unhandled rejection when stop() rejects an unawaited until', () => {
		const scoped = startCapture();

		void scoped.until((entry) => entry.message === 'never');
		scoped.stop();
	});

	let capture: Capture | undefined;

	afterEach(() => {
		capture?.stop();
		capture = undefined;
	});

	it('records a constant message with its structured fields', () => {
		capture = startCapture();

		rootLogger().info('upload accepted', { uploadId: 'abc' });

		expect(capture.logs).toHaveLength(1);
		expect(capture.logs[0]).toMatchObject({
			level: 'info',
			message: 'upload accepted',
			properties: { uploadId: 'abc' }
		});
	});

	it('preserves parent fields on a derived logger', () => {
		capture = startCapture();

		const child = rootLogger().with({ tenant: 't1' }).with({ uploadId: 'abc' });
		child.warn('materialise flush failed', { narHash: 'sha256:x' });

		expect(capture.logs[0]?.properties).toEqual({
			tenant: 't1',
			uploadId: 'abc',
			narHash: 'sha256:x'
		});
	});

	it('does not leak child fields back onto the parent', () => {
		capture = startCapture();

		const parent = rootLogger().with({ tenant: 't1' });
		const child = parent.with({ uploadId: 'abc' });
		parent.info('request finished', { status: StatusCodes.OK });

		expect(child).not.toBe(parent);
		expect(capture.logs[0]?.properties).toEqual({
			tenant: 't1',
			status: StatusCodes.OK
		});
	});

	it('records each level and message independently', () => {
		capture = startCapture();

		const log = rootLogger();
		log.debug('a', { n: 1 });
		log.error('unhandled server error', { ray: 'r1' });

		expect(capture.logs.map((entry) => [entry.level, entry.message])).toEqual([
			['debug', 'a'],
			['error', 'unhandled server error']
		]);
	});
});

describe('resolveSink', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it('writes workflow-command syntax to stdout under GitHub Actions', () => {
		const written: string[] = [];
		const stream = {
			write: (chunk: string) => {
				written.push(chunk);
				return true;
			}
		};

		resolveSink({
			stdout: stream,
			environment: { GITHUB_ACTIONS: 'true' }
		})(
			record({
				level: 'warning',
				message: ['careful'],
				properties: { key: 'value' }
			})
		);

		expect(written).toStrictEqual(['::warning::careful key=value\n']);
	});

	it('writes line-delimited JSON to stderr outside GitHub Actions', () => {
		const written: string[] = [];
		const stream = {
			write: (chunk: string) => {
				written.push(chunk);
				return true;
			}
		};

		resolveSink({ stderr: stream, environment: {} })(
			record({
				level: 'info',
				message: ['hello'],
				properties: { key: 'value' }
			})
		);

		expect(written).toHaveLength(1);
		expect(JSON.parse(written[0] ?? '')).toStrictEqual({
			timestamp: 0,
			level: 'info',
			category: 'cupboard',
			msg: 'hello',
			key: 'value'
		});
	});
});
