import {
	oidcTrustDisplaySchema,
	storedPermittedGrantsSchema
} from '@cupboard/protocol/grants';
import {
	claimMatchSchema,
	oidcAudienceSchema,
	oidcIssuerSchema,
	type OidcTrustAddBody,
	type OidcTrustListResponse,
	type OidcTrustRemoveResponse,
	type OidcTrustSummary,
	type TrustRuleId,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import type { OidcTrustRule } from '@cupboard/protocol/oidc-trust-match';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import {
	ControlTrustSubjectRequiredError,
	OidcIssuerTransportRequiredError,
	OidcTrustRuleNotFoundError,
	StoredControlTrustInvalidError
} from '../errors.ts';
import { parseStored } from '../http/parse.ts';
import { isAllowedIssuerTransport } from '../oidc/issuer-policy.ts';

type Database = DrizzleD1Database<typeof d1Schema>;
type ControlTrustRow = typeof d1Schema.controlTrust.$inferSelect;

export interface ControlTrustRuleSnapshot {
	readonly rule: OidcTrustRule;
	readonly row: ControlTrustRow;
}

// Reading must admit every claim value the admin contract stores: an exact
// string or a `{ pattern }` match. The subject guard below still requires an
// exact string `sub`, so a pattern `sub` fails that check.
const storedClaimsSchema = z.record(z.string(), claimMatchSchema);

function ruleFromRow(
	row: ControlTrustRow,
	canUseLoopbackHttp: boolean
): OidcTrustRule {
	const fault = (cause: Error): StoredControlTrustInvalidError =>
		new StoredControlTrustInvalidError(row.id, cause);

	const claims = parseStored(storedClaimsSchema, row.claimsJson, fault);

	if (!isAllowedIssuerTransport(row.issuer, canUseLoopbackHttp)) {
		throw fault(new Error('a control OIDC trust issuer must use HTTPS'));
	}

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

function summaryFromRow(
	row: ControlTrustRow,
	canUseLoopbackHttp: boolean
): OidcTrustSummary {
	const rule = ruleFromRow(row, canUseLoopbackHttp);

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

export async function controlTrustRules(
	database: Database,
	canUseLoopbackHttp = false
): Promise<OidcTrustRule[]> {
	const snapshots = await controlTrustRuleSnapshots(
		database,
		canUseLoopbackHttp
	);

	return snapshots.map(({ rule }) => rule);
}

export async function controlTrustRuleSnapshots(
	database: Database,
	canUseLoopbackHttp = false
): Promise<ControlTrustRuleSnapshot[]> {
	const rows = await database
		.select()
		.from(d1Schema.controlTrust)
		.where(isNull(d1Schema.controlTrust.disabledAt))
		.all();

	return rows.map((row) => ({
		rule: ruleFromRow(row, canUseLoopbackHttp),
		row
	}));
}

export async function isControlTrustSnapshotCurrent(
	database: Database,
	snapshot: ControlTrustRuleSnapshot
): Promise<boolean> {
	const { row } = snapshot;
	const displayMatches =
		row.displayJson === null
			? isNull(d1Schema.controlTrust.displayJson)
			: eq(d1Schema.controlTrust.displayJson, row.displayJson);
	const current = await database
		.select({ id: d1Schema.controlTrust.id })
		.from(d1Schema.controlTrust)
		.where(
			and(
				eq(d1Schema.controlTrust.id, row.id),
				eq(d1Schema.controlTrust.issuer, row.issuer),
				eq(d1Schema.controlTrust.audience, row.audience),
				eq(d1Schema.controlTrust.claimsJson, row.claimsJson),
				eq(d1Schema.controlTrust.permittedGrantsJson, row.permittedGrantsJson),
				displayMatches,
				eq(d1Schema.controlTrust.createdAt, row.createdAt),
				isNull(d1Schema.controlTrust.disabledAt)
			)
		)
		.get();

	return current !== undefined;
}

export async function listControlTrust(
	database: Database,
	canUseLoopbackHttp = false
): Promise<OidcTrustListResponse> {
	const rows = await database
		.select()
		.from(d1Schema.controlTrust)
		.orderBy(
			asc(d1Schema.controlTrust.createdAt),
			asc(d1Schema.controlTrust.id)
		)
		.all();

	return { rules: rows.map((row) => summaryFromRow(row, canUseLoopbackHttp)) };
}

export async function getControlTrust(
	database: Database,
	id: TrustRuleId,
	canUseLoopbackHttp = false
): Promise<OidcTrustSummary> {
	const row = await database
		.select()
		.from(d1Schema.controlTrust)
		.where(eq(d1Schema.controlTrust.id, id))
		.get();

	if (row === undefined) {
		throw new OidcTrustRuleNotFoundError(id);
	}

	return summaryFromRow(row, canUseLoopbackHttp);
}

export async function addControlTrust(
	database: Database,
	body: OidcTrustAddBody,
	now: IsoTimestamp,
	canUseLoopbackHttp = false
): Promise<OidcTrustSummary> {
	if (!isAllowedIssuerTransport(body.issuer, canUseLoopbackHttp)) {
		throw new OidcIssuerTransportRequiredError(body.issuer);
	}

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
