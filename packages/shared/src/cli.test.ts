import { stderr } from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveReporterMode } from './cli.ts';

const originalPreCommit = process.env.PRE_COMMIT;
const originalIsTty = Object.getOwnPropertyDescriptor(stderr, 'isTTY');

describe('resolveReporterMode', () => {
	afterEach(() => {
		restorePreCommit();
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
