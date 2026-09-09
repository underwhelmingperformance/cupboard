import { type TenantId } from '@cupboard/nix-store/scalars';
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';

import { batchNonEmpty } from './bulk.ts';
import { type ServerContext } from './context.ts';
import {
	type JsonRowList,
	jsonRowLists,
	type JsonValueList,
	jsonValueLists
} from './json-list.ts';

export type BlobReferenceKey = Pick<
	typeof d1Schema.blobReference.$inferSelect,
	'cache' | 'storePathHash' | 'generation'
>;

export type AttestationReferenceKey = Pick<
	typeof d1Schema.attestationReference.$inferSelect,
	'cache' | 'storePathHash' | 'generation' | 'predicateType' | 'digest'
>;

export function blobReferenceMatch(rows: JsonRowList<BlobReferenceKey>): SQL {
	return rows.matches({
		cache: d1Schema.blobReference.cache,
		storePathHash: d1Schema.blobReference.storePathHash,
		generation: d1Schema.blobReference.generation
	});
}

export function attestationReferenceMatch(
	rows: JsonRowList<AttestationReferenceKey>
): SQL {
	return rows.matches({
		cache: d1Schema.attestationReference.cache,
		storePathHash: d1Schema.attestationReference.storePathHash,
		generation: d1Schema.attestationReference.generation,
		predicateType: d1Schema.attestationReference.predicateType,
		digest: d1Schema.attestationReference.digest
	});
}

export function buildTenantBlobDeleteStatement(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	narHashes: JsonValueList<typeof d1Schema.tenantBlob.$inferSelect.narHash>
) {
	return database
		.delete(d1Schema.tenantBlob)
		.where(
			and(
				eq(d1Schema.tenantBlob.tenant, tenant),
				inArray(d1Schema.tenantBlob.narHash, narHashes)
			)
		);
}

export function buildTenantCasBlobDeleteStatement(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	digests: JsonValueList<typeof d1Schema.tenantCasBlob.$inferSelect.digest>
) {
	return database
		.delete(d1Schema.tenantCasBlob)
		.where(
			and(
				eq(d1Schema.tenantCasBlob.tenant, tenant),
				inArray(d1Schema.tenantCasBlob.digest, digests)
			)
		);
}

// The Durable Object remains the only writer of its tenant's reference and
// presence rows during offboarding. Each bounded pass removes rows through this
// service, allowing the global reaper to collect unreferenced shared objects.
export class OffboardingService {
	constructor(private readonly context: ServerContext) {}

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

		const deletes = jsonRowLists(references).map((rows) => {
			const keyFilter = and(
				eq(d1Schema.blobReference.tenant, tenant),
				blobReferenceMatch(rows)
			);

			return this.context.d1.delete(d1Schema.blobReference).where(keyFilter);
		});

		await batchNonEmpty(this.context.d1, deletes);
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

		const narHashes = blobs.map((blob) => blob.narHash);
		const deletes = jsonValueLists(narHashes).map((hashes) =>
			buildTenantBlobDeleteStatement(this.context.d1, tenant, hashes)
		);

		await batchNonEmpty(this.context.d1, deletes);
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

		const deletes = jsonRowLists(references).map((rows) => {
			const keyFilter = and(
				eq(d1Schema.attestationReference.tenant, tenant),
				attestationReferenceMatch(rows)
			);

			return this.context.d1
				.delete(d1Schema.attestationReference)
				.where(keyFilter);
		});

		await batchNonEmpty(this.context.d1, deletes);
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

		const digests = blobs.map((blob) => blob.digest);
		const deletes = jsonValueLists(digests).map((list) =>
			buildTenantCasBlobDeleteStatement(this.context.d1, tenant, list)
		);

		await batchNonEmpty(this.context.d1, deletes);
	}

	private async hasResidue(tenant: TenantId): Promise<boolean> {
		// The terminal (fully-drained) pass checks all four tables anyway, so read
		// them in one batch.
		const [edge, presence, attestation, casPresence] =
			await this.context.d1.batch([
				this.context.d1
					.select({ tenant: d1Schema.blobReference.tenant })
					.from(d1Schema.blobReference)
					.where(eq(d1Schema.blobReference.tenant, tenant))
					.limit(1),
				this.context.d1
					.select({ tenant: d1Schema.tenantBlob.tenant })
					.from(d1Schema.tenantBlob)
					.where(eq(d1Schema.tenantBlob.tenant, tenant))
					.limit(1),
				this.context.d1
					.select({ tenant: d1Schema.attestationReference.tenant })
					.from(d1Schema.attestationReference)
					.where(eq(d1Schema.attestationReference.tenant, tenant))
					.limit(1),
				this.context.d1
					.select({ tenant: d1Schema.tenantCasBlob.tenant })
					.from(d1Schema.tenantCasBlob)
					.where(eq(d1Schema.tenantCasBlob.tenant, tenant))
					.limit(1)
			]);

		return (
			edge.length > 0 ||
			presence.length > 0 ||
			attestation.length > 0 ||
			casPresence.length > 0
		);
	}

	// Prevent verification recovery from restoring objects while offboarding.
	begin(): void {
		this.context.offboarding = true;
	}

	// A missing identity means an earlier finalisation already purged local state.
	// Report it as drained so the Worker can repeat the remaining D1 finalisation.
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
}
