import {
	type NarInfoGeneration,
	type PredicateType,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	type StoredCache,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, exists, ne, notExists, sql } from 'drizzle-orm';

import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	AttestationBundleTooLargeError,
	UploadedObjectNotFoundError
} from '../errors.ts';
import {
	casObjectKey,
	maxAttestationBundleBytes,
	type R2ObjectKey
} from '../http/http.ts';

import { type ServerContext } from './context.ts';

export interface MeasuredAttestationBundle {
	readonly digest: Sha256HexDigest;
	readonly size: number;
	readonly bytes: Uint8Array;
}

export interface AttestationReference {
	readonly cache: StoredCache;
	readonly storePathHash: StorePathHash;
	readonly generation: NarInfoGeneration;
	readonly predicateType: PredicateType;
	readonly digest: Sha256HexDigest;
}

export type AttestationReferenceOutcome =
	'referenced' | 'already-present' | 'over-quota';

export class AttestationCasService {
	constructor(private readonly context: ServerContext) {}

	private async ensureCasObject(
		bundle: MeasuredAttestationBundle
	): Promise<void> {
		const key = casObjectKey(bundle.digest);
		const existing = await this.context.env.BLOBS.head(key);

		if (existing !== null) {
			return;
		}

		const written = await this.context.env.BLOBS.put(key, bundle.bytes, {
			sha256: bundle.digest,
			onlyIf: { etagDoesNotMatch: '*' }
		});

		if (written !== null) {
			return;
		}

		const winner = await this.context.env.BLOBS.head(key);

		if (winner === null) {
			throw new UploadedObjectNotFoundError(key);
		}
	}

	private async overQuota(
		tenant: TenantId,
		digest: Sha256HexDigest,
		size: number
	): Promise<boolean> {
		// Read the usage counters and this digest's presence together; the presence
		// read has no side effect, so it is safe to take eagerly even when the
		// usage row settles the answer first.
		const usageFilter = eq(d1Schema.tenantUsage.tenant, tenant);
		const [usageRows, ownedRows] = await this.context.d1.batch([
			this.context.d1
				.select({
					bytes: d1Schema.tenantUsage.bytes,
					casBytes: d1Schema.tenantUsage.casBytes,
					quotaBytes: d1Schema.tenantUsage.quotaBytes
				})
				.from(d1Schema.tenantUsage)
				.where(usageFilter),
			this.context.d1
				.select({ digest: d1Schema.tenantCasBlob.digest })
				.from(d1Schema.tenantCasBlob)
				.where(this.presenceFilter(tenant, digest))
		]);

		return this.overQuotaForCharge(usageRows[0], ownedRows.length > 0, size);
	}

	private edgeFilter(tenant: TenantId, reference: AttestationReference) {
		return and(
			eq(d1Schema.attestationReference.tenant, tenant),
			eq(d1Schema.attestationReference.cache, reference.cache),
			eq(d1Schema.attestationReference.storePathHash, reference.storePathHash),
			eq(d1Schema.attestationReference.generation, reference.generation),
			eq(d1Schema.attestationReference.predicateType, reference.predicateType),
			eq(d1Schema.attestationReference.digest, reference.digest)
		);
	}

	private async hasReference(
		tenant: TenantId,
		reference: AttestationReference
	): Promise<boolean> {
		const existing = await this.context.d1
			.select({ digest: d1Schema.attestationReference.digest })
			.from(d1Schema.attestationReference)
			.where(this.edgeFilter(tenant, reference))
			.get();

		return existing !== undefined;
	}

	private presenceFilter(tenant: TenantId, digest: Sha256HexDigest) {
		return and(
			eq(d1Schema.tenantCasBlob.tenant, tenant),
			eq(d1Schema.tenantCasBlob.digest, digest)
		);
	}

	async measureStagedBundle(
		stagingKey: R2ObjectKey
	): Promise<MeasuredAttestationBundle> {
		const metadata = await this.context.env.BLOBS.head(stagingKey);

		if (metadata === null) {
			throw new UploadedObjectNotFoundError(stagingKey);
		}

		if (metadata.size > maxAttestationBundleBytes) {
			throw new AttestationBundleTooLargeError(
				metadata.size,
				maxAttestationBundleBytes
			);
		}

		const object = await this.context.env.BLOBS.get(stagingKey);

		if (object === null) {
			throw new UploadedObjectNotFoundError(stagingKey);
		}

		const bytes = new Uint8Array(await object.arrayBuffer());

		if (bytes.byteLength > maxAttestationBundleBytes) {
			throw new AttestationBundleTooLargeError(
				bytes.byteLength,
				maxAttestationBundleBytes
			);
		}

		return {
			digest: sha256HexDigestSchema.parse(await sha256HexBytes(bytes)),
			size: bytes.byteLength,
			bytes
		};
	}

	async promoteMeasuredBundle(
		_stagingKey: R2ObjectKey,
		bundle: MeasuredAttestationBundle
	): Promise<void> {
		await this.ensureCasObject(bundle);

		const now = isoTimestamp(new Date());
		await this.context.d1
			.insert(d1Schema.casObject)
			.values({
				digest: bundle.digest,
				size: bundle.size,
				storedAt: now
			})
			.onConflictDoUpdate({
				target: d1Schema.casObject.digest,
				set: { deleteAfter: sql`null`, storedAt: now }
			})
			.run();
	}

