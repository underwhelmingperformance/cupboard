import {
	type ParsedTenantCreateBody,
	tenantCreateBodySchema
} from '@cupboard/protocol/tenants';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import { publishTenantManifest } from '../control/tenant-manifest.ts';
import { ensureTenant, setTenantStatus } from '../control/tenant-registry.ts';
import * as d1Schema from '../db/d1-schema.ts';

import { admitTenant } from './admission.ts';

const now = '2026-01-01T00:00:00.000Z';

function database(): ReturnType<typeof drizzleD1<typeof d1Schema>> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

function createBody(id: string): ParsedTenantCreateBody {
	return tenantCreateBodySchema.parse({
		id,
		readMode: 'private',
		ownerIssuer: 'https://idp.test',
		ownerSubject: 'owner',
		ownerAudience: 'aud'
	});
}

describe('admitTenant', () => {
	it('returns undefined for a slug absent from the manifest', async () => {
		expect(await admitTenant(env.TENANT_CACHE, 'ghost')).toBeUndefined();
	});

	it('returns the manifest entry for a provisioned slug', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await publishTenantManifest(database(), env.TENANT_CACHE);

		expect(await admitTenant(env.TENANT_CACHE, 'acme')).toStrictEqual({
			status: 'active',
			readMode: 'private',
			configVersion: 1
		});
	});

	it('still admits a suspended tenant, carrying its status for the caller to gate', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await setTenantStatus(database(), 'acme', 'suspended');
		await publishTenantManifest(database(), env.TENANT_CACHE);

		expect(await admitTenant(env.TENANT_CACHE, 'acme')).toStrictEqual({
			status: 'suspended',
			readMode: 'private',
			configVersion: 1
		});
	});
});
