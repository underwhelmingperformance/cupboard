import { describe, expect, it } from 'vitest';

import { decodeJwtPayload } from './jwt.ts';

function jwt(payload: unknown): string {
	const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');

	return `header.${segment}.signature`;
}

describe('decodeJwtPayload', () => {
	it('decodes the base64url JSON payload segment', () => {
		expect(decodeJwtPayload(jwt({ iss: 'https://idp.test', exp: 42 }))).toEqual(
			{
				iss: 'https://idp.test',
				exp: 42
			}
		);
	});

	it.each([
		['no payload segment', 'header'],
		['payload that is not valid JSON', 'header.bm90LWpzb24.signature'],
		['empty string', '']
	])('returns undefined for %s', (_label, token) => {
		expect(decodeJwtPayload(token)).toBeUndefined();
	});
});
