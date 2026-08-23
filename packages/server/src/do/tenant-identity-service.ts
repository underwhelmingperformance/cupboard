import { type TenantId } from '@cupboard/nix-store/scalars';
import {
	type OidcAudience,
	oidcAudienceSchema,
	type OidcIssuer,
	oidcIssuerSchema,
	type OidcSubject,
	oidcSubjectSchema
} from '@cupboard/protocol/oidc';
import { eq } from 'drizzle-orm';

import * as schema from '../db/schema.ts';

import type { ServerContext } from './context.ts';

const identityId = 'singleton';

export interface TenantIdentity {
	readonly tenant: TenantId;
	readonly issuer: OidcIssuer;
	readonly audience: OidcAudience;
	readonly ownerIssuer: OidcIssuer;
	readonly ownerSubject: OidcSubject;
	readonly ownerAudience: OidcAudience;
	readonly configVersion: number;
}

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
			issuer: oidcIssuerSchema.parse(row.issuer),
			audience: oidcAudienceSchema.parse(row.audience),
			ownerIssuer: oidcIssuerSchema.parse(row.ownerIssuer),
			ownerSubject: oidcSubjectSchema.parse(row.ownerSubject),
			ownerAudience: oidcAudienceSchema.parse(row.ownerAudience),
			configVersion: row.configVersion
		};
	}

	// An equal or older `configVersion` changes nothing, so a replay cannot restore
	// stale identity fields or owner access. A true result tells the caller to
	// reseed the reserved owner rule from the new identity.
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
