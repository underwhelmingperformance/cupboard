import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { controlContract } from '@cupboard/protocol/contract';
import { createORPCClient, ORPCError, safe } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { ResponseValidationPlugin } from '@orpc/contract/plugins';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	adminGrants,
	cacheWriteGrants,
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
		const retiring = z.object({ kid: z.string() }).parse(rotated.retiring);
		const retired = await client.keys.retire({ kid: retiring.kid });

		expect({
			listed: listed.keys
				.map(({ kid, retired }) => ({ kid, retired }))
				.toSorted((left, right) => byCodeUnit(left.kid, right.kid)),
			retired
		}).toStrictEqual({
			listed: [
				{ kid: retiring.kid, retired: false },
				{ kid: rotated.kid, retired: false }
			].toSorted((left, right) => byCodeUnit(left.kid, right.kid)),
			retired: { kid: retiring.kid, retired: true }
		});
	});

	it('drives the control trust rules through the derived client', async () => {
		const client = controlClient(await issueControlAdminToken());

		const added = await client.oidcTrust.add({
			issuer: 'https://token.actions.githubusercontent.com',
			audience: 'https://cupboard.example/control',
			claims: { sub: 'repo:acme/provision:ref:refs/heads/main' },
			permittedGrants: [
				{
					type: 'cupboard_tenant',
					actions: ['tenant:create'],
					resources: { tenant: { exact: 'acme', validate: 'tenant' } }
				}
			]
		});
		const id = z.uuid().parse(added.id);
		const fetched = await client.oidcTrust.get({ id });
		const removed = await client.oidcTrust.remove({ id });
		const listed = await client.oidcTrust.list();

		expect({
			added: added.permittedGrants.length,
			fetchedId: fetched.id,
			removed,
			disabledInListing: listed.rules.find((rule) => rule.id === id)?.disabled
		}).toStrictEqual({
			added: 1,
			fetchedId: id,
			removed: { id, removed: true },
			disabledInListing: true
		});
	});

	it('refuses a control trust write from a token scoped away from it', async () => {
		const scoped = await issueControlAdminToken('writer', cacheWriteGrants());
		const client = controlClient(scoped);

		const [error] = await safe(client.oidcTrust.list());

		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({ code: 'FORBIDDEN' });
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

	it('rebuilds tenant membership through the derived client', async () => {
		const client = controlClient(await issueControlAdminToken());

		await client.tenants.create({
			id: 'acme',
			readMode: 'private',
			ownerIssuer: 'https://idp.test',
			ownerSubject: 'owner',
			ownerAudience: 'aud'
		});

		// The harness provisions the fixture `v1` tenant alongside the created one.
		expect(await client.membership.rebuild()).toStrictEqual({ tenants: 2 });
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

		expect({ isDefined, data }).toStrictEqual({
			isDefined: true,
			data: undefined
		});
		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({
			defined: true,
			code: 'UNAUTHORIZED',
			status: StatusCodes.UNAUTHORIZED
		});
	});

	it('refuses a write-scoped control token as FORBIDDEN', async () => {
		const client = controlClient(
			await issueControlAdminToken('writer', cacheWriteGrants())
		);

		const [error, data, isDefined] = await safe(client.tenants.list());

		expect({ isDefined, data }).toStrictEqual({
			isDefined: true,
			data: undefined
		});
		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({
			defined: true,
			code: 'FORBIDDEN',
			status: StatusCodes.FORBIDDEN
		});
	});

	it('refuses a tenant-plane token as UNAUTHORIZED', async () => {
		// A tenant admin token is signed by the tenant's auth key for the tenant
		// audience; presented to the control plane it must not verify.
		const client = controlClient(await issueServerSignedToken(adminGrants()));

		const [error, data, isDefined] = await safe(client.tenants.list());

		expect({ isDefined, data }).toStrictEqual({
			isDefined: true,
			data: undefined
		});
		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({
			defined: true,
			code: 'UNAUTHORIZED',
			status: StatusCodes.UNAUTHORIZED
		});
	});
});
