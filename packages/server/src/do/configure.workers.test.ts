import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { oidcTrust, tenantIdentity } from '../db/schema.ts';
import { currentServer, fetchPath, resetTestServer } from '../test-support.ts';

function identity(configVersion: number): {
	tenant: string;
	issuer: string;
	audience: string;
	ownerIssuer: string;
	ownerSubject: string;
	ownerAudience: string;
	configVersion: number;
} {
	return {
		tenant: 'acme',
		issuer: 'https://host.test/t/acme',
		audience: 'https://host.test/t/acme',
		ownerIssuer: 'https://idp.test',
		ownerSubject: 'owner',
		ownerAudience: 'aud',
		configVersion
	};
}

describe('configure RPC', () => {
	beforeEach(resetTestServer);

	it('stores the identity and seeds the owner rule from it', async () => {
		// Initialise so the schema exists, then apply the identity.
		await fetchPath('/.well-known/jwks.json');

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await instance.configure(identity(1));

				const stored = drizzle(state.storage, { schema: { tenantIdentity } })
					.select()
					.from(tenantIdentity)
					.get();
				const owner = drizzle(state.storage, { schema: { oidcTrust } })
					.select()
					.from(oidcTrust)
					.where(eq(oidcTrust.id, 'owner'))
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
			tenant: 'acme',
			configVersion: 1,
			ownerIssuer: 'https://idp.test',
			ownerClaims: JSON.stringify({ sub: 'owner' })
		});
	});

	it('ignores a config version no greater than the applied one', async () => {
		await fetchPath('/.well-known/jwks.json');

		const version = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await instance.configure(identity(2));
				await instance.configure(identity(1));

				return drizzle(state.storage, { schema: { tenantIdentity } })
					.select()
					.from(tenantIdentity)
					.get()?.configVersion;
			}
		);

		expect(version).toBe(2);
	});
});
