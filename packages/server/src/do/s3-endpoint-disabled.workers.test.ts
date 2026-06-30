import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetTestServer, testServerFor } from '../test-support.ts';

// An unset Worker secret reaches the runtime as `undefined`, not `''`. Both leave
// the S3 endpoint with no key to seal or open credential secrets with, so a
// marked S3 request must report the endpoint as not configured rather than fail
// while importing a missing key. A fresh tenant per case avoids the per-object
// `s3AppPromise` memoising the first verdict for the others.
describe('S3 endpoint disabled without a configured secret', () => {
	const original = env.S3_SECRET_KEY;

	beforeEach(resetTestServer);
	afterEach(() => {
		env.S3_SECRET_KEY = original;
	});

	it.each<{ name: string; apply: () => void }>([
		{
			name: 'unset',
			apply: () => {
				Reflect.deleteProperty(env, 'S3_SECRET_KEY');
			}
		},
		{
			name: 'empty',
			apply: () => {
				env.S3_SECRET_KEY = '';
			}
		},
		{
			name: 'only separators',
			apply: () => {
				env.S3_SECRET_KEY = ' , ';
			}
		}
	])('returns 501 when the secret is $name', async ({ name, apply }) => {
		apply();

		const response = await testServerFor(
			`s3-off-${name.replaceAll(' ', '-')}`
		).fetch(
			new Request('https://do.invalid/tenant/nix-cache-info', {
				headers: { 'x-cupboard-s3': '1' }
			})
		);

		expect(response.status).toBe(StatusCodes.NOT_IMPLEMENTED);
	});
});
