import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { controlContract } from '@cupboard/protocol/contract';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import { createORPCClient, ORPCError, safe } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { ResponseValidationPlugin } from '@orpc/contract/plugins';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { env } from 'cloudflare:workers';
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
const readPassword = 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23';

function cacheCredentialGrants(
	tenant: string,
	actions: readonly string[]
): AuthorizationDetails {
	return authorizationDetailsSchema.parse([
		{ type: 'cupboard_tenant', actions, tenant }
	]);
}

function controlClient(token?: string): ControlClient {
	const link = new OpenAPILink(controlContract, {
		url: `${currentOrigin()}/control`,
		headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
		fetch: (request) => controlWorkerFetch(request),
		plugins: [new ResponseValidationPlugin(controlContract)]
	});

	return createORPCClient(link);
}

async function provisionNamedCacheLifecycle(tenant: string): Promise<void> {
	await env.CUPBOARD_DB.prepare(
		`INSERT INTO cache_lifecycle (
			tenant,
			cache_kind,
			cache_name,
			access,
			generation,
			read_revision,
			deleted_at,
			updated_at
		) VALUES (?, 'named', 'builds', 'public', 1, 1, NULL, ?)`
	)
		.bind(tenant, '2026-01-01T00:00:00.000Z')
		.run();
}

