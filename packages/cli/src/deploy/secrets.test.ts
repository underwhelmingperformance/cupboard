import { describe, expect, it } from 'vitest';

import {
	assembleSecrets,
	generatePushIdSigningKey,
	generateWrapSecret,
	settlePushIdSigningKey
} from './secrets.ts';

const fullEnv = {
	CONTROL_KEY_WRAP_SECRET: 'wrap',
	CUPBOARD_SIGNUP_SECRET: 'signup',
	R2_ACCESS_KEY_ID: 'akid',
	R2_SECRET_ACCESS_KEY: 'secret',
	PUSH_ID_SIGNING_KEY: 'push'
};

describe('assembleSecrets', () => {
	it('derives R2 account/bucket and pulls sensitive values from the env', () => {
		expect(
			assembleSecrets({
				env: fullEnv,
				accountId: 'acc-1',
				bucketName: 'cupboard-blobs'
			})
		).toStrictEqual({
			missing: [],
			secrets: {
				// The push id signing key lands on both Workers: the tenant object
				// issues and verifies push ids, the front Worker verifies them to
				// gate its pre-auth negotiate hint reads.
				control: [
					{ name: 'CONTROL_KEY_WRAP_SECRET', text: 'wrap' },
					{ name: 'CUPBOARD_SIGNUP_SECRET', text: 'signup' },
					{ name: 'PUSH_ID_SIGNING_KEY', text: 'push' }
				],
				tenant: [
					{ name: 'R2_ACCOUNT_ID', text: 'acc-1' },
					{ name: 'R2_BUCKET_NAME', text: 'cupboard-blobs' },
					{ name: 'R2_ACCESS_KEY_ID', text: 'akid' },
					{ name: 'R2_SECRET_ACCESS_KEY', text: 'secret' },
					{ name: 'PUSH_ID_SIGNING_KEY', text: 'push' }
				]
			}
		});
	});

	it('reports required secrets that are absent or empty and omits optional ones', () => {
		const result = assembleSecrets({
			env: { CONTROL_KEY_WRAP_SECRET: '', R2_ACCESS_KEY_ID: 'akid' },
			accountId: 'acc-1',
			bucketName: 'cupboard-blobs'
		});

		expect(result.missing).toStrictEqual([
			'CONTROL_KEY_WRAP_SECRET',
			'R2_SECRET_ACCESS_KEY',
			'PUSH_ID_SIGNING_KEY'
		]);
		expect(result.secrets.control).toStrictEqual([]);
		expect(result.secrets.tenant).toStrictEqual([
			{ name: 'R2_ACCOUNT_ID', text: 'acc-1' },
			{ name: 'R2_BUCKET_NAME', text: 'cupboard-blobs' },
			{ name: 'R2_ACCESS_KEY_ID', text: 'akid' }
		]);
	});
});

describe('settlePushIdSigningKey', () => {
	const key = 'PUSH_ID_SIGNING_KEY';

	it.each([
		// Both Workers hold the key: presumed aligned, left untouched.
		['keep', { control: [key], tenant: [key] }],
		// A first deploy: neither Worker holds one yet.
		['generate', { control: [], tenant: [] }],
		// The value cannot be read back to copy across, so a single-Worker key
		// realigns by rotating a fresh one onto both.
		['rotate', { control: [], tenant: [key] }],
		['rotate', { control: [key], tenant: [] }]
	] as const)('answers %s for %j', (expected, existing) => {
		expect(settlePushIdSigningKey(existing)).toBe(expected);
	});
});

describe.each([
	['generateWrapSecret', generateWrapSecret],
	['generatePushIdSigningKey', generatePushIdSigningKey]
])('%s', (_name, generate) => {
	it('produces a fresh high-entropy base64 key each call', () => {
		const first = generate();
		const second = generate();

		expect({
			firstBytes: Buffer.from(first, 'base64').byteLength,
			secondBytes: Buffer.from(second, 'base64').byteLength,
			distinct: first !== second
		}).toStrictEqual({
			firstBytes: 32,
			secondBytes: 32,
			distinct: true
		});
	});
});
