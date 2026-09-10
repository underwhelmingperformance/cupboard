import {
	type CacheScope,
	type NarInfoGeneration,
	type PredicateType,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, exists, ne, notExists, sql } from 'drizzle-orm';

import {
	activateObjectIncarnation,
	isObjectIncarnationLive,
	promotableStateIncarnation,
	queueObjectDeletion,
	registeredLiveObjectIncarnation,
	reserveObjectIncarnation
} from '../blob/object-incarnation.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import { cacheIdentityColumns, cacheIdentityCondition } from '../db/cache.ts';
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
	readonly cache: CacheScope;
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
		bundle: MeasuredAttestationBundle,
		incarnation: number,
		canCreate: boolean
	): Promise<void> {
		const key = casObjectKey(bundle.digest, incarnation);
		const existing = await this.context.env.BLOBS.head(key);

		if (existing !== null) {
			return;
		}

		if (!canCreate) {
			throw new UploadedObjectNotFoundError(key);
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
			cacheIdentityCondition(
				d1Schema.attestationReference.cacheKind,
				d1Schema.attestationReference.cacheName,
				reference.cache
			),
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
		const [claimed] = await this.context.d1
			.update(d1Schema.casObject)
			.set({ deleteAfter: sql`null` })
			.where(
				and(
					eq(d1Schema.casObject.digest, bundle.digest),
					registeredLiveObjectIncarnation(
						this.context.d1,
						'cas',
						bundle.digest,
						d1Schema.casObject.incarnation
					)
				)
			)
			.returning({ incarnation: d1Schema.casObject.incarnation });
		const reserved =
			claimed ??
			(await reserveObjectIncarnation(this.context.d1, 'cas', bundle.digest));

		await this.ensureCasObject(
			bundle,
			reserved.incarnation,
			claimed === undefined
		);

		const activation = await activateObjectIncarnation(
			this.context.d1,
			'cas',
			bundle.digest,
			reserved.incarnation
		);

		if (activation === 'retired' && claimed === undefined) {
			throw new UploadedObjectNotFoundError(
				casObjectKey(bundle.digest, reserved.incarnation)
			);
		}

		const now = isoTimestamp(new Date());
		await this.context.d1
			.insert(d1Schema.casObject)
			.values({
				digest: bundle.digest,
				size: bundle.size,
				incarnation: reserved.incarnation,
				storedAt: now
			})
			.onConflictDoUpdate({
				target: d1Schema.casObject.digest,
				set: {
					size: bundle.size,
					incarnation: reserved.incarnation,
					deleteAfter: sql`null`,
					storedAt: now
				},
				setWhere: promotableStateIncarnation(
					d1Schema.casObject.incarnation,
					reserved.incarnation
				)
			})
			.run();

		if (
			!(await isObjectIncarnationLive(
				this.context.d1,
				'cas',
				bundle.digest,
				reserved.incarnation
			))
		) {
			await queueObjectDeletion(
				this.context.d1,
				'cas',
				bundle.digest,
				reserved.incarnation
			);
			throw new UploadedObjectNotFoundError(
				casObjectKey(bundle.digest, reserved.incarnation)
			);
		}
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
		const cache = this.context.cacheRepository.require(reference.cache);
		const cacheIdentity = cacheIdentityColumns(cache.scope);
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
		const referenceStatement = this.context.d1
			.insert(d1Schema.attestationReference)
			.values({
				tenant,
				...cacheIdentity,
				storePathHash: reference.storePathHash,
				generation: reference.generation,
				predicateType: reference.predicateType,
				digest: reference.digest
			})
			.onConflictDoNothing();

		await this.context.d1.batch([
			this.context.d1
				.update(d1Schema.tenantUsage)
				.set({
					casBytes: sql`${d1Schema.tenantUsage.casBytes} + ${size}`,
					casBlobs: sql`${d1Schema.tenantUsage.casBlobs} + 1`,
					updatedAt: now
				})
				.where(chargeFilter),
			referenceStatement,
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
		fenceIncarnation?: number
	): Promise<void> {
		const tenant = this.context.requireTenant();
		const now = isoTimestamp(new Date());

		// The reaper observed a particular object generation before it found the
		// object missing. If another request promotes the object again, every delete
		// and quota credit below must fail its storedAt fence so the new generation
		// keeps its reference and charge. Direct removal does not use this fence.
		const repromotedFilter =
			fenceIncarnation === undefined
				? undefined
				: and(
						eq(d1Schema.casObject.digest, reference.digest),
						ne(d1Schema.casObject.incarnation, fenceIncarnation)
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

		// D1 executes a batch sequentially in one transaction. These reads must see
		// the state after the edge deletion so only the last reference releases the
		// tenant's charge.
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
