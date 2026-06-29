import { describe, expect, it } from 'vitest';

import { pushCredentialTtlSeconds } from './push-credential.ts';

const now = new Date('2026-06-29T12:00:00.000Z');
const maxTtlSeconds = 6 * 60 * 60;

describe('pushCredentialTtlSeconds', () => {
	it('caps the credential at what the access token has left', () => {
		const tokenExpiresAt = new Date(now.getTime() + 600 * 1000);

		expect(pushCredentialTtlSeconds(tokenExpiresAt, now)).toBe(600);
	});

	it('falls back to the maximum when the token outlives it', () => {
		const tokenExpiresAt = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

		expect(pushCredentialTtlSeconds(tokenExpiresAt, now)).toBe(maxTtlSeconds);
	});

	it('floors at one second for an all-but-expired token', () => {
		const tokenExpiresAt = new Date(now.getTime() - 1000);

		expect(pushCredentialTtlSeconds(tokenExpiresAt, now)).toBe(1);
	});
});
