import { controlCheckReportSchema } from '@cupboard/protocol/reports';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import { passThrough } from '../do/pass-through.ts';
import {
	controlFetch,
	issueControlAdminToken,
	resetTestServer,
	testControlEnv
} from '../test-support.ts';

import { insertBulkTenants } from './bulk-tenants.test-support.ts';
import { controlCheck } from './control-plane.ts';

describe('control plane GET /control/check', () => {
	beforeEach(resetTestServer);
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('refuses without an admin token', async () => {
		const response = await controlFetch('/control/check');

		expect(response.status).toBe(401);
	});

	it('returns no-tenant when no cache exists to probe through', async () => {
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
					// The push sends the session token in the header. R2 rejects a
					// temporary credential when that token appears in the query string.
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

	it.each([250, 600])(
		'reads one tenant row to find a tenant to probe through with %i tenants',
		async (tenants) => {
			await insertBulkTenants(tenants);
			vi.stubGlobal('fetch', () =>
				Promise.resolve(new Response(undefined, { status: 404 }))
			);
			const counter = { tenantRows: 0 };

			await controlCheck(
				Object.assign({}, env, testControlEnv, {
					CUPBOARD_DB: countingDatabase(env.CUPBOARD_DB, counter)
				})
			);

			expect(counter).toStrictEqual({ tenantRows: 1 });
		}
	);
});

// A D1 binding that counts the rows that selects from the tenant table return.
function countingDatabase(
	binding: D1Database,
	counter: { tenantRows: number }
): D1Database {
	return new Proxy(binding, {
		get(target, property) {
			if (property !== 'prepare') {
				return passThrough(target, property);
			}

			return (query: string) =>
				countingStatement(target.prepare(query), query, counter);
		}
	});
}

function countingStatement(
	statement: D1PreparedStatement,
	query: string,
	counter: { tenantRows: number }
): D1PreparedStatement {
	const isTenantSelect = query.includes('from "tenant"');

	return new Proxy(statement, {
		get(target, property) {
			if (property === 'bind') {
				return (...values: unknown[]) =>
					countingStatement(target.bind(...values), query, counter);
			}

			if (property === 'raw') {
				return async () => {
					const rows = await target.raw();
					counter.tenantRows += isTenantSelect ? rows.length : 0;

					return rows;
				};
			}

			if (property === 'all') {
				return async () => {
					const result = await target.all();
					counter.tenantRows += isTenantSelect ? result.results.length : 0;

					return result;
				};
			}

			return passThrough(target, property);
		}
	});
}
