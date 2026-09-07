import { exports } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

/**
 * `CachedTenantReads` takes the generation from the request, so a caller that
 * could reach it directly could read the objects of a deleted incarnation.
 * Nothing routes here: the control Worker arrives over the service binding
 * instead. This case holds the refusal that makes that true.
 */
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
