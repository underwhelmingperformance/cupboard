import { controlContract } from '@cupboard/protocol/contract';
import { createORPCClient, isDefinedError, safe } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { ResponseValidationPlugin } from '@orpc/contract/plugins';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	controlWorkerFetch,
	currentOrigin,
	issueControlAdminToken,
	issueServerSignedToken,
	resetTestServer
} from '../test-support.ts';

type ControlClient = JsonifiedClient<
	ContractRouterClient<typeof controlContract>
>;

// The real derived client, exactly as the CLI builds it: the OpenAPI link
// over the control contract at the worker's `/control` prefix, with
// responses validated against the contract's output schemas.
function controlClient(token?: string): ControlClient {
	const link = new OpenAPILink(controlContract, {
		url: `${currentOrigin()}/control`,
		headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
		fetch: (request) => controlWorkerFetch(request),
		plugins: [new ResponseValidationPlugin(controlContract)]
	});

	return createORPCClient(link);
}

describe('control contract round trip', () => {
	beforeEach(resetTestServer);

	it('drives the control keys through the derived client', async () => {
		const client = controlClient(await issueControlAdminToken());

		const rotated = await client.keys.rotate();
		const listed = await client.keys.list();
		const retired =
			rotated.retiring === undefined
				? undefined
				: await client.keys.retire({ kid: rotated.retiring.kid });

		expect({
			newKeyListed: listed.keys.some(
				(key) => key.kid === rotated.kid && !key.retired
			),
			retired
		}).toStrictEqual({
			newKeyListed: true,
			retired: { kid: rotated.retiring?.kid, retired: true }
		});
	});

	it('drives the tenant registry through the derived client', async () => {
		const client = controlClient(await issueControlAdminToken());

		const created = await client.tenants.create({
			id: 'acme',
			readMode: 'private',
			ownerIssuer: 'https://idp.test',
			ownerSubject: 'owner',
			ownerAudience: 'aud'
		});
		const listed = await client.tenants.list();
		const suspended = await client.tenants.suspend({ id: 'acme' });
		const removed = await client.tenants.remove({ id: 'acme' });

		expect({
			created: {
				id: created.id,
				status: created.status,
				readMode: created.readMode
			},
			// The harness provisions the fixture `v1` tenant alongside.
			listedIds: listed.tenants.map((entry) => entry.id),
			suspended,
			removed
		}).toStrictEqual({
			created: { id: 'acme', status: 'active', readMode: 'private' },
			listedIds: ['acme', 'v1'],
			suspended: { id: 'acme', status: 'suspended' },
			removed: { id: 'acme', status: 'offboarding' }
		});
	});

	it('drives resume, read mode and read credential through the derived client', async () => {
		const client = controlClient(await issueControlAdminToken());

		await client.tenants.create({
			id: 'acme',
			readMode: 'private',
			ownerIssuer: 'https://idp.test',
			ownerSubject: 'owner',
			ownerAudience: 'aud'
		});
		const suspended = await client.tenants.suspend({ id: 'acme' });
		const resumed = await client.tenants.resume({ id: 'acme' });
		const readMode = await client.tenants.setReadMode({
			id: 'acme',
			readMode: 'public'
		});
		const rotated = await client.tenants.rotateReadCredential({
			id: 'acme',
			read: { user: 'reader', password: 'correct-horse-battery-staple' }
		});
		const cleared = await client.tenants.clearReadCredential({ id: 'acme' });

		expect({ suspended, resumed, readMode, rotated, cleared }).toStrictEqual({
			suspended: { id: 'acme', status: 'suspended' },
			resumed: { id: 'acme', status: 'active' },
			readMode: { id: 'acme', readMode: 'public' },
			rotated: { id: 'acme', readMode: 'public' },
			cleared: { id: 'acme', readMode: 'public' }
		});
	});

	it('refuses a missing control token as the defined UNAUTHORIZED error', async () => {
		const client = controlClient();

		const [error, data, isDefined] = await safe(client.tenants.list());

		if (!isDefinedError(error)) {
			throw new Error('expected a defined contract error');
		}

		expect({
			isDefined,
			data,
			code: error.code,
			status: error.status
		}).toStrictEqual({
			isDefined: true,
			data: undefined,
			code: 'UNAUTHORIZED',
			status: StatusCodes.UNAUTHORIZED
		});
	});

	it('refuses a write-scoped control token as FORBIDDEN', async () => {
		const client = controlClient(
			await issueControlAdminToken('writer', 'write')
		);

		const [error, data, isDefined] = await safe(client.tenants.list());

		if (!isDefinedError(error)) {
			throw new Error('expected a defined contract error');
		}

		expect({
			isDefined,
			data,
			code: error.code,
			status: error.status
		}).toStrictEqual({
			isDefined: true,
			data: undefined,
			code: 'FORBIDDEN',
			status: StatusCodes.FORBIDDEN
		});
	});

	it('refuses a tenant-plane token as UNAUTHORIZED', async () => {
		// A tenant admin token is signed by the tenant's auth key for the tenant
		// audience; presented to the control plane it must not verify.
		const client = controlClient(await issueServerSignedToken('admin'));

		const [error, data, isDefined] = await safe(client.tenants.list());

		if (!isDefinedError(error)) {
			throw new Error('expected a defined contract error');
		}

		expect({
			isDefined,
			data,
			code: error.code,
			status: error.status
		}).toStrictEqual({
			isDefined: true,
			data: undefined,
			code: 'UNAUTHORIZED',
			status: StatusCodes.UNAUTHORIZED
		});
	});
});
