import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { GlobalAdminAlreadyClaimedError } from '../errors.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

// The fixed primary key of the single global-admin row. Its first-writer-wins
// insert is the irreversible bootstrap and the claim's consumption marker.
const singletonId = 'singleton';

// The fixed id of the control trust rule the bootstrap seeds, so a re-claim by the
// same principal does not insert a duplicate.
const bootstrapTrustId = 'signup';

// The verified principal a signup claim promotes to global admin.
export interface ClaimPrincipal {
	readonly issuer: string;
	readonly subject: string;
	readonly audience: string;
}

export interface ClaimOutcome {
	// True when this call performed the claim, false for an idempotent re-claim by
	// the principal that already holds it.
	readonly claimed: boolean;
}

// Promotes a verified principal to global admin and seeds the control trust rule
// that lets it mint admin tokens, in one atomic D1 batch so a crash can never
// leave the deployment claimed but with no trust rule (and so un-administerable).
//
// The `global_admin` singleton is inserted first-writer-wins. The trust seed is an
// `INSERT ... SELECT` gated, within the same batch, on the singleton row already
// belonging to this principal, so a concurrent claim by a different principal
// neither wins the singleton nor seeds trust for the loser. A re-claim by the same
// principal is idempotent: the singleton insert no-ops and the trust seed is
// skipped by its primary key. A claim by a different principal once the singleton
// is taken is refused.
export async function claimGlobalAdmin(
	database: Database,
	principal: ClaimPrincipal,
	now: string
): Promise<ClaimOutcome> {
	const claimsJson = JSON.stringify({ sub: principal.subject });

	await database.batch([
		database
			.insert(d1Schema.globalAdmin)
			.values({
				id: singletonId,
				issuer: principal.issuer,
				subject: principal.subject,
				claimedAt: now
			})
			.onConflictDoNothing(),
		database
			.insert(d1Schema.controlTrust)
			.select(
				database
					.select({
						id: sql<string>`${bootstrapTrustId}`.as('id'),
						issuer: sql<string>`${principal.issuer}`.as('issuer'),
						audience: sql<string>`${principal.audience}`.as('audience'),
						claimsJson: sql<string>`${claimsJson}`.as('claims_json'),
						createdAt: sql<string>`${now}`.as('created_at')
					})
					.from(d1Schema.globalAdmin)
					.where(
						and(
							eq(d1Schema.globalAdmin.id, singletonId),
							eq(d1Schema.globalAdmin.issuer, principal.issuer),
							eq(d1Schema.globalAdmin.subject, principal.subject)
						)
					)
			)
			.onConflictDoNothing()
	]);

	const admin = await database
		.select()
		.from(d1Schema.globalAdmin)
		.where(eq(d1Schema.globalAdmin.id, singletonId))
		.get();

	if (admin === undefined) {
		throw new GlobalAdminAlreadyClaimedError();
	}

	if (
		admin.issuer !== principal.issuer ||
		admin.subject !== principal.subject
	) {
		throw new GlobalAdminAlreadyClaimedError();
	}

	// The singleton insert leaves the original `claimed_at` untouched on a re-claim
	// (`on conflict do nothing`), so a row stamped with this call's `now` is the one
	// this call inserted.
	return { claimed: admin.claimedAt === now };
}
