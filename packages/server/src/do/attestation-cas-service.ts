import {
	type CacheScope,
	type NarInfoGeneration,
	type PredicateType,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { maxAttestationBundleBytes } from '@cupboard/protocol/attestations';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, exists, ne, notExists, sql } from 'drizzle-orm';

import {
	activateObjectIncarnation,
	isObjectIncarnationLive,
	lateWriteTombstoneHorizonMs,
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
	TenantUsageMissingError,
	TenantWritesStoppedError,
	UploadedObjectNotFoundError
} from '../errors.ts';
import { casObjectKey, type R2ObjectKey } from '../http/http.ts';

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
		canCreate: boolean,
		replaceMissingIncarnation?: number
	): Promise<number> {
		const key = casObjectKey(bundle.digest, incarnation);
		const existing = await this.context.env.BLOBS.head(key);

		if (existing !== null) {
			return incarnation;
		}

		if (!canCreate) {
			throw new UploadedObjectNotFoundError(key);
		}

		if (replaceMissingIncarnation !== undefined) {
			const replacement = await this.reserveRepairIncarnation(
				bundle.digest,
				replaceMissingIncarnation
			);

			return this.ensureCasObject(bundle, replacement, true);
		}

		const written = await this.context.env.BLOBS.put(key, bundle.bytes, {
			sha256: bundle.digest,
			onlyIf: { etagDoesNotMatch: '*' }
		});

		if (written !== null) {
			return incarnation;
		}

		const winner = await this.context.env.BLOBS.head(key);

		if (winner === null) {
			throw new UploadedObjectNotFoundError(key);
		}

		return incarnation;
	}

	private async reserveRepairIncarnation(
		digest: Sha256HexDigest,
		incarnation: number
	): Promise<number> {
		const now = isoTimestamp(new Date());
		const removalDeadline = isoTimestamp(
			new Date(Date.now() + lateWriteTombstoneHorizonMs)
		);
		const captured = and(
			eq(d1Schema.objectIncarnation.kind, 'cas'),
			eq(d1Schema.objectIncarnation.objectId, digest),
			eq(d1Schema.objectIncarnation.incarnation, incarnation),
			eq(d1Schema.objectIncarnation.state, 'live')
		);
		const replacement = and(
			eq(d1Schema.objectIncarnation.kind, 'cas'),
			eq(d1Schema.objectIncarnation.objectId, digest),
			eq(d1Schema.objectIncarnation.incarnation, incarnation + 1),
			eq(d1Schema.objectIncarnation.state, 'pending')
		);
		const reserve = this.context.d1
			.update(d1Schema.objectIncarnation)
			.set({
				incarnation: incarnation + 1,
				state: 'pending',
				reservationOwner: sql`null`,
				updatedAt: now
			})
			.where(captured);
		const superseded = this.context.d1
			.select({
				kind: d1Schema.objectIncarnation.kind,
				objectId: d1Schema.objectIncarnation.objectId,
				incarnation: sql<number>`${incarnation}`.as('incarnation'),
				removeAfter: sql<typeof removalDeadline>`${removalDeadline}`.as(
					'remove_after'
				)
			})
			.from(d1Schema.objectIncarnation)
			.where(replacement);
		const queueSuperseded = this.context.d1
			.insert(d1Schema.objectDeletion)
			.select(superseded)
			.onConflictDoUpdate({
				target: [
					d1Schema.objectDeletion.kind,
					d1Schema.objectDeletion.objectId,
					d1Schema.objectDeletion.incarnation
				],
				set: {
					removeAfter: sql`max(${d1Schema.objectDeletion.removeAfter}, excluded.remove_after)`
				}
			});

		await this.context.d1.batch([reserve, queueSuperseded]);

		const reserved = await reserveObjectIncarnation(
			this.context.d1,
			'cas',
			digest
		);

		return reserved.incarnation;
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

		const usage = usageRows[0];

		if (usage === undefined) {
			throw new TenantUsageMissingError(tenant);
		}

		return this.overQuotaForCharge(usage, ownedRows.length > 0, size);
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

	private async claimLiveIncarnation(
		digest: Sha256HexDigest,
		incarnation?: number
	): Promise<number | undefined> {
		const [claimed] = await this.context.d1
			.update(d1Schema.casObject)
			.set({ deleteAfter: sql`null` })
			.where(
				and(
					eq(d1Schema.casObject.digest, digest),
					incarnation === undefined
						? undefined
						: eq(d1Schema.casObject.incarnation, incarnation),
					registeredLiveObjectIncarnation(
						this.context.d1,
						'cas',
						digest,
						d1Schema.casObject.incarnation
					)
				)
			)
			.returning({ incarnation: d1Schema.casObject.incarnation });

		return claimed?.incarnation;
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

	/**
	 * Claims a previously validated bundle before attaching new references.
	 */
	async reuseBundleIncarnation(
		digest: Sha256HexDigest,
		incarnation: number
	): Promise<boolean> {
		const claimed = await this.claimLiveIncarnation(digest, incarnation);

		if (claimed === undefined) {
			return false;
		}

		return isObjectIncarnationLive(this.context.d1, 'cas', digest, claimed);
	}

	async promoteMeasuredBundle(
		_stagingKey: R2ObjectKey,
		bundle: MeasuredAttestationBundle,
		options?: { readonly restoreMissingObject: true }
	): Promise<void> {
		const claimed = await this.claimLiveIncarnation(bundle.digest);
		const reserved =
			claimed === undefined
				? await reserveObjectIncarnation(this.context.d1, 'cas', bundle.digest)
				: { incarnation: claimed };

		const incarnation = await this.ensureCasObject(
			bundle,
			reserved.incarnation,
			claimed === undefined || options?.restoreMissingObject === true,
			options?.restoreMissingObject === true ? claimed : undefined
		);

		const activation = await activateObjectIncarnation(
			this.context.d1,
			'cas',
			bundle.digest,
			incarnation
		);

		if (activation === 'retired') {
			throw new UploadedObjectNotFoundError(
				casObjectKey(bundle.digest, incarnation)
			);
		}

		const now = isoTimestamp(new Date());
		await this.context.d1
			.insert(d1Schema.casObject)
			.values({
				digest: bundle.digest,
				size: bundle.size,
				incarnation,
				storedAt: now
			})
			.onConflictDoUpdate({
				target: d1Schema.casObject.digest,
				set: {
					size: bundle.size,
					incarnation,
					deleteAfter: sql`null`,
					storedAt: now
				},
				setWhere: promotableStateIncarnation(
					d1Schema.casObject.incarnation,
					incarnation
				)
			})
			.run();

		if (
			await isObjectIncarnationLive(
				this.context.d1,
				'cas',
				bundle.digest,
				incarnation
			)
		) {
			return;
		}

		await queueObjectDeletion(
			this.context.d1,
			'cas',
			bundle.digest,
			incarnation
		);
		throw new UploadedObjectNotFoundError(
			casObjectKey(bundle.digest, incarnation)
		);
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
		const usagePresent = exists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.tenantUsage)
				.where(eq(d1Schema.tenantUsage.tenant, tenant))
		);
		const chargeableTenantFilter = and(
			eq(d1Schema.tenant.id, tenant),
			eq(d1Schema.tenant.status, 'active'),
			usagePresent
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
			eq(d1Schema.casObject.digest, reference.digest),
			tenantChargeable
		);

		const [gateRows] = await this.context.d1.batch([
			this.context.d1
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
				.select((qb) =>
					qb
						.select({
							tenant: sql<TenantId>`${tenant}`.as('tenant'),
							cacheKind: sql<
								typeof cacheIdentity.cacheKind
							>`${cacheIdentity.cacheKind}`.as('cache_kind'),
							cacheName: sql<
								typeof cacheIdentity.cacheName
							>`${cacheIdentity.cacheName}`.as('cache_name'),
							storePathHash: sql<StorePathHash>`${reference.storePathHash}`.as(
								'store_path_hash'
							),
							generation: sql<NarInfoGeneration>`${reference.generation}`.as(
								'generation'
							),
							predicateType: sql<PredicateType>`${reference.predicateType}`.as(
								'predicate_type'
							),
							digest: sql<Sha256HexDigest>`${reference.digest}`.as('digest')
						})
						.from(d1Schema.tenant)
						.where(chargeableTenantFilter)
				)
				.onConflictDoNothing(),
			this.context.d1
				.insert(d1Schema.tenantCasBlob)
				.select((qb) =>
					qb
						.select({
							tenant: sql<TenantId>`${tenant}`.as('tenant'),
							digest: sql<Sha256HexDigest>`${reference.digest}`.as('digest'),
							size: sql<number>`${size}`.as('size')
						})
						.from(d1Schema.tenant)
						.where(chargeableTenantFilter)
				)
				.onConflictDoNothing(),
			this.context.d1
				.update(d1Schema.casObject)
				.set({ deleteAfter: sql`null` })
				.where(graceClearFilter)
		]);

		const gate = gateRows[0];
		if (gate?.status !== 'active') {
			throw new TenantWritesStoppedError(tenant, gate?.status);
		}
		if (gate.usageTenant === null) {
			throw new TenantUsageMissingError(tenant);
		}

		return 'referenced';
	}

	// `usage` is required. Without the row there is no quota to compare against,
	// and the caller refuses with `TenantUsageMissingError`.
	overQuotaForCharge(
		usage: {
			readonly bytes: number;
			readonly casBytes: number;
			readonly quotaBytes: number | null;
		},
		isOwned: boolean,
		size: number
	): boolean {
		if (isOwned || usage.quotaBytes === null) {
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

		// A pending repair has advanced the registry but has not yet published its
		// CAS row. Check the registry too while the CAS row describes the old version.
		const repromotedFilter =
			fenceIncarnation === undefined
				? undefined
				: and(
						eq(d1Schema.casObject.digest, reference.digest),
						ne(d1Schema.casObject.incarnation, fenceIncarnation)
					);
		const repromotedRegistryFilter =
			fenceIncarnation === undefined
				? undefined
				: and(
						eq(d1Schema.objectIncarnation.kind, 'cas'),
						eq(d1Schema.objectIncarnation.objectId, reference.digest),
						ne(d1Schema.objectIncarnation.incarnation, fenceIncarnation)
					);
		const notRepromoted =
			fenceIncarnation === undefined
				? undefined
				: and(
						notExists(
							this.context.d1
								.select({ one: sql`1` })
								.from(d1Schema.casObject)
								.where(repromotedFilter)
						),
						notExists(
							this.context.d1
								.select({ one: sql`1` })
								.from(d1Schema.objectIncarnation)
								.where(repromotedRegistryFilter)
						)
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
