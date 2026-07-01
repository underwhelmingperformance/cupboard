import { controlCheckReportSchema } from '@cupboard/protocol/reports';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import {
	controlFetch,
	issueControlAdminToken,
	resetTestServer
} from '../test-support.ts';

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

		const token = await issueControlAdminToken();
		const response = await controlFetch('/control/check', {
			headers: { authorization: `Bearer ${token}` }
		});

		expect({
			status: response.status,
			body: controlCheckReportSchema.parse(await response.json())
		}).toStrictEqual({
			status: 200,
			body: { db: { result: 'ok' }, r2: { result: 'no-tenant' } }
		});
	});

	it.each([
		// The write-only credential may not read the probe key, so an accepted
		// one answers 403; a missing key would answer 404. Both mean accepted.
		['accepted credential (read denied)', 403, { result: 'ok' }],
		['accepted credential (missing key)', 404, { result: 'ok' }],
		// A rejected temporary credential answers 400 (InvalidArgument).
		['rejected credential', 400, { result: 'rejected', status: 400 }]
	])(
		'relays the probe verdict for a %s through the tenant Durable Object',
		async (_name, r2Status, expected) => {
			const token = await issueControlAdminToken();

			const probed: { url: string; method: string; hasToken: boolean }[] = [];
			vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				probed.push({
					url: request.url,
					method: request.method,
					hasToken: request.headers.has('x-amz-security-token')
				});

				return Promise.resolve(new Response(undefined, { status: r2Status }));
			});

			const response = await controlFetch('/control/check', {
				headers: { authorization: `Bearer ${token}` }
			});
			const [probe] = z
				.tuple([
					z.object({
						url: z.string(),
						method: z.string(),
						hasToken: z.boolean()
					})
				])
				.parse(probed);
			const signed = new URL(probe.url);

			expect({
				status: response.status,
				body: controlCheckReportSchema.parse(await response.json()),
				r2Probe: {
					protocol: signed.protocol,
					host: signed.host,
					pathname: signed.pathname,
					search: signed.search,
					method: probe.method,
					// The push mechanism carries the session token in the header, never
					// the query string, which R2 rejects for a temporary credential.
					hasToken: probe.hasToken
				}
			}).toStrictEqual({
				status: 200,
				body: { db: { result: 'ok' }, r2: expected },
				r2Probe: {
					protocol: 'https:',
					host: 'test-account-id.r2.cloudflarestorage.com',
					pathname: '/cupboard-blobs/staging/.cupboard-credential-probe/probe',
					search: '',
					method: 'GET',
					hasToken: true
				}
			});
		}
	);
});
