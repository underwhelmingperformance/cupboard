import process from 'node:process';

import { type LogRecord } from '@cupboard/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { githubActionsSink } from './logging.ts';

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

describe('githubActionsSink', () => {
	let written: string[];

	beforeEach(() => {
		written = [];
		vi.stubEnv('GITHUB_ACTIONS', 'true');
		vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
			written.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it('maps error to an error annotation with the fields appended', () => {
		githubActionsSink()(
			record({ level: 'error', message: ['boom'], properties: { ray: 'r1' } })
		);

		expect(written).toStrictEqual(['::error::boom ray=r1\n']);
	});

	it('maps warning to a warning annotation', () => {
		githubActionsSink()(record({ level: 'warning', message: ['careful'] }));

		expect(written).toStrictEqual(['::warning::careful\n']);
	});

	it('maps debug to a debug command', () => {
		githubActionsSink()(record({ level: 'debug', message: ['detail'] }));

		expect(written).toStrictEqual(['::debug::detail\n']);
	});

	it('prints info as a plain line, not an annotation', () => {
		githubActionsSink()(record({ level: 'info', message: ['hello'] }));

		expect(written).toStrictEqual(['hello\n']);
	});

	it('expands an error field into its name, message and stack', () => {
		const boom = new Error('exploded');

		githubActionsSink()(
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
