import { stderr } from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveReporterMode } from './cli.ts';

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

	it('lets explicit colour flags override the environment', () => {
		process.env.PRE_COMMIT = '1';
		setIsTty(false);

		expect(resolveReporterMode(true)).toBe('terminal');
		expect(resolveReporterMode(false)).toBe('json');
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
		{ name: 'an explicit --no-colour', value: '1', colour: false },
		{ name: 'FORCE_COLOR=0', value: '0', colour: undefined },
		{ name: 'an empty FORCE_COLOR', value: '', colour: undefined }
	] as const)('does not force the spinner for $name', ({ value, colour }) => {
		process.env.FORCE_COLOR = value;
		delete process.env.PRE_COMMIT;
		setIsTty(false);

		expect(resolveReporterMode(colour)).toBe('json');
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
		delete (stderr as { isTTY?: boolean }).isTTY;
		return;
	}

	Object.defineProperty(stderr, 'isTTY', originalIsTty);
}
