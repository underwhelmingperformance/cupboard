import { type Sha256HexDigest } from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, exists, sql } from 'drizzle-orm';

import { casObjectNotRepromoted } from '../blob/cas-object-state.ts';
import { type CasReferenceSet } from '../db/cas-reference-set.ts';
import * as d1Schema from '../db/d1-schema.ts';

import { type ServerContext } from './context.ts';

/**
 * Quota release shared by every kind of logical CAS reference.
 */
export class CasQuotaService {
	constructor(private readonly context: ServerContext) {}

	releaseStatements(
		digest: Sha256HexDigest,
		references: CasReferenceSet,
		fenceIncarnation?: number
	) {
		const tenant = this.context.requireTenant();
		const now = isoTimestamp(new Date());
		const presenceFilter = and(
			eq(d1Schema.tenantCasBlob.tenant, tenant),
			eq(d1Schema.tenantCasBlob.digest, digest)
		);
		const size = this.context.d1
			.select({ size: d1Schema.tenantCasBlob.size })
			.from(d1Schema.tenantCasBlob)
			.where(presenceFilter);

		const presenceExists = exists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.tenantCasBlob)
				.where(presenceFilter)
		);
		const unreferenced = references.unreferenced(digest, tenant);
		const notRepromoted = casObjectNotRepromoted(
			this.context.d1,
			digest,
			fenceIncarnation
		);
		const releaseFilter = and(presenceFilter, notRepromoted, unreferenced);
		const creditFilter = and(
			eq(d1Schema.tenantUsage.tenant, tenant),
			presenceExists,
			notRepromoted,
			unreferenced
		);

		return {
			credit: this.context.d1
				.update(d1Schema.tenantUsage)
				.set({
					casBytes: sql`${d1Schema.tenantUsage.casBytes} - (${size})`,
					casBlobs: sql`${d1Schema.tenantUsage.casBlobs} - 1`,
					updatedAt: now
				})
				.where(creditFilter),
			presenceDelete: this.context.d1
				.delete(d1Schema.tenantCasBlob)
				.where(releaseFilter)
		};
	}
}