describe('control contract round trip', () => {
	beforeEach(resetTestServer);

	it('initialises the immutable instance name idempotently', async () => {
		await env.CUPBOARD_DB.prepare('DELETE FROM instance_config').run();
		const client = controlClient(await issueControlAdminToken());
		const unconfigured = await client.instance.get();

		const first = await client.instance.initialise({ name: 'forge' });
		const second = await client.instance.initialise({ name: 'forge' });
		const read = await client.instance.get();
		const [conflict] = await safe(
			client.instance.initialise({ name: 'another' })
		);

		expect({ unconfigured, first, second, read }).toStrictEqual({
			unconfigured: { state: 'unconfigured' },
			first: { state: 'configured', name: 'forge' },
			second: { state: 'configured', name: 'forge' },
			read: { state: 'configured', name: 'forge' }
		});
		expect(conflict).toBeInstanceOf(ORPCError);
		expect(conflict).toMatchObject({ status: StatusCodes.CONFLICT });
	});

	it('rotates, lists, and retires control keys through the derived client', async () => {
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

	it('creates, lists, and removes control trust rules through the derived client', async () => {
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

	it('refuses a loopback HTTP control issuer outside local development', async () => {
		const client = controlClient(await issueControlAdminToken());
		const [error] = await safe(
			client.oidcTrust.add({
				issuer: 'http://127.0.0.1:8788',
				audience: 'cupboard-control',
				claims: { sub: 'automation' },
				permittedGrants: [{ type: 'cupboard_wildcard' }]
			})
		);

		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({ status: StatusCodes.BAD_REQUEST });
	});

	it('replaces a legacy-normalised control issuer through exact add and remove operations', async () => {
		const client = controlClient(await issueControlAdminToken());
		const body = {
			issuer: 'https://idp.example.test',
			audience: 'cupboard-control',
			claims: { sub: 'automation' },
			permittedGrants: [{ type: 'cupboard_wildcard' as const }]
		};
		const legacy = await client.oidcTrust.add(body);
		const exact = await client.oidcTrust.add({
			...body,
			issuer: `${body.issuer}/`
		});
		const removed = await client.oidcTrust.remove({ id: legacy.id });
		const repeated = await client.oidcTrust.remove({ id: legacy.id });

		expect({ exactIssuer: exact.issuer, removed, repeated }).toStrictEqual({
			exactIssuer: `${body.issuer}/`,
			removed: { id: legacy.id, removed: true },
			repeated: { id: legacy.id, removed: false }
		});
	});

	it('rejects a control trust write from a token without its scope', async () => {
		const scoped = await issueControlAdminToken('writer', cacheWriteGrants());
		const client = controlClient(scoped);

		const [error] = await safe(client.oidcTrust.list());

		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({ code: 'FORBIDDEN' });
	});

	it('creates, lists, suspends, and offboards tenants through the derived client', async () => {
		const client = controlClient(await issueControlAdminToken());

		const created = await client.tenants.create({
			id: 'acme',
			defaultCacheAccess: 'private',
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
				status: created.status
			},
			// The harness provisions the fixture `v1` tenant alongside.
			listedIds: listed.tenants.map((entry) => entry.id),
			suspended,
			removed
		}).toStrictEqual({
			created: { id: 'acme', status: 'active' },
			listedIds: ['acme', 'v1'],
			suspended: { id: 'acme', status: 'suspended' },
			removed: { id: 'acme', status: 'offboarding' }
		});
	});

	it.each([
		'https://idp.test?',
		'https://idp.test#',
		'https://@idp.test',
		'https://:@idp.test'
	])(
		'rejects owner issuer %s without reserving the tenant slug',
		async (ownerIssuer) => {
			const token = await issueControlAdminToken();
			const invalid = await controlWorkerFetch(
				new Request(`${currentOrigin()}/control/tenants`, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						id: 'acme',
						defaultCacheAccess: 'private',
						ownerIssuer,
						ownerSubject: 'owner',
						ownerAudience: 'aud'
					})
				})
			);
			const created = await controlClient(token).tenants.create({
				id: 'acme',
				defaultCacheAccess: 'private',
				ownerIssuer: 'https://idp.test',
				ownerSubject: 'owner',
				ownerAudience: 'aud'
			});

			expect({ invalid: invalid.status, created: created.id }).toStrictEqual({
				invalid: StatusCodes.BAD_REQUEST,
				created: 'acme'
			});
		}
	);

	it('rejects a loopback HTTP owner issuer before reserving the tenant slug', async () => {
		const token = await issueControlAdminToken();
		const invalid = await controlWorkerFetch(
			new Request(`${currentOrigin()}/control/tenants`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					id: 'acme',
					defaultCacheAccess: 'private',
					ownerIssuer: 'http://127.0.0.1:8788',
					ownerSubject: 'owner',
					ownerAudience: 'aud'
				})
			})
		);
		const created = await controlClient(token).tenants.create({
			id: 'acme',
			defaultCacheAccess: 'private',
			ownerIssuer: 'https://idp.test',
			ownerSubject: 'owner',
			ownerAudience: 'aud'
		});

		expect({ invalid: invalid.status, created: created.id }).toStrictEqual({
			invalid: StatusCodes.BAD_REQUEST,
			created: 'acme'
		});
	});

	it('rebuilds tenant membership through the derived client', async () => {
		const client = controlClient(await issueControlAdminToken());

		await client.tenants.create({
			id: 'acme',
			defaultCacheAccess: 'private',
			ownerIssuer: 'https://idp.test',
			ownerSubject: 'owner',
			ownerAudience: 'aud'
		});

		// The harness provisions the fixture `v1` tenant alongside the created one.
		expect(await client.membership.rebuild()).toStrictEqual({ tenants: 2 });
	});

	it('updates tenant status and fallback read credentials through the derived client', async () => {
		const client = controlClient(await issueControlAdminToken());

		await client.tenants.create({
			id: 'acme',
			defaultCacheAccess: 'private',
			ownerIssuer: 'https://idp.test',
			ownerSubject: 'owner',
			ownerAudience: 'aud'
		});
		const suspended = await client.tenants.suspend({ id: 'acme' });
		const resumed = await client.tenants.resume({ id: 'acme' });
		const rotated = await client.tenants.rotateReadCredential({
			id: 'acme',
			read: {
				user: 'reader',
				password: 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23'
			}
		});
		const cleared = await client.tenants.clearReadCredential({ id: 'acme' });

		expect({ suspended, resumed, rotated, cleared }).toStrictEqual({
			suspended: { id: 'acme', status: 'suspended' },
			resumed: { id: 'acme', status: 'active' },
			rotated: { id: 'acme', hasCredential: true },
			cleared: { id: 'acme', hasCredential: false }
		});
	});

	it('sets and clears a named cache read credential through the derived client', async () => {
		const client = controlClient(await issueControlAdminToken());

		await client.tenants.create({
			id: 'acme',
			defaultCacheAccess: 'public',
			ownerIssuer: 'https://idp.test',
			ownerSubject: 'owner',
			ownerAudience: 'aud'
		});
		await provisionNamedCacheLifecycle('acme');
		const rotated = await client.tenants.rotateNamedCacheReadCredential({
			id: 'acme',
			cacheName: 'builds',
			read: { user: 'reader', password: readPassword }
		});
		const cleared = await client.tenants.clearNamedCacheReadCredential({
			id: 'acme',
			cacheName: 'builds'
		});

		expect({ rotated, cleared }).toStrictEqual({
			rotated: {
				id: 'acme',
				cache: { kind: 'named', name: 'builds' },
				hasCredential: true
			},
			cleared: {
				id: 'acme',
				cache: { kind: 'named', name: 'builds' },
				hasCredential: false
			}
		});
	});

	// The two procedures declare their own operations and take the tenant slug as
	// their resource, so authority over one tenant does not reach another, and
	// authority over the tenant credential does not reach a cache credential.
	it.each([
		{
			name: 'another tenant',
			grants: cacheCredentialGrants('beta', [
				'tenant:rotate-cache-read-credential'
			])
		},
		{
			name: 'the tenant credential only',
			grants: cacheCredentialGrants('acme', ['tenant:rotate-read-credential'])
		}
	])('returns FORBIDDEN for a token scoped to $name', async ({ grants }) => {
		const admin = controlClient(await issueControlAdminToken());
		await admin.tenants.create({
			id: 'acme',
			defaultCacheAccess: 'public',
			ownerIssuer: 'https://idp.test',
			ownerSubject: 'owner',
			ownerAudience: 'aud'
		});
		await provisionNamedCacheLifecycle('acme');
		const client = controlClient(
			await issueControlAdminToken('operator', grants)
		);

		const [error] = await safe(
			client.tenants.rotateNamedCacheReadCredential({
				id: 'acme',
				cacheName: 'builds',
				read: { user: 'reader', password: readPassword }
			})
		);

		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({
			defined: true,
			code: 'FORBIDDEN',
			status: StatusCodes.FORBIDDEN
		});
	});

	it('accepts a token scoped to the tenant for both cache credential procedures', async () => {
		const admin = controlClient(await issueControlAdminToken());
		await admin.tenants.create({
			id: 'acme',
			defaultCacheAccess: 'public',
			ownerIssuer: 'https://idp.test',
			ownerSubject: 'owner',
			ownerAudience: 'aud'
		});
		await provisionNamedCacheLifecycle('acme');
		const client = controlClient(
			await issueControlAdminToken(
				'operator',
				cacheCredentialGrants('acme', [
					'tenant:rotate-cache-read-credential',
					'tenant:clear-cache-read-credential'
				])
			)
		);

		const rotated = await client.tenants.rotateNamedCacheReadCredential({
			id: 'acme',
			cacheName: 'builds',
			read: { user: 'reader', password: readPassword }
		});
		const cleared = await client.tenants.clearNamedCacheReadCredential({
			id: 'acme',
			cacheName: 'builds'
		});

		expect({ rotated, cleared }).toStrictEqual({
			rotated: {
				id: 'acme',
				cache: { kind: 'named', name: 'builds' },
				hasCredential: true
			},
			cleared: {
				id: 'acme',
				cache: { kind: 'named', name: 'builds' },
				hasCredential: false
			}
		});
	});

	it('returns UNAUTHORIZED when the control token is missing', async () => {
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

	it('returns FORBIDDEN for a write-scoped control token', async () => {
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

	it('returns UNAUTHORIZED for a tenant-plane token', async () => {
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
