import { describe, expect, it } from 'vitest';

import { parseLines } from './inputs.ts';

describe('parseLines', () => {
	it('parses newline-delimited inputs', () => {
		expect(parseLines('/nix/store/a\n\n /nix/store/b \r\n')).toStrictEqual([
			'/nix/store/a',
			'/nix/store/b'
		]);
	});
});
