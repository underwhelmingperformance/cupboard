import type { LogLevel, LogRecord } from '@cupboard/logger';
import pc from 'picocolors';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clackSink } from './clack-sink.ts';

const log = vi.hoisted(() => ({
	error: vi.fn(),
	info: vi.fn(),
	message: vi.fn(),
	warn: vi.fn()
}));

vi.mock('@clack/prompts', () => ({ log }));

const plain = pc.createColors(false);

function record(
	level: LogLevel,
	message: string,
	properties: Record<string, unknown> = {}
): LogRecord {
	return {
		category: ['cupboard'],
		level,
		message: [message],
		properties,
		rawMessage: message,
		timestamp: 0
	};
}

describe('clackSink', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('passes an info message and its fields to log.info', () => {
		clackSink(plain)(record('info', 'pushed path', { path: '/nix/store/x' }));

		expect(log.info).toHaveBeenCalledTimes(1);
		const [line] = log.info.mock.calls[0] as [string];
		expect(line).toContain('pushed path');
		expect(line).toContain('path /nix/store/x');
	});

	it('passes a warning to log.warn', () => {
		clackSink(plain)(record('warning', 'slow response'));

		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn.mock.calls[0]?.[0]).toContain('slow response');
		expect(log.error).not.toHaveBeenCalled();
	});

	it.each(['error', 'fatal'] as const)(
		'passes %s-level records to log.error',
		(level) => {
			clackSink(plain)(record(level, 'push failed'));

			expect(log.error).toHaveBeenCalledTimes(1);
			expect(log.error.mock.calls[0]?.[0]).toContain('push failed');
		}
	);

	it('renders an error property with its name and message', () => {
		clackSink(plain)(
			record('error', 'push failed', {
				error: new TypeError('boom')
			})
		);

		const [line] = log.error.mock.calls[0] as [string];
		expect(line).toContain('boom');
		expect(line).toContain('TypeError');
		expect(line).not.toContain('[object Object]');
	});
});
