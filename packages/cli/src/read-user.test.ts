import { describe, expect, it } from 'vitest';

import { InvalidReadUserError } from './errors.ts';
import { parseReadUser } from './read-user.ts';

describe('parseReadUser', () => {
	it.each([
		['rejects a value containing a colon', 'a:b'],
		['rejects a value beginning with a colon', ':alice'],
		['rejects an empty value', '']
	])('%s', (_name, value) => {
		expect(() => parseReadUser(value)).toThrow(InvalidReadUserError);
	});

	it('accepts a value without a colon', () => {
		expect(parseReadUser('alice')).toBe('alice');
	});

	it('returns undefined for an absent value', () => {
		expect(parseReadUser(undefined)).toBeUndefined();
	});
});
