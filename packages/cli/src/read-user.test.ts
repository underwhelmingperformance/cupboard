import { describe, expect, it } from 'vitest';

import { InvalidReadUserError } from './errors.ts';
import { parseReadUser } from './read-user.ts';

describe('parseReadUser', () => {
	it.each([
		{ name: 'a colon', value: 'a:b' },
		{ name: 'a leading colon', value: ':alice' },
		{ name: 'nothing', value: '' }
	])('refuses a read user carrying $name', ({ value }) => {
		expect(() => parseReadUser(value)).toThrow(InvalidReadUserError);
	});

	it('accepts a name the credential format can carry', () => {
		expect(parseReadUser('alice')).toBe('alice');
	});

	it('takes an absent value as no read user', () => {
		expect(parseReadUser(undefined)).toBeUndefined();
	});
});
