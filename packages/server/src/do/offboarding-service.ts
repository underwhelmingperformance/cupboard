import { type TenantId } from '@cupboard/nix-store/scalars';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import { cacheIdentityCondition, cacheScopeFromRow } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';

import {
	batchNonEmpty,
	chunk,
	chunkByStatementParameters,
	maxInClauseValues
} from './bulk.ts';
import { type ServerContext } from './context.ts';

type BlobReferenceIdentity = Pick<
	typeof d1Schema.blobReference.$inferSelect,
	'cacheKind' | 'cacheName' | 'storePathHash' | 'generation'
>;

type AttestationReferenceIdentity = Pick<
	typeof d1Schema.attestationReference.$inferSelect,
	| 'cacheKind'
	| 'cacheName'
	| 'storePathHash'
	| 'generation'
	| 'predicateType'
	| 'digest'
>;

function blobReferenceIdentityCondition(reference: BlobReferenceIdentity) {
	const scope = cacheScopeFromRow({
		kind: reference.cacheKind,
		name: reference.cacheName
	});

	return and(
		cacheIdentityCondition(
			d1Schema.blobReference.cacheKind,
			d1Schema.blobReference.cacheName,
			scope
		),
		eq(d1Schema.blobReference.storePathHash, reference.storePathHash),
		eq(d1Schema.blobReference.generation, reference.generation)
	);
}

function attestationReferenceIdentityCondition(
	reference: AttestationReferenceIdentity
) {
	const scope = cacheScopeFromRow({
		kind: reference.cacheKind,
		name: reference.cacheName
	});

	return and(
		cacheIdentityCondition(
			d1Schema.attestationReference.cacheKind,
			d1Schema.attestationReference.cacheName,
			scope
		),
		eq(d1Schema.attestationReference.storePathHash, reference.storePathHash),
		eq(d1Schema.attestationReference.generation, reference.generation),
		eq(d1Schema.attestationReference.predicateType, reference.predicateType),
		eq(d1Schema.attestationReference.digest, reference.digest)
	);
}

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

export function buildTenantBlobReferenceDeleteStatement(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	references: readonly BlobReferenceIdentity[]
) {
	const identities = references.map((reference) =>
		blobReferenceIdentityCondition(reference)
	);

	return database
		.delete(d1Schema.blobReference)
		.where(and(eq(d1Schema.blobReference.tenant, tenant), or(...identities)));
}

export function buildTenantAttestationReferenceDeleteStatement(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	references: readonly AttestationReferenceIdentity[]
) {
	const identities = references.map((reference) =>
		attestationReferenceIdentityCondition(reference)
	);

	return database
		.delete(d1Schema.attestationReference)
		.where(
			and(eq(d1Schema.attestationReference.tenant, tenant), or(...identities))
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
				cacheKind: d1Schema.blobReference.cacheKind,
				cacheName: d1Schema.blobReference.cacheName,
				storePathHash: d1Schema.blobReference.storePathHash,
				generation: d1Schema.blobReference.generation
			})
			.from(d1Schema.blobReference)
			.where(eq(d1Schema.blobReference.tenant, tenant))
			.orderBy(
				asc(d1Schema.blobReference.cacheKind),
				asc(d1Schema.blobReference.cacheName),
				asc(d1Schema.blobReference.storePathHash),
				asc(d1Schema.blobReference.generation)
			)
			.limit(limit)
			.all();

		if (references.length === 0) {
			return;
		}

		const deletes = chunkByStatementParameters(references, (batch) =>
			buildTenantBlobReferenceDeleteStatement(this.context.d1, tenant, batch)
		).map((batch) =>
			buildTenantBlobReferenceDeleteStatement(this.context.d1, tenant, batch)
		);

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
				cacheKind: d1Schema.attestationReference.cacheKind,
				cacheName: d1Schema.attestationReference.cacheName,
				storePathHash: d1Schema.attestationReference.storePathHash,
				generation: d1Schema.attestationReference.generation,
				predicateType: d1Schema.attestationReference.predicateType,
				digest: d1Schema.attestationReference.digest
			})
			.from(d1Schema.attestationReference)
			.where(eq(d1Schema.attestationReference.tenant, tenant))
			.orderBy(
				asc(d1Schema.attestationReference.cacheKind),
				asc(d1Schema.attestationReference.cacheName),
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

		const deletes = chunkByStatementParameters(references, (batch) =>
			buildTenantAttestationReferenceDeleteStatement(
				this.context.d1,
				tenant,
				batch
			)
		).map((batch) =>
			buildTenantAttestationReferenceDeleteStatement(
				this.context.d1,
				tenant,
				batch
			)
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
