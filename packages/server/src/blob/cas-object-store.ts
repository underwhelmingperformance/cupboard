import { type Sha256HexDigest } from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { UploadedObjectNotFoundError } from '../errors.ts';
import { casObjectKey } from '../http/http.ts';

import {
	activateObjectIncarnation,
	isObjectIncarnationLive,
	lateWriteTombstoneHorizonMs,
	promotableStateIncarnation,
	queueObjectDeletion,
	registeredLiveObjectIncarnation,
	reserveObjectIncarnation
} from './object-incarnation.ts';

export interface MeasuredCasObject {
	readonly digest: Sha256HexDigest;
	readonly size: number;
	readonly bytes: Uint8Array;
}

/**
 * Stores measured bytes at immutable CAS incarnations. Logical references,
 * read authority and tenant quota belong to the publishing service.
 */
export class CasObjectStore {
	constructor(
		private readonly database: DrizzleD1Database<typeof d1Schema>,
		private readonly blobs: R2Bucket
	) {}

	private async ensureCasObject(
		object: MeasuredCasObject,
		incarnation: number,
		canCreate: boolean,
		replaceMissingIncarnation?: number
	): Promise<number> {
		const key = casObjectKey(object.digest, incarnation);
		const existing = await this.blobs.head(key);

		if (existing !== null) {
			return incarnation;
		}

		if (!canCreate) {
			throw new UploadedObjectNotFoundError(key);
		}

		if (replaceMissingIncarnation !== undefined) {
			const replacement = await this.reserveRepairIncarnation(
				object.digest,
				replaceMissingIncarnation
			);

			return this.ensureCasObject(object, replacement, true);
		}

		const written = await this.blobs.put(key, object.bytes, {
			sha256: object.digest,
			onlyIf: { etagDoesNotMatch: '*' }
		});

		if (written !== null) {
			return incarnation;
		}

		const winner = await this.blobs.head(key);

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
		const reserve = this.database
			.update(d1Schema.objectIncarnation)
			.set({
				incarnation: incarnation + 1,
				state: 'pending',
				reservationOwner: sql`null`,
				updatedAt: now
			})
			.where(captured);
		const superseded = this.database
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
		const queueSuperseded = this.database
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

		await this.database.batch([reserve, queueSuperseded]);

		const reserved = await reserveObjectIncarnation(
			this.database,
			'cas',
			digest
		);

		return reserved.incarnation;
	}

	private async claimLiveIncarnation(
		digest: Sha256HexDigest,
		incarnation?: number
	): Promise<number | undefined> {
		const [claimed] = await this.database
			.update(d1Schema.casObject)
			.set({ deleteAfter: sql`null` })
			.where(
				and(
					eq(d1Schema.casObject.digest, digest),
					incarnation === undefined
						? undefined
						: eq(d1Schema.casObject.incarnation, incarnation),
					registeredLiveObjectIncarnation(
						this.database,
						'cas',
						digest,
						d1Schema.casObject.incarnation
					)
				)
			)
			.returning({ incarnation: d1Schema.casObject.incarnation });

		return claimed?.incarnation;
	}

	/**
	 * Claims a live incarnation before creating a logical reference.
	 */
	async reuse(digest: Sha256HexDigest, incarnation: number): Promise<boolean> {
		const claimed = await this.claimLiveIncarnation(digest, incarnation);
		if (claimed === undefined) {
			return false;
		}
		return isObjectIncarnationLive(this.database, 'cas', digest, claimed);
	}

	/**
	 * Stores measured bytes and returns their live incarnation.
	 */
	async promote(
		object: MeasuredCasObject,
		options?: { readonly restoreMissingObject: true }
	): Promise<number> {
		const claimed = await this.claimLiveIncarnation(object.digest);
		const reserved =
			claimed === undefined
				? await reserveObjectIncarnation(this.database, 'cas', object.digest)
				: { incarnation: claimed };

		const incarnation = await this.ensureCasObject(
			object,
			reserved.incarnation,
			claimed === undefined || options?.restoreMissingObject === true,
			options?.restoreMissingObject === true ? claimed : undefined
		);

		const activation = await activateObjectIncarnation(
			this.database,
			'cas',
			object.digest,
			incarnation
		);

		if (activation === 'retired') {
			throw new UploadedObjectNotFoundError(
				casObjectKey(object.digest, incarnation)
			);
		}

		const now = isoTimestamp(new Date());
		await this.database
			.insert(d1Schema.casObject)
			.values({
				digest: object.digest,
				size: object.size,
				incarnation,
				storedAt: now
			})
			.onConflictDoUpdate({
				target: d1Schema.casObject.digest,
				set: {
					size: object.size,
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
				this.database,
				'cas',
				object.digest,
				incarnation
			)
		) {
			return incarnation;
		}

		await queueObjectDeletion(this.database, 'cas', object.digest, incarnation);
		throw new UploadedObjectNotFoundError(
			casObjectKey(object.digest, incarnation)
		);
	}
}
