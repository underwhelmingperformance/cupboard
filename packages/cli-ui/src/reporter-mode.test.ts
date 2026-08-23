import { stderr } from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveReporterMode } from './reporter-mode.ts';

const originalPreCommit = process.env.PRE_COMMIT;
const originalForceColor = process.env.FORCE_COLOR;
const originalIsTty = Object.getOwnPropertyDescriptor(stderr, 'isTTY');

describe('resolveReporterMode', () => {
	beforeEach(() => {
		// A FORCE_COLOR in the ambient environment (some CI sets it) would otherwise
		// steer the cases that exercise the lower-precedence signals. A runner
		// setting GITHUB_ACTIONS would likewise steer the TTY cases.
		delete process.env.FORCE_COLOR;
		vi.stubEnv('GITHUB_ACTIONS', '');
	});

	afterEach(() => {
		restorePreCommit();
		restoreForceColor();
		restoreIsTty();
		vi.unstubAllEnvs();
	});

	it('lets an explicit output mode override the environment', () => {
		process.env.PRE_COMMIT = '1';
		setIsTty(false);

		expect(resolveReporterMode('terminal')).toBe('terminal');
		expect(resolveReporterMode('json')).toBe('json');
	});

	it('uses JSON output when PRE_COMMIT=1', () => {
		process.env.PRE_COMMIT = '1';
		setIsTty(true);

		expect(resolveReporterMode()).toBe('json');
	});

	it('lets FORCE_COLOR select terminal mode over pre-commit and a non-TTY', () => {
		process.env.FORCE_COLOR = '1';
		process.env.PRE_COMMIT = '1';
		setIsTty(false);

		expect(resolveReporterMode()).toBe('terminal');
	});

	it('uses GitHub output when GITHUB_ACTIONS=true, over a TTY', () => {
		vi.stubEnv('GITHUB_ACTIONS', 'true');
		delete process.env.PRE_COMMIT;
		setIsTty(true);

		expect(resolveReporterMode()).toBe('github');
	});

	it.each([
		{ name: 'pre-commit', preCommit: '1', forceColor: undefined, mode: 'json' },
		{
			name: 'FORCE_COLOR',
			preCommit: undefined,
			forceColor: '1',
			mode: 'terminal'
		}
	] as const)(
		'lets $name override GITHUB_ACTIONS=true',
		({ preCommit, forceColor, mode }) => {
			vi.stubEnv('GITHUB_ACTIONS', 'true');
			setIsTty(false);

			if (preCommit === undefined) {
				delete process.env.PRE_COMMIT;
			} else {
				process.env.PRE_COMMIT = preCommit;
			}

			if (forceColor !== undefined) {
				process.env.FORCE_COLOR = forceColor;
			}

			expect(resolveReporterMode()).toBe(mode);
		}
	);

	it.each([
		{ name: 'FORCE_COLOR=0', value: '0' },
		{ name: 'an empty FORCE_COLOR', value: '' }
	] as const)('does not select terminal mode for $name', ({ value }) => {
		process.env.FORCE_COLOR = value;
		delete process.env.PRE_COMMIT;
		setIsTty(false);

		expect(resolveReporterMode()).toBe('json');
	});

	it.each([
		{ isTty: true, mode: 'terminal' },
		{ isTty: false, mode: 'json' }
	] as const)(
		'uses $mode output when stderr.isTTY is $isTty',
		({ isTty, mode }) => {
			delete process.env.PRE_COMMIT;
			setIsTty(isTty);

			expect(resolveReporterMode()).toBe(mode);
		}
	);
});

function restorePreCommit(): void {
	if (originalPreCommit === undefined) {
		delete process.env.PRE_COMMIT;
		return;
	}

	process.env.PRE_COMMIT = originalPreCommit;
}

function restoreForceColor(): void {
	if (originalForceColor === undefined) {
		delete process.env.FORCE_COLOR;
		return;
	}

	process.env.FORCE_COLOR = originalForceColor;
}

function setIsTty(isTty: boolean): void {
	Object.defineProperty(stderr, 'isTTY', {
		configurable: true,
		value: isTty
	});
}

function restoreIsTty(): void {
	if (originalIsTty === undefined) {
		Reflect.deleteProperty(stderr, 'isTTY');
		return;
	}

	Object.defineProperty(stderr, 'isTTY', originalIsTty);
}
