import { type TenantId } from '@cupboard/nix/scalars';
import { and, asc, eq, inArray } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';

import { type ServerContext } from './context.ts';

// Drains a tenant being offboarded. The Durable Object is the single writer of its
// tenant's `blob_ref`/`tenant_blob` rows, so the Worker removes them only through
// this RPC: deleting an edge here lets the global reaper collect the now-unreferenced
// shared blob, and the per-tenant single-writer rule is never broken by a Worker that
// deletes edge rows directly. Each pass is bounded so a tenant with a large store
// drains over successive cron ticks.
export class OffboardingService {
	constructor(private readonly context: ServerContext) {}

	// Marks this tenant offboarding so the verify-restore path stops re-materialising
	// its objects. Called when offboarding begins and again on every drain pass.
	begin(): void {
		this.context.offboarding = true;
	}

	// Deletes a bounded batch of this tenant's reference edges and presence rows,
	// reporting whether any remain so the Worker can drive the drain to completion. A
	// Durable Object whose identity is already gone has been purged by an interrupted
	// finalisation; it is reported drained so the Worker re-runs finalisation and the
	// stuck tenant converges.
	async drain(limit: number): Promise<{ drained: boolean }> {
		this.begin();

		const tenant = this.tenantSlug();

		if (tenant === undefined) {
			return { drained: true };
		}

		await this.deleteReferenceBatch(tenant, limit);
		await this.deleteAttestationReferenceBatch(tenant, limit);
		await this.deletePresenceBatch(tenant, limit);
		await this.deleteCasPresenceBatch(tenant, limit);

		return { drained: !(await this.hasResidue(tenant)) };
	}

	private tenantSlug(): TenantId | undefined {
		const row = this.context.db
			.select({ tenant: schema.tenantIdentity.tenant })
			.from(schema.tenantIdentity)
			.get();

		return row?.tenant;
	}

	private async deleteReferenceBatch(
		tenant: TenantId,
		limit: number
	): Promise<void> {
		const references = await this.context.d1
			.select({
				cache: d1Schema.blobReference.cache,
				storePathHash: d1Schema.blobReference.storePathHash,
				generation: d1Schema.blobReference.generation
			})
			.from(d1Schema.blobReference)
			.where(eq(d1Schema.blobReference.tenant, tenant))
			.orderBy(
				asc(d1Schema.blobReference.cache),
				asc(d1Schema.blobReference.storePathHash),
				asc(d1Schema.blobReference.generation)
			)
			.limit(limit)
			.all();

		if (references.length === 0) {
			return;
		}

		for (const reference of references) {
			await this.context.d1
				.delete(d1Schema.blobReference)
				.where(
					and(
						eq(d1Schema.blobReference.tenant, tenant),
						eq(d1Schema.blobReference.cache, reference.cache),
						eq(d1Schema.blobReference.storePathHash, reference.storePathHash),
						eq(d1Schema.blobReference.generation, reference.generation)
					)
				)
				.run();
		}
	}

	private async deletePresenceBatch(
		tenant: TenantId,
		limit: number
	): Promise<void> {
		const blobs = await this.context.d1
			.select({ narHash: d1Schema.tenantBlob.narHash })
			.from(d1Schema.tenantBlob)
			.where(eq(d1Schema.tenantBlob.tenant, tenant))
			.limit(limit)
			.all();

		if (blobs.length === 0) {
			return;
		}

		await this.context.d1
			.delete(d1Schema.tenantBlob)
			.where(
				and(
					eq(d1Schema.tenantBlob.tenant, tenant),
					inArray(
						d1Schema.tenantBlob.narHash,
						blobs.map((blob) => blob.narHash)
					)
				)
			)
			.run();
	}

	private async deleteAttestationReferenceBatch(
		tenant: TenantId,
		limit: number
	): Promise<void> {
		const references = await this.context.d1
			.select({
				cache: d1Schema.attestationReference.cache,
				storePathHash: d1Schema.attestationReference.storePathHash,
				generation: d1Schema.attestationReference.generation,
				predicateType: d1Schema.attestationReference.predicateType,
				digest: d1Schema.attestationReference.digest
			})
			.from(d1Schema.attestationReference)
			.where(eq(d1Schema.attestationReference.tenant, tenant))
			.orderBy(
				asc(d1Schema.attestationReference.cache),
				asc(d1Schema.attestationReference.storePathHash),
				asc(d1Schema.attestationReference.generation),
				asc(d1Schema.attestationReference.predicateType),
				asc(d1Schema.attestationReference.digest)
			)
			.limit(limit)
			.all();

		if (references.length === 0) {
			return;
		}

		for (const reference of references) {
			await this.context.d1
				.delete(d1Schema.attestationReference)
				.where(
					and(
						eq(d1Schema.attestationReference.tenant, tenant),
						eq(d1Schema.attestationReference.cache, reference.cache),
						eq(
							d1Schema.attestationReference.storePathHash,
							reference.storePathHash
						),
						eq(d1Schema.attestationReference.generation, reference.generation),
						eq(
							d1Schema.attestationReference.predicateType,
							reference.predicateType
						),
						eq(d1Schema.attestationReference.digest, reference.digest)
					)
				)
				.run();
		}
	}

	private async deleteCasPresenceBatch(
		tenant: TenantId,
		limit: number
	): Promise<void> {
		const blobs = await this.context.d1
			.select({ digest: d1Schema.tenantCasBlob.digest })
			.from(d1Schema.tenantCasBlob)
			.where(eq(d1Schema.tenantCasBlob.tenant, tenant))
			.limit(limit)
			.all();

		if (blobs.length === 0) {
			return;
		}

		await this.context.d1
			.delete(d1Schema.tenantCasBlob)
			.where(
				and(
					eq(d1Schema.tenantCasBlob.tenant, tenant),
					inArray(
						d1Schema.tenantCasBlob.digest,
						blobs.map((blob) => blob.digest)
					)
				)
			)
			.run();
	}

	private async hasResidue(tenant: TenantId): Promise<boolean> {
		const edge = await this.context.d1
			.select({ tenant: d1Schema.blobReference.tenant })
			.from(d1Schema.blobReference)
			.where(eq(d1Schema.blobReference.tenant, tenant))
			.limit(1)
			.get();

		if (edge !== undefined) {
			return true;
		}

		const presence = await this.context.d1
			.select({ tenant: d1Schema.tenantBlob.tenant })
			.from(d1Schema.tenantBlob)
			.where(eq(d1Schema.tenantBlob.tenant, tenant))
			.limit(1)
			.get();

		if (presence !== undefined) {
			return true;
		}

		const attestation = await this.context.d1
			.select({ tenant: d1Schema.attestationReference.tenant })
			.from(d1Schema.attestationReference)
			.where(eq(d1Schema.attestationReference.tenant, tenant))
			.limit(1)
			.get();

		if (attestation !== undefined) {
			return true;
		}

		const casPresence = await this.context.d1
			.select({ tenant: d1Schema.tenantCasBlob.tenant })
			.from(d1Schema.tenantCasBlob)
			.where(eq(d1Schema.tenantCasBlob.tenant, tenant))
			.limit(1)
			.get();

		return casPresence !== undefined;
	}
}
