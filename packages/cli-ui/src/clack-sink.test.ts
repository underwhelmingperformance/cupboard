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

// Colours disabled so assertions can match on plain text without ANSI codes.
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

	it('renders an info record through log.info with the message and fields', () => {
		clackSink(plain)(record('info', 'pushed path', { path: '/nix/store/x' }));

		expect(log.info).toHaveBeenCalledTimes(1);
		const [line] = log.info.mock.calls[0] as [string];
		expect(line).toContain('pushed path');
		expect(line).toContain('path /nix/store/x');
	});

	it('renders a warning record through log.warn', () => {
		clackSink(plain)(record('warning', 'slow response'));

		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn.mock.calls[0]?.[0]).toContain('slow response');
		expect(log.error).not.toHaveBeenCalled();
	});

	it.each(['error', 'fatal'] as const)(
		'renders a %s record through log.error',
		(level) => {
			clackSink(plain)(record(level, 'push failed'));

			expect(log.error).toHaveBeenCalledTimes(1);
			expect(log.error.mock.calls[0]?.[0]).toContain('push failed');
		}
	);

	it('renders an error property by its message, not [object Object]', () => {
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
