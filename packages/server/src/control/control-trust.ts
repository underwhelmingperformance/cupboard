import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import { StoredControlTrustInvalidError } from '../errors.ts';
import { parseStored } from '../http/parse.ts';
import type { OidcTrustRule } from '../oidc/oidc-trust.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

const storedClaimsSchema = z.record(z.string(), z.string());

// Every control trust rule, mapped to the shape the OIDC matcher reads. The
// control plane has a single scope (admin) and no retention roots; the pinned
// `sub` lives in the claims map and is matched exactly like any other claim, so
// the tenant matcher serves the control plane unchanged.
//
// A control rule MUST pin a subject. Without it an admin-scoped rule would match
// every subject of the trusted issuer and audience — the highest-privilege grant
// in the system, handed out on issuer membership alone. A rule that does not pin a
// non-empty `sub` is rejected (fail closed), so no unpinned rule can ever issue an
// admin token, whatever wrote it.
export async function controlTrustRules(
	database: Database
): Promise<OidcTrustRule[]> {
	const rows = await database.select().from(d1Schema.controlTrust).all();

	return rows.map((row) => {
		const claims = parseStored(
			storedClaimsSchema,
			row.claimsJson,
			(cause) => new StoredControlTrustInvalidError(row.id, cause)
		);

		if (typeof claims.sub !== 'string' || claims.sub === '') {
			throw new StoredControlTrustInvalidError(
				row.id,
				new Error('a control trust rule must pin a subject')
			);
		}

		return {
			id: row.id,
			issuer: row.issuer,
			audience: row.audience,
			scope: 'admin',
			claims,
			allowedRoots: []
		};
	});
}
