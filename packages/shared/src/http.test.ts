import { describe, expect, it } from 'vitest';

import { basicAuthHeader } from './http.ts';

describe('basicAuthHeader', () => {
	it('encodes the credentials as a Basic authorization header', () => {
		expect(
			basicAuthHeader({ user: 'alice', password: 'secret' })
		).toStrictEqual({
			authorization: `Basic ${Buffer.from('alice:secret').toString('base64')}`
		});
	});

	it('encodes a credential carrying a colon and non-ASCII bytes', () => {
		expect(
			basicAuthHeader({ user: 'user', password: 'p:ss wörd' })
		).toStrictEqual({
			authorization: `Basic ${Buffer.from('user:p:ss wörd').toString('base64')}`
		});
	});
});
