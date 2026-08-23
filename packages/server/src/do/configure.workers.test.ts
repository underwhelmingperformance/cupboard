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

import {
	oidcTrust,
	refreshTokenFamilies,
	refreshTokenMembers,
	tenantIdentity
} from '../db/schema.ts';
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

	it('revokes many owner families through indexed set deletes atomically', async () => {
		await fetchPath('/.well-known/jwks.json');

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				state.storage.sql.exec(
					`WITH RECURSIVE sequence(value) AS (
					   VALUES (0)
					   UNION ALL
					   SELECT value + 1 FROM sequence WHERE value < 197
					 )
					 INSERT INTO refresh_token_family
					   (id, active_member_id, generation, rule_id, subject, grants_json, created_at, expires_at)
					 SELECT printf('family-%d', value), printf('member-%d', value), 0,
					        CASE WHEN value = 197 THEN 'other' ELSE 'owner' END,
					        'subject', '[{"type":"cupboard_wildcard"}]',
					        '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
					 FROM sequence`
				);
				state.storage.sql.exec(
					`INSERT INTO refresh_token_member
					   (id, family_id, generation, secret_hash, created_at)
					 SELECT active_member_id, id, generation, 'hash', created_at
					 FROM refresh_token_family`
				);
				const plan = state.storage.sql.exec<{ detail: string }>(
					"EXPLAIN QUERY PLAN DELETE FROM refresh_token_member WHERE family_id IN (SELECT id FROM refresh_token_family WHERE rule_id = 'owner')"
				);
				const memberDeletePlan = Array.from(plan, (row) => row.detail);

				await instance.configure(identity(2));

				const database = drizzle(state.storage, {
					schema: {
						oidcTrust,
						refreshTokenFamilies,
						refreshTokenMembers,
						tenantIdentity
					}
				});

				return {
					memberDeletePlan,
					identity: database.select().from(tenantIdentity).get(),
					owner: database
						.select({
							issuer: oidcTrust.issuer,
							audience: oidcTrust.audience,
							claimsJson: oidcTrust.claimsJson
						})
						.from(oidcTrust)
						.where(eq(oidcTrust.id, trustRuleIdSchema.parse('owner')))
						.get(),
					families: database.select().from(refreshTokenFamilies).all(),
					members: database.select().from(refreshTokenMembers).all()
				};
			}
		);

		expect(result).toStrictEqual({
			memberDeletePlan: [
				'SEARCH refresh_token_member USING COVERING INDEX refresh_token_member_family_generation_unique (family_id=?)',
				'LIST SUBQUERY 1',
				'SEARCH refresh_token_family USING COVERING INDEX refresh_token_family_rule_idx (rule_id=?)',
				'CREATE BLOOM FILTER'
			],
			identity: {
				...identity(2),
				id: 'singleton'
			},
			owner: {
				issuer: 'https://idp.test',
				audience: 'aud',
				claimsJson: JSON.stringify({ sub: 'owner' })
			},
			families: [
				{
					id: 'family-197',
					activeMemberId: 'member-197',
					generation: 0,
					ruleId: 'other',
					subject: 'subject',
					grantsJson: JSON.stringify([{ type: 'cupboard_wildcard' }]),
					createdAt: '2026-01-01T00:00:00.000Z',
					expiresAt: '2099-01-01T00:00:00.000Z'
				}
			],
			members: [
				{
					id: 'member-197',
					familyId: 'family-197',
					generation: 0,
					secretHash: 'hash',
					createdAt: '2026-01-01T00:00:00.000Z'
				}
			]
		});
	});
});
