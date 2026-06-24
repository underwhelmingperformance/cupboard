import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { error, notice, warning } from './annotations.ts';

const originalGithubActions = process.env.GITHUB_ACTIONS;

describe('annotations', () => {
	let stdout: string[];
	let stderr: string[];

	beforeEach(() => {
		stdout = [];
		stderr = [];
		vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			stdout.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
			stderr.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();

		if (originalGithubActions === undefined) {
			delete process.env.GITHUB_ACTIONS;
			return;
		}

		process.env.GITHUB_ACTIONS = originalGithubActions;
	});

	it('writes workflow commands to stdout under GitHub Actions', () => {
		process.env.GITHUB_ACTIONS = 'true';

		notice('built');
		warning('no key');
		error('it failed');

		expect({ stdout, stderr }).toStrictEqual({
			stdout: [
				'::notice::built\n',
				'::warning::no key\n',
				'::error::it failed\n'
			],
			stderr: []
		});
	});

	it('escapes the characters the command syntax reserves', () => {
		process.env.GITHUB_ACTIONS = 'true';

		error('100% broken\nsecond line');

		expect(stdout).toStrictEqual(['::error::100%25 broken%0Asecond line\n']);
	});

	it('prints plain text off GitHub Actions, errors to stderr', () => {
		delete process.env.GITHUB_ACTIONS;

		notice('built');
		error('it failed');

		expect({ stdout, stderr }).toStrictEqual({
			stdout: ['built\n'],
			stderr: ['it failed\n']
		});
	});
});
