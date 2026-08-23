import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { GlobalAdminAlreadyClaimedError } from '../errors.ts';

import { claimGlobalAdmin } from './global-admin.ts';

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
	admin: undefined | { issuer: string; subject: string; claimedAt: string };
	trust: { id: string; issuer: string; audience: string; claimsJson: string }[];
}> {
	const admin = await database
		.select({
			issuer: d1Schema.globalAdmin.issuer,
			subject: d1Schema.globalAdmin.subject,
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
			admin: { issuer, subject: 'owner', claimedAt: t0 },
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
			admin: { issuer, subject: 'owner', claimedAt: t0 },
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
				admin: { issuer, subject: 'owner', claimedAt: t0 },
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
});
