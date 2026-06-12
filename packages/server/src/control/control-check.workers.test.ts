import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import {
	controlFetch,
	mintControlAdminToken,
	resetTestServer
} from '../test-support.ts';

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === 'string') {
		return input;
	}

	return input instanceof URL ? input.href : input.url;
}

describe('control plane GET /control/check', () => {
	beforeEach(resetTestServer);
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('refuses without an admin token', async () => {
		const response = await controlFetch('/control/check');

		expect(response.status).toBe(401);
	});

	it('answers no-tenant when no cache exists to probe through', async () => {
		// The harness provisions a fixture tenant on reset; this case is the
		// deployment before its first cache, so the registry is emptied.
		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.delete(d1Schema.tenant)
			.run();

		const token = await mintControlAdminToken();
		const response = await controlFetch('/control/check', {
			headers: { authorization: `Bearer ${token}` }
		});

		expect({
			status: response.status,
			body: await response.json()
		}).toStrictEqual({
			status: 200,
			body: { r2: { result: 'no-tenant' } }
		});
	});

	it.each([
		// A missing probe object still answers 404 with a valid signature.
		['accepted signature', 404, { result: 'ok' }],
		['rejected signature', 403, { result: 'rejected', status: 403 }]
	])(
		'relays the probe verdict for an %s through the tenant Durable Object',
		async (_name, r2Status, expected) => {
			const token = await mintControlAdminToken();

			const probed: string[] = [];
			vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
				probed.push(requestUrl(input));

				return Promise.resolve(new Response(undefined, { status: r2Status }));
			});

			const response = await controlFetch('/control/check', {
				headers: { authorization: `Bearer ${token}` }
			});

			expect({
				status: response.status,
				body: await response.json(),
				probes: probed.length,
				signedR2Probe:
					probed[0]?.includes('.r2.cloudflarestorage.com/') === true &&
					probed[0].includes('X-Amz-Signature=')
			}).toStrictEqual({
				status: 200,
				body: { r2: expected },
				probes: 1,
				signedR2Probe: true
			});
		}
	);
});
