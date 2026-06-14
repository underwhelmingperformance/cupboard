import {
	tenantListResponseSchema,
	tenantMutateResponseSchema,
	tenantSummarySchema
} from '@cupboard/protocol/tenants';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { finaliseOffboardedTenant } from '../control/tenant-registry.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	controlFetch,
	issueControlAdminToken,
	resetTestServer
} from '../test-support.ts';

const createBody = {
	id: 'acme',
	readMode: 'private',
	ownerIssuer: 'https://idp.test',
	ownerSubject: 'owner',
	ownerAudience: 'aud'
};

function authed(token: string, method: string, body?: unknown): RequestInit {
	const headers: Record<string, string> = { authorization: `Bearer ${token}` };

	if (body === undefined) {
		return { method, headers };
	}

	headers['content-type'] = 'application/json';

	return { method, headers, body: JSON.stringify(body) };
}

describe('control plane tenant administration', () => {
	beforeEach(resetTestServer);

	it('rejects an unauthenticated create', async () => {
		const response = await controlFetch('/control/tenants', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(createBody)
		});

		expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
	});

	it('creates, lists, suspends, and offboards a tenant', async () => {
		const token = await issueControlAdminToken();

		const create = await controlFetch(
			'/control/tenants',
			authed(token, 'POST', createBody)
		);
		const created = tenantSummarySchema.parse(await create.json());

		const list = await controlFetch('/control/tenants', authed(token, 'GET'));
		const listed = tenantListResponseSchema.parse(await list.json());

		const suspend = await controlFetch(
			'/control/tenants/acme/suspend',
			authed(token, 'POST')
		);
		const suspended = tenantMutateResponseSchema.parse(await suspend.json());

		const offboard = await controlFetch(
			'/control/tenants/acme',
			authed(token, 'DELETE')
		);
		const offboarded = tenantMutateResponseSchema.parse(await offboard.json());

		expect({
			createStatus: create.status,
			created: {
				id: created.id,
				status: created.status,
				readMode: created.readMode
			},
			listedIds: listed.tenants.map((entry) => entry.id),
			suspended,
			offboarded
		}).toStrictEqual({
			createStatus: StatusCodes.OK,
			created: { id: 'acme', status: 'active', readMode: 'private' },
			// The harness provisions the fixture `v1` tenant, so the list carries it
			// alongside the one this test creates; `listTenants` orders by slug.
			listedIds: ['acme', 'v1'],
			suspended: { id: 'acme', status: 'suspended' },
			offboarded: { id: 'acme', status: 'offboarding' }
		});
	});

	it('treats repeated delete of an offboarded tenant as idempotent', async () => {
		const token = await issueControlAdminToken();

		await controlFetch('/control/tenants', authed(token, 'POST', createBody));
		await controlFetch('/control/tenants/acme', authed(token, 'DELETE'));
		await finaliseOffboardedTenant(
			drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
			'acme'
		);

		const repeatedDelete = await controlFetch(
			'/control/tenants/acme',
			authed(token, 'DELETE')
		);
		const repeatedBody = tenantMutateResponseSchema.parse(
			await repeatedDelete.json()
		);
		const suspend = await controlFetch(
			'/control/tenants/acme/suspend',
			authed(token, 'POST')
		);

		expect({
			repeatedDelete: repeatedDelete.status,
			repeatedBody,
			suspend: suspend.status
		}).toStrictEqual({
			repeatedDelete: StatusCodes.OK,
			repeatedBody: { id: 'acme', status: 'offboarded' },
			suspend: StatusCodes.GONE
		});
	});

	it('re-creates a matching slug idempotently but refuses a conflicting config', async () => {
		const token = await issueControlAdminToken();

		const first = await controlFetch(
			'/control/tenants',
			authed(token, 'POST', createBody)
		);
		const same = await controlFetch(
			'/control/tenants',
			authed(token, 'POST', createBody)
		);
		const conflicting = await controlFetch(
			'/control/tenants',
			authed(token, 'POST', { ...createBody, readMode: 'public' })
		);

		expect({
			first: first.status,
			same: same.status,
			conflicting: conflicting.status
		}).toStrictEqual({
			first: StatusCodes.OK,
			same: StatusCodes.OK,
			conflicting: StatusCodes.CONFLICT
		});
	});
});
