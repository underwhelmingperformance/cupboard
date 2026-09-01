import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { GlobalAdminAlreadyClaimedError } from '../errors.ts';

import { claimGlobalAdmin, isGlobalAdminPrincipal } from './global-admin.ts';

const issuer = 'https://idp.example.test';
const audience = 'cupboard-control-client';
const t0 = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
const t1 = isoTimestampSchema.parse('2026-01-01T00:01:00.000Z');

function controlDatabase(): ReturnType<typeof drizzleD1<typeof d1Schema>> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

async function adminAndTrust(
	database: ReturnType<typeof controlDatabase>
): Promise<{
	admin:
		| undefined
		| { issuer: string; subject: string; audience: string; claimedAt: string };
	trust: { id: string; issuer: string; audience: string; claimsJson: string }[];
}> {
	const admin = await database
		.select({
			issuer: d1Schema.globalAdmin.issuer,
			subject: d1Schema.globalAdmin.subject,
			audience: d1Schema.globalAdmin.audience,
			claimedAt: d1Schema.globalAdmin.claimedAt
		})
		.from(d1Schema.globalAdmin)
		.get();
	const trust = await database
		.select({
			id: d1Schema.controlTrust.id,
			issuer: d1Schema.controlTrust.issuer,
			audience: d1Schema.controlTrust.audience,
			claimsJson: d1Schema.controlTrust.claimsJson
		})
		.from(d1Schema.controlTrust)
		.all();

	return { admin, trust };
}

