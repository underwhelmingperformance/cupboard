import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetTestServer, testServerFor } from '../test-support.ts';

// An unset binding is `undefined`; blank and separator-only values also contain
// no key. Each case must return 501 before attempting to import a key. Use a
// fresh tenant because each Durable Object instance memoises its S3 app
// configuration.
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
