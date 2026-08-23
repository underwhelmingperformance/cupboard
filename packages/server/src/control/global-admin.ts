import type { IsoTimestamp } from '@cupboard/protocol/scalars';
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

export interface ClaimPrincipal {
	readonly issuer: string;
	readonly subject: string;
	readonly audience: string;
}

export interface ClaimOutcome {
	readonly claimed: boolean;
}

// Claim the administrator and seed its control trust rule in one D1 batch. A
// crash cannot leave the deployment claimed without a principal that can issue
// an administrative token.
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
	now: IsoTimestamp
): Promise<ClaimOutcome> {
	const claimsJson = JSON.stringify({ sub: principal.subject });

	const bootstrapTrustColumns = {
		id: sql<string>`${bootstrapTrustId}`.as('id'),
		issuer: sql<string>`${principal.issuer}`.as('issuer'),
		audience: sql<string>`${principal.audience}`.as('audience'),
		claimsJson: sql<string>`${claimsJson}`.as('claims_json'),
		permittedGrantsJson: sql<string>`'[{"type":"cupboard_wildcard"}]'`.as(
			'permitted_grants_json'
		),
		displayJson: sql<string | null>`null`.as('display_json'),
		createdAt: sql<IsoTimestamp>`${now}`.as('created_at'),
		disabledAt: sql<IsoTimestamp | null>`null`.as('disabled_at')
	};

	const bootstrapTrustWhere = and(
		eq(d1Schema.globalAdmin.id, singletonId),
		eq(d1Schema.globalAdmin.issuer, principal.issuer),
		eq(d1Schema.globalAdmin.subject, principal.subject)
	);

	const bootstrapTrustSelect = database
		.select(bootstrapTrustColumns)
		.from(d1Schema.globalAdmin)
		.where(bootstrapTrustWhere);

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
			.select(bootstrapTrustSelect)
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
