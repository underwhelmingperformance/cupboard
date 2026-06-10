import { describe, expect, it } from 'vitest';

import { assembleSecrets } from './secrets.ts';

const fullEnv = {
	CONTROL_KEY_WRAP_SECRET: 'wrap',
	CUPBOARD_SIGNUP_SECRET: 'signup',
	R2_ACCESS_KEY_ID: 'akid',
	R2_SECRET_ACCESS_KEY: 'secret'
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
				control: [
					{ name: 'CONTROL_KEY_WRAP_SECRET', text: 'wrap' },
					{ name: 'CUPBOARD_SIGNUP_SECRET', text: 'signup' }
				],
				tenant: [
					{ name: 'R2_ACCOUNT_ID', text: 'acc-1' },
					{ name: 'R2_BUCKET_NAME', text: 'cupboard-blobs' },
					{ name: 'R2_ACCESS_KEY_ID', text: 'akid' },
					{ name: 'R2_SECRET_ACCESS_KEY', text: 'secret' }
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
			'R2_SECRET_ACCESS_KEY'
		]);
		expect(result.secrets.control).toStrictEqual([]);
		expect(result.secrets.tenant).toStrictEqual([
			{ name: 'R2_ACCOUNT_ID', text: 'acc-1' },
			{ name: 'R2_BUCKET_NAME', text: 'cupboard-blobs' },
			{ name: 'R2_ACCESS_KEY_ID', text: 'akid' }
		]);
	});
});