	async reserveReferenceAndCharge(
		reference: AttestationReference,
		size: number
	): Promise<AttestationReferenceOutcome> {
		const tenant = this.context.requireTenant();

		if (await this.hasReference(tenant, reference)) {
			return 'already-present';
		}

		if (await this.overQuota(tenant, reference.digest, size)) {
			return 'over-quota';
		}

		const now = isoTimestamp(new Date());
		const presenceMissing = notExists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.tenantCasBlob)
				.where(this.presenceFilter(tenant, reference.digest))
		);
		const chargeFilter = and(
			eq(d1Schema.tenantUsage.tenant, tenant),
			presenceMissing
		);

		await this.context.d1.batch([
			this.context.d1
				.update(d1Schema.tenantUsage)
				.set({
					casBytes: sql`${d1Schema.tenantUsage.casBytes} + ${size}`,
					casBlobs: sql`${d1Schema.tenantUsage.casBlobs} + 1`,
					updatedAt: now
				})
				.where(chargeFilter),
			this.context.d1
				.insert(d1Schema.attestationReference)
				.values({ tenant, ...reference })
				.onConflictDoNothing(),
			this.context.d1
				.insert(d1Schema.tenantCasBlob)
				.values({ tenant, digest: reference.digest, size })
				.onConflictDoNothing(),
			this.context.d1
				.update(d1Schema.casObject)
				.set({ deleteAfter: sql`null` })
				.where(eq(d1Schema.casObject.digest, reference.digest))
		]);

		return 'referenced';
	}

	// The pure quota decision for charging `size` new bytes: a caller that has read
	// the tenant's usage counters and this digest's presence (a present digest is
	// already charged, so it never re-charges) evaluates it without a further read.
	overQuotaForCharge(
		usage:
			| {
					readonly bytes: number;
					readonly casBytes: number;
					readonly quotaBytes: number | null;
			  }
			| undefined,
		isOwned: boolean,
		size: number
	): boolean {
		if (usage === undefined) {
			return false;
		}

		if (usage.quotaBytes === null) {
			return false;
		}

		if (isOwned) {
			return false;
		}

		return usage.bytes + usage.casBytes + size > usage.quotaBytes;
	}

	async hasCapturedReference(
		reference: AttestationReference
	): Promise<boolean> {
		return this.hasReference(this.context.requireTenant(), reference);
	}

	async removeCapturedReference(
		reference: AttestationReference,
		fenceStoredAt?: IsoTimestamp
	): Promise<void> {
		const tenant = this.context.requireTenant();
		const now = isoTimestamp(new Date());

		// On the reaper demote path, fence every destructive step on the shared object
		// generation the reaper observed gone. A re-promote bumps cas_object.storedAt,
		// so a row carrying a different one means the object is live again and its
		// reference, presence and quota must all stand together; a row gone (or still
		// carrying the observed value) lets the demote proceed. A direct removal passes
		// no fence. Fencing the edge delete keeps it consistent with the credit: a
		// re-promoted reference is neither stripped nor its charge credited away.
		const repromotedFilter =
			fenceStoredAt === undefined
				? undefined
				: and(
						eq(d1Schema.casObject.digest, reference.digest),
						ne(d1Schema.casObject.storedAt, fenceStoredAt)
					);
		const notRepromoted =
			repromotedFilter === undefined
				? undefined
				: notExists(
						this.context.d1
							.select({ one: sql`1` })
							.from(d1Schema.casObject)
							.where(repromotedFilter)
					);

		const edgeDeleteFilter = and(
			this.edgeFilter(tenant, reference),
			notRepromoted
		);
		const stillReferencedFilter = and(
			eq(d1Schema.attestationReference.tenant, tenant),
			eq(d1Schema.attestationReference.digest, reference.digest)
		);
		const presenceFilter = this.presenceFilter(tenant, reference.digest);

		// Delete the edge, then read whether the digest is still referenced and its
		// presence size, in one batch: its statements run sequentially in a
		// transaction, so the reads see the post-delete state, and the eager presence
		// read is discarded when the digest is still referenced.
		const [, stillReferencedRows, presenceRows] = await this.context.d1.batch([
			this.context.d1
				.delete(d1Schema.attestationReference)
				.where(edgeDeleteFilter),
			this.context.d1
				.select({ digest: d1Schema.attestationReference.digest })
				.from(d1Schema.attestationReference)
				.where(stillReferencedFilter),
			this.context.d1
				.select({ size: d1Schema.tenantCasBlob.size })
				.from(d1Schema.tenantCasBlob)
				.where(presenceFilter)
		]);

		if (stillReferencedRows[0] !== undefined) {
			return;
		}

		const presence = presenceRows[0];

		if (presence === undefined) {
			return;
		}
		const presenceExists = exists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.tenantCasBlob)
				.where(presenceFilter)
		);
		const creditFilter = and(
			eq(d1Schema.tenantUsage.tenant, tenant),
			presenceExists,
			notRepromoted
		);

		await this.context.d1.batch([
			this.context.d1
				.update(d1Schema.tenantUsage)
				.set({
					casBytes: sql`${d1Schema.tenantUsage.casBytes} - ${presence.size}`,
					casBlobs: sql`${d1Schema.tenantUsage.casBlobs} - 1`,
					updatedAt: now
				})
				.where(creditFilter),
			this.context.d1
				.delete(d1Schema.tenantCasBlob)
				.where(and(presenceFilter, notRepromoted))
		]);
	}
}
