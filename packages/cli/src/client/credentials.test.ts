import { describe, expect, it, vi } from 'vitest';

import { bearerAttempt, type TokenProvider } from './credentials.ts';

describe('bearerAttempt', () => {
	it('refreshes a provider credential once after a 401', async () => {
		const get = vi.fn(() => Promise.resolve('initial-token'));
		const refresh = vi.fn(() => Promise.resolve('renewed-token'));
		const provider: TokenProvider = {
			get,
			refresh
		};
		const initial = await bearerAttempt(provider, { 'x-request': 'value' });
		const renewed = await initial.refreshAfterAuthenticationFailure();
		const repeated = await renewed?.refreshAfterAuthenticationFailure();

		expect({
			initial: initial.headers,
			renewed: renewed?.headers,
			repeated,
			getCalls: get.mock.calls.length,
			refreshCalls: refresh.mock.calls.length
		}).toStrictEqual({
			initial: {
				authorization: 'Bearer initial-token',
				'x-request': 'value'
			},
			renewed: {
				authorization: 'Bearer renewed-token',
				'x-request': 'value'
			},
			repeated: undefined,
			getCalls: 1,
			refreshCalls: 1
		});
	});

	it('does not refresh a fixed credential after a 401', async () => {
		const attempt = await bearerAttempt('fixed-token');

		expect({
			headers: attempt.headers,
			refreshed: await attempt.refreshAfterAuthenticationFailure()
		}).toStrictEqual({
			headers: { authorization: 'Bearer fixed-token' },
			refreshed: undefined
		});
	});
});