describe('claimGlobalAdmin', () => {
	it('claims the singleton and seeds a control trust rule pinning the subject', async () => {
		const database = controlDatabase();

		const outcome = await claimGlobalAdmin(
			database,
			{ issuer, subject: 'owner', audience },
			t0
		);
		const state = await adminAndTrust(database);

		expect({ outcome, ...state }).toStrictEqual({
			outcome: { claimed: true },
			admin: { issuer, subject: 'owner', audience, claimedAt: t0 },
			trust: [
				{
					id: 'signup',
					issuer,
					audience,
					claimsJson: JSON.stringify({ sub: 'owner' })
				}
			]
		});
	});

	it('is idempotent for a re-claim by the same principal, not duplicating trust', async () => {
		const database = controlDatabase();

		await claimGlobalAdmin(
			database,
			{ issuer, subject: 'owner', audience },
			t0
		);
		const outcome = await claimGlobalAdmin(
			database,
			{ issuer, subject: 'owner', audience },
			t1
		);
		const state = await adminAndTrust(database);

		expect({ outcome, ...state }).toStrictEqual({
			outcome: { claimed: false },
			admin: { issuer, subject: 'owner', audience, claimedAt: t0 },
			trust: [
				{
					id: 'signup',
					issuer,
					audience,
					claimsJson: JSON.stringify({ sub: 'owner' })
				}
			]
		});
	});

	it('repairs an issuer whose trailing slash an older release removed', async () => {
		const database = controlDatabase();
		await database.batch([
			database.insert(d1Schema.globalAdmin).values({
				id: 'singleton',
				issuer,
				subject: 'owner',
				audience,
				claimedAt: t0
			}),
			database.insert(d1Schema.controlTrust).values({
				id: trustRuleIdSchema.parse('signup'),
				issuer,
				audience,
				claimsJson: JSON.stringify({ sub: 'owner' }),
				permittedGrantsJson: JSON.stringify([{ type: 'cupboard_wildcard' }]),
				createdAt: t0
			})
		]);
		const exactIssuer = `${issuer}/`;

		const repaired = await claimGlobalAdmin(
			database,
			{ issuer: exactIssuer, subject: 'owner', audience },
			t1
		);
		const repeated = await claimGlobalAdmin(
			database,
			{ issuer: exactIssuer, subject: 'owner', audience },
			t1
		);

		expect({
			repaired,
			repeated,
			...(await adminAndTrust(database))
		}).toStrictEqual({
			repaired: { claimed: false },
			repeated: { claimed: false },
			admin: {
				issuer: exactIssuer,
				subject: 'owner',
				audience,
				claimedAt: t0
			},
			trust: [
				{
					id: 'signup',
					issuer: exactIssuer,
					audience,
					claimsJson: JSON.stringify({ sub: 'owner' })
				}
			]
		});
	});

	it('repairs an empty audience written by the preceding Worker', async () => {
		const database = controlDatabase();
		await database.batch([
			database.insert(d1Schema.globalAdmin).values({
				id: 'singleton',
				issuer,
				subject: 'owner',
				claimedAt: t0
			}),
			database.insert(d1Schema.controlTrust).values({
				id: trustRuleIdSchema.parse('signup'),
				issuer,
				audience,
				claimsJson: JSON.stringify({ sub: 'owner' }),
				permittedGrantsJson: JSON.stringify([{ type: 'cupboard_wildcard' }]),
				createdAt: t0
			})
		]);

		const outcome = await claimGlobalAdmin(
			database,
			{ issuer, subject: 'owner', audience },
			t1
		);

		expect({ outcome, ...(await adminAndTrust(database)) }).toStrictEqual({
			outcome: { claimed: false },
			admin: { issuer, subject: 'owner', audience, claimedAt: t0 },
			trust: [
				{
					id: 'signup',
					issuer,
					audience,
					claimsJson: JSON.stringify({ sub: 'owner' })
				}
			]
		});
	});

	it('refuses a different principal once claimed and seeds it no trust', async () => {
		const database = controlDatabase();

		await claimGlobalAdmin(
			database,
			{ issuer, subject: 'owner', audience },
			t0
		);

		let error: unknown;
		try {
			await claimGlobalAdmin(
				database,
				{ issuer, subject: 'intruder', audience },
				t1
			);
			error = { kind: 'claimed' };
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(GlobalAdminAlreadyClaimedError);
		if (!(error instanceof GlobalAdminAlreadyClaimedError)) {
			throw error;
		}

		const state = await adminAndTrust(database);

		expect({
			error: { name: error.name, status: error.status },
			state
		}).toStrictEqual({
			error: {
				name: 'GlobalAdminAlreadyClaimedError',
				status: StatusCodes.CONFLICT
			},
			state: {
				admin: { issuer, subject: 'owner', audience, claimedAt: t0 },
				trust: [
					{
						id: 'signup',
						issuer,
						audience,
						claimsJson: JSON.stringify({ sub: 'owner' })
					}
				]
			}
		});
	});

	it('refuses a changed signup audience for the same issuer and subject', async () => {
		const database = controlDatabase();
		await claimGlobalAdmin(
			database,
			{ issuer, subject: 'owner', audience },
			t0
		);

		await expect(
			claimGlobalAdmin(
				database,
				{ issuer, subject: 'owner', audience: 'another-client' },
				t1
			)
		).rejects.toBeInstanceOf(GlobalAdminAlreadyClaimedError);
	});
});

describe('isGlobalAdminPrincipal', () => {
	it('requires the exact claimed issuer, audience, and subject', async () => {
		const database = controlDatabase();
		await claimGlobalAdmin(
			database,
			{ issuer, subject: 'owner', audience },
			t0
		);

		const isExact = await isGlobalAdminPrincipal(database, {
			issuer: oidcIssuerSchema.parse(issuer),
			audience: oidcAudienceSchema.parse(audience),
			subject: oidcSubjectSchema.parse('owner')
		});
		const isSameSubjectFromAnotherIssuer = await isGlobalAdminPrincipal(
			database,
			{
				issuer: oidcIssuerSchema.parse('https://another.example.test'),
				audience: oidcAudienceSchema.parse(audience),
				subject: oidcSubjectSchema.parse('owner')
			}
		);

		expect({
			exact: isExact,
			sameSubjectFromAnotherIssuer: isSameSubjectFromAnotherIssuer
		}).toStrictEqual({
			exact: true,
			sameSubjectFromAnotherIssuer: false
		});
	});
});
