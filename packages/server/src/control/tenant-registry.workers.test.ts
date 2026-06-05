import {
	type ParsedTenantCreateBody,
	tenantCreateBodySchema
} from '@cupboard/protocol/tenants';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { TenantAlreadyExistsError, TenantNotFoundError } from '../errors.ts';

import {
	publishTenantManifest,
	readTenantManifest
} from './tenant-manifest.ts';
import {
	ensureTenant,
	listTenants,
	setTenantStatus
} from './tenant-registry.ts';

const now = '2026-01-01T00:00:00.000Z';

function database(): ReturnType<typeof drizzleD1<typeof d1Schema>> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

function createBody(
	id: string,
	readMode: 'public' | 'private' = 'private'
): ParsedTenantCreateBody {
	return tenantCreateBodySchema.parse({
		id,
		readMode,
		ownerIssuer: 'https://idp.test',
		ownerSubject: 'owner',
		ownerAudience: 'aud'
	});
}

function privateBodyWithRead(id: string): ParsedTenantCreateBody {
	return tenantCreateBodySchema.parse({
		id,
		readMode: 'private',
		read: {
			user: 'cupboard',
			password: 'correct-horse-battery-staple'
		},
		ownerIssuer: 'https://idp.test',
		ownerSubject: 'owner',
		ownerAudience: 'aud'
	});
}

// Mirrors the control plane's provisioning order minus the Durable Object
// configure: write the row, then publish the admission manifest.
async function provision(body: ParsedTenantCreateBody): Promise<void> {
	await ensureTenant(database(), body, now);
	await publishTenantManifest(database(), env.TENANT_CACHE);
}

describe('tenant registry', () => {
	it('creates a tenant, returns its summary, and publishes it to the manifest', async () => {
		const summary = await ensureTenant(database(), createBody('acme'), now);

		await publishTenantManifest(database(), env.TENANT_CACHE);
		const manifest = await readTenantManifest(env.TENANT_CACHE);

		expect({ summary, entry: manifest?.tenants.acme }).toStrictEqual({
			summary: {
				id: 'acme',
				status: 'active',
				readMode: 'private',
				ownerIssuer: 'https://idp.test',
				ownerSubject: 'owner',
				ownerAudience: 'aud',
				configVersion: 1,
				createdAt: now
			},
			entry: { status: 'active', readMode: 'private', configVersion: 1 }
		});
	});

	it('is idempotent for a matching re-create', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		const again = await ensureTenant(database(), createBody('acme'), now);

		expect(again.id).toBe('acme');
	});

	it('refuses a conflicting re-create of the same slug', async () => {
		await ensureTenant(database(), createBody('acme', 'private'), now);

		await expect(
			ensureTenant(database(), createBody('acme', 'public'), now)
		).rejects.toThrow(TenantAlreadyExistsError);
	});

	it('publishes only the hashed private-read verifier', async () => {
		await provision(privateBodyWithRead('acme'));

		const manifest = await readTenantManifest(env.TENANT_CACHE);
		const verifier = manifest?.tenants.acme?.readVerifier;

		expect({
			user: verifier?.user,
			passwordHash: typeof verifier?.passwordHash,
			passwordSalt: typeof verifier?.passwordSalt,
			hashIsPlaintext: verifier?.passwordHash === 'correct-horse-battery-staple'
		}).toStrictEqual({
			user: 'cupboard',
			passwordHash: 'string',
			passwordSalt: 'string',
			hashIsPlaintext: false
		});
	});

	it('lists tenants in id order', async () => {
		await ensureTenant(database(), createBody('beta'), now);
		await ensureTenant(database(), createBody('alpha'), now);

		const tenants = await listTenants(database());
		const ids = tenants.map((summary) => summary.id);

		expect(ids).toStrictEqual(['alpha', 'beta']);
	});

	it.each([
		{ name: 'suspends', status: 'suspended' as const },
		{ name: 'offboards', status: 'offboarding' as const }
	])('$name a tenant and reflects it in the manifest', async ({ status }) => {
		await provision(createBody('acme'));

		const summary = await setTenantStatus(database(), 'acme', status);

		await publishTenantManifest(database(), env.TENANT_CACHE);
		const manifest = await readTenantManifest(env.TENANT_CACHE);

		expect({
			returned: summary.status,
			published: manifest?.tenants.acme?.status
		}).toStrictEqual({ returned: status, published: status });
	});

	it('throws not found when mutating an unknown tenant', async () => {
		await expect(
			setTenantStatus(database(), 'ghost', 'suspended')
		).rejects.toThrow(TenantNotFoundError);
	});
});
