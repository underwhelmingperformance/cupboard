import { trustRuleIdSchema } from '@cupboard/protocol/oidc';
import { legacyNormalisedIssuer } from '@cupboard/protocol/oidc-issuer';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, exists, inArray, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import type { AccessPrincipal } from '../auth/auth.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { GlobalAdminAlreadyClaimedError } from '../errors.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

// The fixed primary key of the single global-admin row. Its first-writer-wins
// insert is the irreversible bootstrap and the claim's consumption marker.
const singletonId = 'singleton';

// The fixed id of the control trust rule the bootstrap seeds, so a re-claim by the
// same principal does not insert a duplicate.
const bootstrapTrustId = trustRuleIdSchema.parse('signup');

export interface ClaimPrincipal {
	readonly issuer: string;
	readonly subject: string;
	readonly audience: string;
}

export interface ClaimOutcome {
	readonly claimed: boolean;
}

export async function isGlobalAdminPrincipal(
	database: Database,
	principal: AccessPrincipal | undefined
): Promise<boolean> {
	if (principal === undefined) {
		return false;
	}

	const row = await database
		.select({ id: d1Schema.globalAdmin.id })
		.from(d1Schema.globalAdmin)
		.where(
			and(
				eq(d1Schema.globalAdmin.id, singletonId),
				eq(d1Schema.globalAdmin.issuer, principal.issuer),
				eq(d1Schema.globalAdmin.subject, principal.subject),
				eq(d1Schema.globalAdmin.audience, principal.audience)
			)
		)
		.get();

	return row !== undefined;
}

async function repairMissingAudience(
	database: Database,
	principal: ClaimPrincipal,
	claimsJson: string,
	legacyIssuer: string | undefined
): Promise<void> {
	const issuers =
		legacyIssuer === undefined
			? [principal.issuer]
			: [principal.issuer, legacyIssuer];
	const bootstrapRuleFilter = and(
		eq(d1Schema.controlTrust.id, bootstrapTrustId),
		eq(d1Schema.controlTrust.issuer, d1Schema.globalAdmin.issuer),
		eq(d1Schema.controlTrust.audience, principal.audience),
		eq(d1Schema.controlTrust.claimsJson, claimsJson)
	);
	const bootstrapRule = database
		.select({ one: sql`1` })
		.from(d1Schema.controlTrust)
		.where(bootstrapRuleFilter);
	const matchingBootstrapRule = exists(bootstrapRule);

	await database
		.update(d1Schema.globalAdmin)
		.set({ audience: principal.audience })
		.where(
			and(
				eq(d1Schema.globalAdmin.id, singletonId),
				eq(d1Schema.globalAdmin.subject, principal.subject),
				inArray(d1Schema.globalAdmin.issuer, issuers),
				eq(d1Schema.globalAdmin.audience, ''),
				matchingBootstrapRule
			)
		);
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
		eq(d1Schema.globalAdmin.subject, principal.subject),
		eq(d1Schema.globalAdmin.audience, principal.audience)
	);

	const bootstrapTrustSelect = database
		.select(bootstrapTrustColumns)
		.from(d1Schema.globalAdmin)
		.where(bootstrapTrustWhere);
	const legacyIssuer = legacyNormalisedIssuer(principal.issuer);

	await repairMissingAudience(database, principal, claimsJson, legacyIssuer);

	if (legacyIssuer !== undefined) {
		// A successful claim proves the exact issuer, subject and audience. Repair
		// only the value that the older trailing-slash normalisation produced. Token
		// verification never treats the two issuer values as equivalent.
		const adminRepairWhere = and(
			eq(d1Schema.globalAdmin.id, singletonId),
			eq(d1Schema.globalAdmin.issuer, legacyIssuer),
			eq(d1Schema.globalAdmin.subject, principal.subject),
			eq(d1Schema.globalAdmin.audience, principal.audience)
		);
		const trustRepairWhere = and(
			eq(d1Schema.controlTrust.id, bootstrapTrustId),
			eq(d1Schema.controlTrust.issuer, legacyIssuer),
			eq(d1Schema.controlTrust.audience, principal.audience),
			eq(d1Schema.controlTrust.claimsJson, claimsJson)
		);
		const repairAdmin = database
			.update(d1Schema.globalAdmin)
			.set({ issuer: principal.issuer })
			.where(adminRepairWhere);
		const repairTrust = database
			.update(d1Schema.controlTrust)
			.set({ issuer: principal.issuer })
			.where(trustRepairWhere);

		await database.batch([repairAdmin, repairTrust]);
	}

	await database.batch([
		database
			.insert(d1Schema.globalAdmin)
			.values({
				id: singletonId,
				issuer: principal.issuer,
				subject: principal.subject,
				audience: principal.audience,
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
		admin.subject !== principal.subject ||
		admin.audience !== principal.audience
	) {
		throw new GlobalAdminAlreadyClaimedError();
	}

	// The singleton insert leaves the original `claimed_at` untouched on a re-claim
	// (`on conflict do nothing`), so a row stamped with this call's `now` is the one
	// this call inserted.
	return { claimed: admin.claimedAt === now };
}
