import {
	type Sha256HexDigest,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, exists, notExists, type SQL, sql } from 'drizzle-orm';

import { casObjectNotRepromoted } from '../blob/cas-object-state.ts';
import { type CasReferenceSet } from '../db/cas-reference-set.ts';
import * as d1Schema from '../db/d1-schema.ts';

import { type ServerContext } from './context.ts';

/**
 * Tenant quota reservation and release across every kind of logical CAS reference.
 */
export class CasQuotaService {
	constructor(private readonly context: ServerContext) {}

	private presenceFilter(tenant: TenantId, digest: Sha256HexDigest) {
		return and(
			eq(d1Schema.tenantCasBlob.tenant, tenant),
			eq(d1Schema.tenantCasBlob.digest, digest)
		);
	}

	/**
	 * Builds the quota and presence statements for a reference transaction.
	 * Run these statements with the reference insert in one D1 batch. Charge
	 * before inserting presence because charging tests whether the tenant already
	 * has presence for the digest. Reference, quota and presence writes must not
	 * change the publication fence.
	 */
	chargeStatements(
		digest: Sha256HexDigest,
		size: number,
		publicationFence?: SQL
	) {
		const tenant = this.context.requireTenant();
		const now = isoTimestamp(new Date());

		const presenceMissing = notExists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.tenantCasBlob)
				.where(this.presenceFilter(tenant, digest))
		);
		const usagePresent = exists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.tenantUsage)
				.where(eq(d1Schema.tenantUsage.tenant, tenant))
		);
		const chargeableTenantFilter = and(
			eq(d1Schema.tenant.id, tenant),
			eq(d1Schema.tenant.status, 'active'),
			usagePresent,
			publicationFence
		);
		const tenantChargeable = exists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.tenant)
				.where(chargeableTenantFilter)
		);
		const chargeFilter = and(
			eq(d1Schema.tenantUsage.tenant, tenant),
			presenceMissing,
			tenantChargeable
		);

		const graceClearFilter = and(
			eq(d1Schema.casObject.digest, digest),
			tenantChargeable
		);

		return {
			tenantCondition: chargeableTenantFilter,
			tenantGate: this.context.d1
				.select({
					status: d1Schema.tenant.status,
					usageTenant: d1Schema.tenantUsage.tenant
				})
				.from(d1Schema.tenant)
				.leftJoin(
					d1Schema.tenantUsage,
					eq(d1Schema.tenantUsage.tenant, d1Schema.tenant.id)
				)
				.where(eq(d1Schema.tenant.id, tenant)),
			charge: this.context.d1
				.update(d1Schema.tenantUsage)
				.set({
					casBytes: sql`${d1Schema.tenantUsage.casBytes} + ${size}`,
					casBlobs: sql`${d1Schema.tenantUsage.casBlobs} + 1`,
					updatedAt: now
				})
				.where(chargeFilter),
			presenceInsert: this.context.d1
				.insert(d1Schema.tenantCasBlob)
				.select((qb) =>
					qb
						.select({
							tenant: sql<TenantId>`${tenant}`.as('tenant'),
							digest: sql<Sha256HexDigest>`${digest}`.as('digest'),
							size: sql<number>`${size}`.as('size')
						})
						.from(d1Schema.tenant)
						.where(and(chargeableTenantFilter, presenceMissing))
				),
			graceClear: this.context.d1
				.update(d1Schema.casObject)
				.set({ deleteAfter: sql`null` })
				.where(graceClearFilter)
		};
	}

	releaseStatements(
		digest: Sha256HexDigest,
		references: CasReferenceSet,
		fenceIncarnation?: number
	) {
		const tenant = this.context.requireTenant();
		const now = isoTimestamp(new Date());
		const presenceFilter = this.presenceFilter(tenant, digest);
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
