import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { type ArtifactTaskOwner } from '@cupboard/protocol/artifact-jobs';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	asc,
	eq,
	exists,
	gt,
	inArray,
	isNull,
	lte,
	notExists,
	or,
	sql
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	type SharedListingOutputCleanupClaim,
	type SharedListingOutputCleanupClaimResult,
	sharedListingOutputCleanupClaimSchema,
	type SharedListingOutputCleanupCursor,
	sharedListingOutputCleanupCursorSchema,
	type SharedListingOutputDrainResult
} from '../blob/shared-listing-output-cleanup.ts';
import { sharedListingOutputReferenceSchema } from '../blob/shared-listing-outputs.ts';
import { jsonRowList, jsonValueList } from '../do/json-list.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';

const pageSize = 8;
const leaseDurationMs = 30_000;
type Scope = typeof schema.sharedListingOutputCleanup.$inferSelect;

export class SharedListingOutputCleanupStore {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	private async execute<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof SharedFactsUnavailableError) {
				throw error;
			}
			throw new SharedFactsUnavailableError(error);
		}
	}

	private decoded(row: Scope): SharedListingOutputCleanupClaim {
		return sharedListingOutputCleanupClaimSchema.parse({
			narHash: row.narHash,
			epoch: row.epoch,
			cursor: row.cursor ?? undefined,
			owner: row.owner,
			leaseExpiresAt: row.leaseExpiresAt
		});
	}

	private owns(claim: SharedListingOutputCleanupClaim, now: IsoTimestamp) {
		return and(
			eq(schema.sharedListingOutputCleanup.narHash, claim.narHash),
			eq(schema.sharedListingOutputCleanup.epoch, claim.epoch),
			eq(schema.sharedListingOutputCleanup.owner, claim.owner),
			eq(
				schema.sharedListingOutputCleanup.leaseExpiresAt,
				claim.leaseExpiresAt
			),
			claim.cursor === undefined
				? isNull(schema.sharedListingOutputCleanup.cursor)
				: eq(schema.sharedListingOutputCleanup.cursor, claim.cursor),
			gt(schema.sharedListingOutputCleanup.leaseExpiresAt, now)
		);
	}

	private parent(narHash: NixSha256HashString) {
		return this.database
			.select({ one: sql`1` })
			.from(schema.blobReference)
			.where(eq(schema.blobReference.narHash, narHash));
	}

	async claim(
		narHash: NixSha256HashString,
		owner: ArtifactTaskOwner,
		now: IsoTimestamp
	): Promise<SharedListingOutputCleanupClaimResult> {
		const deadline = isoTimestamp(new Date(Date.parse(now) + leaseDurationMs));
		return this.execute(async () => {
			const available = and(
				eq(schema.sharedListingOutputCleanup.narHash, narHash),
				lte(schema.sharedListingOutputCleanup.nextAttemptAt, now),
				or(
					isNull(schema.sharedListingOutputCleanup.leaseExpiresAt),
					lte(schema.sharedListingOutputCleanup.leaseExpiresAt, now)
				)
			);
			const rows = await this.database
				.update(schema.sharedListingOutputCleanup)
				.set({ owner, leaseExpiresAt: deadline, nextAttemptAt: deadline })
				.where(available)
				.returning();
			if (rows[0] !== undefined) {
				return { kind: 'claimed', claim: this.decoded(rows[0]) };
			}
			const current = await this.database
				.select()
				.from(schema.sharedListingOutputCleanup)
				.where(eq(schema.sharedListingOutputCleanup.narHash, narHash))
				.get();
			if (current === undefined) {
				return { kind: 'absent' };
			}
			if (
				current.owner === owner &&
				current.leaseExpiresAt !== null &&
				current.leaseExpiresAt > now
			) {
				return { kind: 'claimed', claim: this.decoded(current) };
			}
			return { kind: 'deferred', retryAt: current.nextAttemptAt };
		});
	}

	async drain(
		input: SharedListingOutputCleanupClaim,
		now: IsoTimestamp
	): Promise<SharedListingOutputDrainResult> {
		const claim = sharedListingOutputCleanupClaimSchema.parse(input);
		return this.execute(async () => {
			const ownedScope = this.database
				.select({ one: sql`1` })
				.from(schema.sharedListingOutputCleanup)
				.where(this.owns(claim, now));
			const parent = this.parent(claim.narHash);
			const eligible = and(exists(ownedScope), notExists(parent));
			const page = await this.database
				.select()
				.from(schema.sharedListingOutputReference)
				.where(
					and(
						eq(schema.sharedListingOutputReference.narHash, claim.narHash),
						claim.cursor === undefined
							? undefined
							: gt(
									schema.sharedListingOutputReference.generatorRevision,
									claim.cursor
								),
						eligible
					)
				)
				.orderBy(asc(schema.sharedListingOutputReference.generatorRevision))
				.limit(pageSize);
			const references = page.map((row) =>
				sharedListingOutputReferenceSchema.parse(row)
			);
			const captures = jsonRowList(references);
			const captured = captures.matches({
				narHash: schema.sharedListingOutputReference.narHash,
				generatorRevision:
					schema.sharedListingOutputReference.generatorRevision,
				epoch: schema.sharedListingOutputReference.epoch,
				sourceIncarnation:
					schema.sharedListingOutputReference.sourceIncarnation,
				computationGeneration:
					schema.sharedListingOutputReference.computationGeneration,
				digest: schema.sharedListingOutputReference.digest,
				size: schema.sharedListingOutputReference.size,
				createdAt: schema.sharedListingOutputReference.createdAt
			});
			const capturedMeasurement = and(
				eq(
					schema.sharedListingOutputReference.narHash,
					captures.column('narHash')
				),
				eq(
					schema.sharedListingOutputReference.generatorRevision,
					captures.column('generatorRevision')
				),
				eq(schema.sharedListingOutputReference.epoch, captures.column('epoch')),
				eq(
					schema.sharedListingOutputReference.sourceIncarnation,
					captures.column('sourceIncarnation')
				),
				eq(
					schema.sharedListingOutputReference.computationGeneration,
					captures.column('computationGeneration')
				),
				eq(
					schema.sharedListingOutputReference.digest,
					captures.column('digest')
				),
				eq(schema.sharedListingOutputReference.size, captures.column('size')),
				eq(
					schema.sharedListingOutputReference.createdAt,
					captures.column('createdAt')
				),
				eq(schema.sharedListingOutputReference.digest, schema.casObject.digest)
			);
			const capturedReference = this.database
				.select({ one: sql`1` })
				.from(schema.sharedListingOutputReference)
				.where(capturedMeasurement);
			const matchingReference = captures.anyRow(exists(capturedReference));
			const digests = jsonValueList(references.map((row) => row.digest));
			const clearGrace = this.database
				.update(schema.casObject)
				.set({ deleteAfter: sql`null` })
				.where(
					and(
						eligible,
						inArray(schema.casObject.digest, digests),
						matchingReference
					)
				);
			const remove = this.database
				.delete(schema.sharedListingOutputReference)
				.where(and(eligible, captured))
				.returning({
					revision: schema.sharedListingOutputReference.generatorRevision
				});
			const remaining = this.database
				.select({ one: sql`1` })
				.from(schema.sharedListingOutputReference)
				.where(eq(schema.sharedListingOutputReference.narHash, claim.narHash));
			const scopeDone = or(exists(parent), notExists(remaining));
			const finish = this.database
				.delete(schema.sharedListingOutputCleanup)
				.where(and(this.owns(claim, now), scopeDone))
				.returning({ narHash: schema.sharedListingOutputCleanup.narHash });
			const cursor = references.at(-1)?.generatorRevision ?? claim.cursor;
			const checkpoint = this.database
				.update(schema.sharedListingOutputCleanup)
				.set({
					cursor: cursor ?? sql`null`,
					owner: sql`null`,
					leaseExpiresAt: sql`null`,
					nextAttemptAt: now
				})
				.where(and(this.owns(claim, now), notExists(parent)))
				.returning({ narHash: schema.sharedListingOutputCleanup.narHash });
			const [, removed, finished, advanced] = await this.database.batch([
				clearGrace,
				remove,
				finish,
				checkpoint
			]);
			if (finished.length === 0 && advanced.length === 0) {
				return { kind: 'unavailable' };
			}
			return {
				kind: 'drained',
				removed: removed.length,
				hasMore: advanced.length > 0
			};
		});
	}

	async cutoff(): Promise<IsoTimestamp> {
		return this.execute(async () => {
			const rows = await this.database.all<{ at: string }>(
				sql`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS at`
			);
			return sharedListingOutputCleanupCursorSchema.shape.at.parse(rows[0]?.at);
		});
	}

	async due(
		through: IsoTimestamp,
		input?: SharedListingOutputCleanupCursor
	): Promise<{
		readonly parents: readonly NixSha256HashString[];
		readonly next?: SharedListingOutputCleanupCursor;
	}> {
		const after =
			input === undefined
				? undefined
				: sharedListingOutputCleanupCursorSchema.parse(input);
		return this.execute(async () => {
			const rows = await this.database
				.select({
					at: schema.sharedListingOutputCleanup.nextAttemptAt,
					narHash: schema.sharedListingOutputCleanup.narHash
				})
				.from(schema.sharedListingOutputCleanup)
				.where(
					and(
						lte(schema.sharedListingOutputCleanup.nextAttemptAt, through),
						after === undefined
							? undefined
							: sql`(${schema.sharedListingOutputCleanup.nextAttemptAt}, ${schema.sharedListingOutputCleanup.narHash}) > (${after.at}, ${after.narHash})`
					)
				)
				.orderBy(
					asc(schema.sharedListingOutputCleanup.nextAttemptAt),
					asc(schema.sharedListingOutputCleanup.narHash)
				)
				.limit(pageSize + 1);
			const hasMore = rows.length > pageSize;
			const last = rows[pageSize - 1];
			return {
				parents: rows.slice(0, pageSize).map((row) => row.narHash),
				...(hasMore &&
					last !== undefined && {
						next: sharedListingOutputCleanupCursorSchema.parse(last)
					})
			};
		});
	}
}
