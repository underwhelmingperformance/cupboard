import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	controlFetch,
	mintControlAdminToken,
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
		const token = await mintControlAdminToken();

		const create = await controlFetch(
			'/control/tenants',
			authed(token, 'POST', createBody)
		);
		const created = await create.json<{
			id: string;
			status: string;
			readMode: string;
		}>();

		const list = await controlFetch('/control/tenants', authed(token, 'GET'));
		const listed = await list.json<{ tenants: { id: string }[] }>();

		const suspend = await controlFetch(
			'/control/tenants/acme/suspend',
			authed(token, 'POST')
		);
		const suspended = await suspend.json<{ id: string; status: string }>();

		const offboard = await controlFetch(
			'/control/tenants/acme',
			authed(token, 'DELETE')
		);
		const offboarded = await offboard.json<{ id: string; status: string }>();

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
			listedIds: ['acme'],
			suspended: { id: 'acme', status: 'suspended' },
			offboarded: { id: 'acme', status: 'offboarding' }
		});
	});

	it('refuses a duplicate slug with 409', async () => {
		const token = await mintControlAdminToken();

		await controlFetch('/control/tenants', authed(token, 'POST', createBody));
		const duplicate = await controlFetch(
			'/control/tenants',
			authed(token, 'POST', createBody)
		);

		expect(duplicate.status).toBe(StatusCodes.CONFLICT);
	});
});
