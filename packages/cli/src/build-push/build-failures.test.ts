import { describe, expect, it } from 'vitest';

import { failedDerivations } from './build-failures.ts';

const app = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv';
const library = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv';

function built(derivation: string): string {
	return JSON.stringify({
		action: 'start',
		type: 105,
		fields: [derivation, '', 1, 1]
	});
}

function failed(derivation: string): string {
	return [
		built(derivation),
		JSON.stringify({
			action: 'msg',
			level: 0,
			msg: `error: Cannot build '${derivation}'.\nReason: builder failed with exit code 1.`
		})
	].join('\n');
}

const failure = { status: 1, signal: undefined };
const success = { status: 0, signal: undefined };

describe('failedDerivations', () => {
	it.each([
		{
			name: 'a failed target when a later target succeeds',
			attempts: [
				{ log: failed(app), exit: failure },
				{ log: built(library), exit: success }
			],
			expected: [app]
		},
		{
			name: 'every target that fails in a separate attempt',
			attempts: [
				{ log: failed(library), exit: failure },
				{ log: failed(app), exit: failure }
			],
			expected: [library, app]
		},
		{
			name: 'no target whose retry succeeds',
			attempts: [
				{ log: failed(app), exit: failure },
				{ log: built(app), exit: success }
			],
			expected: []
		},
		{
			name: 'a target whose retry fails again only once',
			attempts: [
				{ log: failed(app), exit: failure },
				{ log: failed(app), exit: failure }
			],
			expected: [app]
		}
	])('lists $name', ({ attempts, expected }) => {
		expect(failedDerivations(attempts)).toStrictEqual(expected);
	});
});
