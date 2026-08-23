import { afterEach, describe, expect, it, vi } from 'vitest';

import { type LogRecord, resolveSink, rootLogger } from './config.ts';
import { type Capture, startCapture } from './testing.ts';

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
		parent.info('request finished', { status: 200 });

		expect(child).not.toBe(parent);
		expect(capture.logs[0]?.properties).toEqual({ tenant: 't1', status: 200 });
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
