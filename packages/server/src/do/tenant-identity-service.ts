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

import type { SchemaWriter, ServerContext } from './context.ts';

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

	current(
		database: SchemaWriter = this.context.db
	): TenantIdentity | undefined {
		const row = database
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

	// Apply only a newer configuration version. An equal or older dispatch cannot
	// restore stale identity fields or owner access. The result tells the caller
	// whether to reseed the reserved owner rule.
	configure(
		identity: TenantIdentity,
		database: SchemaWriter = this.context.db
	): boolean {
		const existing = this.current(database);

		if (
			existing !== undefined &&
			identity.configVersion <= existing.configVersion
		) {
			return false;
		}

		database
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
