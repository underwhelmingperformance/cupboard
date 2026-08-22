import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { trustRuleIdSchema } from '@cupboard/protocol/oidc';
import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema
} from '@cupboard/protocol/oidc';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { oidcTrust, tenantIdentity } from '../db/schema.ts';
import { currentServer, fetchPath, resetTestServer } from '../test-support.ts';

import { type TenantIdentity } from './tenant-identity-service.ts';

function identity(configVersion: number): TenantIdentity {
	return {
		tenant: tenantIdSchema.parse('acme'),
		issuer: oidcIssuerSchema.parse('https://host.test/t/acme'),
		audience: oidcAudienceSchema.parse('https://host.test/t/acme'),
		ownerIssuer: oidcIssuerSchema.parse('https://idp.test'),
		ownerSubject: oidcSubjectSchema.parse('owner'),
		ownerAudience: oidcAudienceSchema.parse('aud'),
		configVersion
	};
}

describe('configure RPC', () => {
	beforeEach(resetTestServer);

	it('stores the identity and seeds the owner rule from it', async () => {
		await fetchPath('/.well-known/jwks.json');

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await instance.configure(identity(2));

				const stored = drizzle(state.storage, { schema: { tenantIdentity } })
					.select()
					.from(tenantIdentity)
					.get();
				const owner = drizzle(state.storage, { schema: { oidcTrust } })
					.select()
					.from(oidcTrust)
					.where(eq(oidcTrust.id, trustRuleIdSchema.parse('owner')))
					.get();

				return {
					tenant: stored?.tenant,
					configVersion: stored?.configVersion,
					ownerIssuer: owner?.issuer,
					ownerClaims: owner?.claimsJson
				};
			}
		);

		expect(result).toStrictEqual({
			tenant: tenantIdSchema.parse('acme'),
			configVersion: 2,
			ownerIssuer: 'https://idp.test',
			ownerClaims: JSON.stringify({ sub: 'owner' })
		});
	});

	it('ignores a config version no greater than the applied one', async () => {
		await fetchPath('/.well-known/jwks.json');

		const version = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await instance.configure(identity(3));
				await instance.configure(identity(2));

				return drizzle(state.storage, { schema: { tenantIdentity } })
					.select()
					.from(tenantIdentity)
					.get()?.configVersion;
			}
		);

		expect(version).toBe(3);
	});

	it('rolls identity back when owner-rule seeding fails', async () => {
		await fetchPath('/.well-known/jwks.json');

		const version = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await expect(
					instance.configure({
						...identity(2),
						ownerIssuer: oidcIssuerSchema.parse('not-an-issuer')
					})
				).rejects.toThrow();

				return drizzle(state.storage, { schema: { tenantIdentity } })
					.select()
					.from(tenantIdentity)
					.get()?.configVersion;
			}
		);

		expect(version).toBe(1);
	});
});
