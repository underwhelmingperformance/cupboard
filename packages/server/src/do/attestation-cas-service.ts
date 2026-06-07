import {
	type PredicateType,
	type Sha256HexDigest
} from '@cupboard/nix/scalars';
import { and, eq, exists, notExists, sql } from 'drizzle-orm';

import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	AttestationBundleTooLargeError,
	UploadedObjectNotFoundError
} from '../errors.ts';
import { casObjectKey, maxAttestationBundleBytes } from '../http/http.ts';

import { type ServerContext } from './context.ts';

export interface MeasuredAttestationBundle {
	readonly digest: Sha256HexDigest;
	readonly size: number;
	readonly bytes: Uint8Array;
}

export interface AttestationReference {
	readonly cache: string;
	readonly storePathHash: string;
	readonly generation: number;
	readonly predicateType: PredicateType;
	readonly digest: Sha256HexDigest;
}

export type AttestationReferenceOutcome =
	| 'referenced'
	| 'already-present'
	| 'over-quota';

export class AttestationCasService {
	constructor(private readonly context: ServerContext) {}

	async measureStagedBundle(
		stagingKey: string
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
			digest: (await sha256HexBytes(bytes)) as Sha256HexDigest,
			size: bytes.byteLength,
			bytes
		};
	}

	async promoteMeasuredBundle(
		_stagingKey: string,
		bundle: MeasuredAttestationBundle
	): Promise<void> {
		await this.ensureCasObject(bundle);

		const now = new Date().toISOString();
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

		const now = new Date().toISOString();
		const presenceMissing = notExists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.tenantCasBlob)
				.where(this.presenceFilter(tenant, reference.digest))
		);

		await this.context.d1.batch([
			this.context.d1
				.update(d1Schema.tenantUsage)
				.set({
					casBytes: sql`${d1Schema.tenantUsage.casBytes} + ${size}`,
					casBlobs: sql`${d1Schema.tenantUsage.casBlobs} + 1`,
					updatedAt: now
				})
				.where(and(eq(d1Schema.tenantUsage.tenant, tenant), presenceMissing)),
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

	async wouldExceedQuota(
		digest: Sha256HexDigest,
		size: number
	): Promise<boolean> {
		return this.overQuota(this.context.requireTenant(), digest, size);
	}

	async hasCapturedReference(
		reference: AttestationReference
	): Promise<boolean> {
		return this.hasReference(this.context.requireTenant(), reference);
	}

	async removeCapturedReference(
		reference: AttestationReference
	): Promise<void> {
		const tenant = this.context.requireTenant();
		const now = new Date().toISOString();
		const edgeFilter = this.edgeFilter(tenant, reference);

		await this.context.d1
			.delete(d1Schema.attestationReference)
			.where(edgeFilter);

		const stillReferenced = await this.context.d1
			.select({ digest: d1Schema.attestationReference.digest })
			.from(d1Schema.attestationReference)
			.where(
				and(
					eq(d1Schema.attestationReference.tenant, tenant),
					eq(d1Schema.attestationReference.digest, reference.digest)
				)
			)
			.get();

		if (stillReferenced !== undefined) {
			return;
		}

		const presence = await this.context.d1
			.select({ size: d1Schema.tenantCasBlob.size })
			.from(d1Schema.tenantCasBlob)
			.where(this.presenceFilter(tenant, reference.digest))
			.get();

		if (presence === undefined) {
			return;
		}

		const presenceFilter = this.presenceFilter(tenant, reference.digest);
		await this.context.d1.batch([
			this.context.d1
				.update(d1Schema.tenantUsage)
				.set({
					casBytes: sql`${d1Schema.tenantUsage.casBytes} - ${presence.size}`,
					casBlobs: sql`${d1Schema.tenantUsage.casBlobs} - 1`,
					updatedAt: now
				})
				.where(
					and(
						eq(d1Schema.tenantUsage.tenant, tenant),
						exists(
							this.context.d1
								.select({ one: sql`1` })
								.from(d1Schema.tenantCasBlob)
								.where(presenceFilter)
						)
					)
				),
			this.context.d1.delete(d1Schema.tenantCasBlob).where(presenceFilter)
		]);
	}

	private async overQuota(
		tenant: string,
		digest: string,
		size: number
	): Promise<boolean> {
		const usage = await this.context.d1
			.select({
				bytes: d1Schema.tenantUsage.bytes,
				casBytes: d1Schema.tenantUsage.casBytes,
				quotaBytes: d1Schema.tenantUsage.quotaBytes
			})
			.from(d1Schema.tenantUsage)
			.where(eq(d1Schema.tenantUsage.tenant, tenant))
			.get();

		if (usage === undefined) {
			return false;
		}

		if (usage.quotaBytes === null) {
			return false;
		}

		const owned = await this.context.d1
			.select({ digest: d1Schema.tenantCasBlob.digest })
			.from(d1Schema.tenantCasBlob)
			.where(this.presenceFilter(tenant, digest))
			.get();

		if (owned !== undefined) {
			return false;
		}

		return usage.bytes + usage.casBytes + size > usage.quotaBytes;
	}

	private edgeFilter(tenant: string, reference: AttestationReference) {
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
		tenant: string,
		reference: AttestationReference
	): Promise<boolean> {
		const existing = await this.context.d1
			.select({ digest: d1Schema.attestationReference.digest })
			.from(d1Schema.attestationReference)
			.where(this.edgeFilter(tenant, reference))
			.get();

		return existing !== undefined;
	}

	private presenceFilter(tenant: string, digest: string) {
		return and(
			eq(d1Schema.tenantCasBlob.tenant, tenant),
			eq(d1Schema.tenantCasBlob.digest, digest)
		);
	}
}
