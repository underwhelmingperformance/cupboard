import { describe, expect, it } from 'vitest';

import { DeviceAuthorizationRequestError } from '../auth/oidc-login.ts';
import { cloudflareOauthClientId } from '../deploy/cloudflare-oauth.ts';

import { DeviceGrantNotEnabledError, mapDeviceLoginError } from './login.ts';

describe('mapDeviceLoginError', () => {
	it.each([[400], [401], [403]])(
		'maps a refused device authorization (HTTP %i) for the built-in client',
		(status) => {
			const mapped = mapDeviceLoginError(
				new DeviceAuthorizationRequestError(status),
				cloudflareOauthClientId
			);

			expect(mapped).toBeInstanceOf(DeviceGrantNotEnabledError);
		}
	);

	it('passes the error through for other clients', () => {
		const error = new DeviceAuthorizationRequestError(403);

		expect(mapDeviceLoginError(error, 'someone-else')).toBe(error);
	});

	it.each([
		['a server error', new DeviceAuthorizationRequestError(500)],
		['an unrelated failure', new Error('network down')]
	])('passes %s through for the built-in client', (_name, error) => {
		expect(mapDeviceLoginError(error, cloudflareOauthClientId)).toBe(error);
	});
});
