import { exports } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

describe('tenant Worker public entrypoint', () => {
	it('refuses direct HTTP reads without caching the response', async () => {
		const response = await exports.default.fetch(
			new Request('https://tenant.example/t/acme/nix-cache-info')
		);

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			body: await response.text()
		}).toStrictEqual({
			status: StatusCodes.NOT_FOUND,
			cacheControl: 'no-store',
			body: ''
		});
	});
});
