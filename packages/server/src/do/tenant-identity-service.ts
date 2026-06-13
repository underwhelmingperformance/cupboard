import { eq } from 'drizzle-orm';

import * as schema from '../db/schema.ts';

import type { ServerContext } from './context.ts';

const identityId = 'singleton';

// The identity the control plane assigns a tenant Durable Object: the slug it
// serves, the issuer and audience it pins into issued tokens, the owner OIDC triple
// its admin rule is seeded from, and the monotonic config version that fences it.
export interface TenantIdentity {
	readonly tenant: string;
	readonly issuer: string;
	readonly audience: string;
	readonly ownerIssuer: string;
	readonly ownerSubject: string;
	readonly ownerAudience: string;
	readonly configVersion: number;
}

// Owns the Durable Object's single `tenant_identity` row. A configured tenant reads
// its identity from here; the `configure` RPC writes it under the config-version
// fence.
export class TenantIdentityService {
	constructor(private readonly context: ServerContext) {}

	current(): TenantIdentity | undefined {
		const row = this.context.db
			.select()
			.from(schema.tenantIdentity)
			.where(eq(schema.tenantIdentity.id, identityId))
			.get();

		if (row === undefined) {
			return undefined;
		}

		return {
			tenant: row.tenant,
			issuer: row.issuer,
			audience: row.audience,
			ownerIssuer: row.ownerIssuer,
			ownerSubject: row.ownerSubject,
			ownerAudience: row.ownerAudience,
			configVersion: row.configVersion
		};
	}

	// Applies an identity when its config version is newer than the applied one,
	// returning whether it was applied. A version no greater is ignored, so a stale
	// or replayed dispatch never downgrades identity (the monotonic fence).
	configure(identity: TenantIdentity): boolean {
		const existing = this.current();

		if (
			existing !== undefined &&
			identity.configVersion <= existing.configVersion
		) {
			return false;
		}

		this.context.db
			.insert(schema.tenantIdentity)
			.values({ id: identityId, ...identity })
			.onConflictDoUpdate({
				target: schema.tenantIdentity.id,
				set: {
					tenant: identity.tenant,
					issuer: identity.issuer,
					audience: identity.audience,
					ownerIssuer: identity.ownerIssuer,
					ownerSubject: identity.ownerSubject,
					ownerAudience: identity.ownerAudience,
					configVersion: identity.configVersion
				}
			})
			.run();

		return true;
	}
}
