import { afterEach, describe, expect, it } from 'vitest';

import { rootLogger } from './config.ts';
import { type Capture, startCapture } from './testing.ts';

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

	it('merges parent and child fields on a child logger', () => {
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

	it('routes levels and keeps messages constant across calls', () => {
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
