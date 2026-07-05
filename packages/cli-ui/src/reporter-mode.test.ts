import { stderr } from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveReporterMode } from './reporter-mode.ts';

const originalPreCommit = process.env.PRE_COMMIT;
const originalForceColor = process.env.FORCE_COLOR;
const originalIsTty = Object.getOwnPropertyDescriptor(stderr, 'isTTY');

describe('resolveReporterMode', () => {
	beforeEach(() => {
		// A FORCE_COLOR in the ambient environment (some CI sets it) would otherwise
		// steer the cases that exercise the lower-precedence signals.
		delete process.env.FORCE_COLOR;
	});

	afterEach(() => {
		restorePreCommit();
		restoreForceColor();
		restoreIsTty();
	});

	it('lets an explicit output mode override the environment', () => {
		process.env.PRE_COMMIT = '1';
		setIsTty(false);

		expect(resolveReporterMode('terminal')).toBe('terminal');
		expect(resolveReporterMode('json')).toBe('json');
	});

	it('uses JSON output when running under pre-commit', () => {
		process.env.PRE_COMMIT = '1';
		setIsTty(true);

		expect(resolveReporterMode()).toBe('json');
	});

	it('lets FORCE_COLOR force the spinner over pre-commit and a non-TTY', () => {
		process.env.FORCE_COLOR = '1';
		process.env.PRE_COMMIT = '1';
		setIsTty(false);

		expect(resolveReporterMode()).toBe('terminal');
	});

	it.each([
		{ name: 'FORCE_COLOR=0', value: '0' },
		{ name: 'an empty FORCE_COLOR', value: '' }
	] as const)('does not force the spinner for $name', ({ value }) => {
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
