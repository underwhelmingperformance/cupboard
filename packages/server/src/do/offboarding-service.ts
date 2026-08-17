import { type TenantId } from '@cupboard/nix-store/scalars';
import { and, asc, eq, inArray, or, type SQL } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import { createR2BlobStore } from '../s3/blob-store.ts';
import { s3TenantStagingPrefix } from '../s3/staging.ts';
import { S3StagingAccounting } from '../s3/staging-accounting.ts';

import {
	batchNonEmpty,
	chunk,
	deleteObjects,
	maxInClauseValues
} from './bulk.ts';
import { type ServerContext } from './context.ts';

// D1 caps a query at 100 bound parameters. A composite-key delete binds the
// tenant plus the key columns of each row in the batch, so each batch is split
// to stay under the cap: three key columns for a blob reference edge, five for
// an attestation reference edge.
export const blobReferenceDeleteChunk = 30;
export const attestationReferenceDeleteChunk = 18;

export type BlobReferenceKey = Pick<
	typeof d1Schema.blobReference.$inferSelect,
	'cache' | 'storePathHash' | 'generation'
>;

export type AttestationReferenceKey = Pick<
	typeof d1Schema.attestationReference.$inferSelect,
	'cache' | 'storePathHash' | 'generation' | 'predicateType' | 'digest'
>;

export function blobReferenceMatch(row: BlobReferenceKey): SQL | undefined {
	return and(
		eq(d1Schema.blobReference.cache, row.cache),
		eq(d1Schema.blobReference.storePathHash, row.storePathHash),
		eq(d1Schema.blobReference.generation, row.generation)
	);
}

export function attestationReferenceMatch(
	row: AttestationReferenceKey
): SQL | undefined {
	return and(
		eq(d1Schema.attestationReference.cache, row.cache),
		eq(d1Schema.attestationReference.storePathHash, row.storePathHash),
		eq(d1Schema.attestationReference.generation, row.generation),
		eq(d1Schema.attestationReference.predicateType, row.predicateType),
		eq(d1Schema.attestationReference.digest, row.digest)
	);
}

/**
 * Builds the DELETE removing one chunk of presence rows by narHash.
 * Exported for the D1 parameter guard test.
 */
export function buildTenantBlobDeleteStatement(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	narHashes: readonly (typeof d1Schema.tenantBlob.$inferSelect.narHash)[]
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

/**
 * Builds the DELETE removing one chunk of CAS presence rows by digest.
 * Exported for the D1 parameter guard test.
 */
export function buildTenantCasBlobDeleteStatement(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	digests: readonly (typeof d1Schema.tenantCasBlob.$inferSelect.digest)[]
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

// Drains a tenant being offboarded. The Durable Object is the single writer of its
// tenant's `blob_ref`/`tenant_blob` rows, so the Worker removes them only through
// this RPC: deleting an edge here lets the global reaper collect the now-unreferenced
// shared blob, and the per-tenant single-writer rule is never broken by a Worker that
// deletes edge rows directly. Each pass is bounded so a tenant with a large store
// drains over successive cron ticks.
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

		const deletes = chunk(references, blobReferenceDeleteChunk).map((batch) => {
			const inBatch = or(...batch.map((row) => blobReferenceMatch(row)));
			const keyFilter = and(eq(d1Schema.blobReference.tenant, tenant), inBatch);

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
		const chunks = chunk(narHashes, maxInClauseValues);
		const deletes = chunks.map((hashes) =>
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

		const deletes = chunk(references, attestationReferenceDeleteChunk).map(
			(batch) => {
				const inBatch = or(
					...batch.map((row) => attestationReferenceMatch(row))
				);
				const keyFilter = and(
					eq(d1Schema.attestationReference.tenant, tenant),
					inBatch
				);

				return this.context.d1
					.delete(d1Schema.attestationReference)
					.where(keyFilter);
			}
		);

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
		const chunks = chunk(digests, maxInClauseValues);
		const deletes = chunks.map((digestChunk) =>
			buildTenantCasBlobDeleteStatement(this.context.d1, tenant, digestChunk)
		);

		await batchNonEmpty(this.context.d1, deletes);
	}

	private async hasResidue(tenant: TenantId): Promise<boolean> {
		// The terminal (fully-drained) pass checks every table anyway, so read
		// them in one batch.
		const [
			edge,
			presence,
			attestation,
			casPresence,
			staged,
			multipart,
			multipartPart
		] = await this.context.d1.batch([
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
				.limit(1),
			this.context.d1
				.select({ tenant: d1Schema.s3StagedObject.tenant })
				.from(d1Schema.s3StagedObject)
				.where(eq(d1Schema.s3StagedObject.tenant, tenant))
				.limit(1),
			this.context.d1
				.select({ tenant: d1Schema.s3MultipartUpload.tenant })
				.from(d1Schema.s3MultipartUpload)
				.where(eq(d1Schema.s3MultipartUpload.tenant, tenant))
				.limit(1),
			this.context.d1
				.select({ tenant: d1Schema.s3MultipartPart.tenant })
				.from(d1Schema.s3MultipartPart)
				.where(eq(d1Schema.s3MultipartPart.tenant, tenant))
				.limit(1)
		]);
		const stagingObjects = await this.context.env.BLOBS.list({
			prefix: s3TenantStagingPrefix(tenant),
			limit: 1
		});

		return (
			edge.length > 0 ||
			presence.length > 0 ||
			attestation.length > 0 ||
			casPresence.length > 0 ||
			staged.length > 0 ||
			multipart.length > 0 ||
			multipartPart.length > 0 ||
			stagingObjects.objects.length > 0
		);
	}

	private async drainS3Staging(tenant: TenantId, limit: number): Promise<void> {
		const accounting = new S3StagingAccounting(
			this.context.d1,
			tenant,
			() => new Date(),
			() => crypto.randomUUID()
		);
		await accounting.cleanupForOffboarding(
			createR2BlobStore(this.context.rawBlobs),
			limit
		);

		const listed = await this.context.env.BLOBS.list({
			prefix: s3TenantStagingPrefix(tenant),
			limit
		});
		await deleteObjects(
			this.context.env.BLOBS,
			listed.objects.map((object) => r2ObjectKeySchema.parse(object.key))
		);
	}

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
		await this.drainS3Staging(tenant, limit);

		return { drained: !(await this.hasResidue(tenant)) };
	}
}
