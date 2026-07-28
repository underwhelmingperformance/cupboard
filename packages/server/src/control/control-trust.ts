import {
	oidcTrustDisplaySchema,
	storedPermittedGrantsSchema
} from '@cupboard/protocol/grants';
import {
	claimMatchSchema,
	oidcAudienceSchema,
	oidcIssuerSchema,
	type OidcTrustListResponse,
	type OidcTrustRemoveResponse,
	type OidcTrustSummary,
	type ParsedOidcTrustAddBody,
	type TrustRuleId,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import type { OidcTrustRule } from '@cupboard/protocol/oidc-trust-match';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import { asc, eq, isNull } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import {
	ControlTrustSubjectRequiredError,
	OidcTrustRuleNotFoundError,
	StoredControlTrustInvalidError
} from '../errors.ts';
import { parseStored } from '../http/parse.ts';

type Database = DrizzleD1Database<typeof d1Schema>;
type ControlTrustRow = typeof d1Schema.controlTrust.$inferSelect;

// Reading must admit every claim value the admin contract stores: an exact
// string or a `{ pattern }` match. The subject guard below still requires an
// exact string `sub`, so a pattern `sub` fails that check.
const storedClaimsSchema = z.record(z.string(), claimMatchSchema);

function ruleFromRow(row: ControlTrustRow): OidcTrustRule {
	const fault = (cause: Error): StoredControlTrustInvalidError =>
		new StoredControlTrustInvalidError(row.id, cause);

	const claims = parseStored(storedClaimsSchema, row.claimsJson, fault);

	// A control rule MUST pin a subject. Without it the rule would match every
	// subject of the trusted issuer and audience (the highest-privilege grant in
	// the system), handed out on issuer membership alone.
	if (typeof claims.sub !== 'string' || claims.sub === '') {
		throw fault(new Error('a control trust rule must pin a subject'));
	}

	return {
		id: row.id,
		issuer: oidcIssuerSchema.parse(row.issuer),
		audience: oidcAudienceSchema.parse(row.audience),
		claims,
		permittedGrants: parseStored(
			storedPermittedGrantsSchema,
			row.permittedGrantsJson,
			fault
		),
		...(row.displayJson !== null && {
			display: parseStored(oidcTrustDisplaySchema, row.displayJson, fault)
		})
	};
}

function summaryFromRow(row: ControlTrustRow): OidcTrustSummary {
	const rule = ruleFromRow(row);

	return {
		id: rule.id,
		issuer: rule.issuer,
		audience: rule.audience,
		claims: { ...rule.claims },
		permittedGrants: [...rule.permittedGrants],
		...(rule.display !== undefined && { display: rule.display }),
		disabled: Boolean(row.disabledAt)
	};
}

// Every enabled control trust rule, mapped to the shape the OIDC matcher reads.
// The control plane is its own issuer, entirely separate from any tenant's.
export async function controlTrustRules(
	database: Database
): Promise<OidcTrustRule[]> {
	const rows = await database
		.select()
		.from(d1Schema.controlTrust)
		.where(isNull(d1Schema.controlTrust.disabledAt))
		.all();

	return rows.map((row) => ruleFromRow(row));
}

export async function listControlTrust(
	database: Database
): Promise<OidcTrustListResponse> {
	const rows = await database
		.select()
		.from(d1Schema.controlTrust)
		.orderBy(
			asc(d1Schema.controlTrust.createdAt),
			asc(d1Schema.controlTrust.id)
		)
		.all();

	return { rules: rows.map((row) => summaryFromRow(row)) };
}

export async function getControlTrust(
	database: Database,
	id: TrustRuleId
): Promise<OidcTrustSummary> {
	const row = await database
		.select()
		.from(d1Schema.controlTrust)
		.where(eq(d1Schema.controlTrust.id, id))
		.get();

	if (row === undefined) {
		throw new OidcTrustRuleNotFoundError(id);
	}

	return summaryFromRow(row);
}

export async function addControlTrust(
	database: Database,
	body: ParsedOidcTrustAddBody,
	now: IsoTimestamp
): Promise<OidcTrustSummary> {
	// A control rule must pin a subject: without it the rule would match every
	// subject of the trusted issuer and audience, handing out control authority on
	// issuer membership alone.
	if (body.claims.sub === undefined || body.claims.sub === '') {
		throw new ControlTrustSubjectRequiredError();
	}

	const id = trustRuleIdSchema.parse(crypto.randomUUID());

	await database
		.insert(d1Schema.controlTrust)
		.values({
			id,
			issuer: body.issuer,
			audience: body.audience,
			claimsJson: JSON.stringify(body.claims),
			permittedGrantsJson: JSON.stringify(body.permittedGrants),
			displayJson:
				body.display === undefined ? undefined : JSON.stringify(body.display),
			createdAt: now
		})
		.run();

	return {
		id,
		issuer: body.issuer,
		audience: body.audience,
		claims: body.claims,
		permittedGrants: body.permittedGrants,
		...(body.display !== undefined && { display: body.display }),
		disabled: false
	};
}

export async function removeControlTrust(
	database: Database,
	id: TrustRuleId,
	now: IsoTimestamp
): Promise<OidcTrustRemoveResponse> {
	const existing = await database
		.select()
		.from(d1Schema.controlTrust)
		.where(eq(d1Schema.controlTrust.id, id))
		.get();

	// Soft-disable so the audit row survives; `wasRemoved` reports whether this
	// call is what disabled an enabled rule.
	const wasRemoved = existing?.disabledAt === null;

	if (wasRemoved) {
		await database
			.update(d1Schema.controlTrust)
			.set({ disabledAt: now })
			.where(eq(d1Schema.controlTrust.id, id))
			.run();
	}

	return { id, removed: wasRemoved };
}
