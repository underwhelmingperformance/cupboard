import { type Logger } from '@cupboard/logger';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	nixSha256HashSchema,
	type NixSha256HashString,
	type Sha256HexDigest,
	sha256HexDigestSchema
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	asc,
	eq,
	gte,
	inArray,
	lte,
	notExists,
	sql,
	type SQLWrapper
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import {
	blobReaperGraceMs,
	casObjectKey,
	narObjectKey,
	type R2ObjectKey
} from '../http/http.ts';

import {
	isObjectIncarnationLive,
	type SharedObjectKind
} from './object-incarnation.ts';

interface ObjectIncarnationIdentity {
	readonly kind: SharedObjectKind;
	readonly objectId: string;
	readonly incarnation: number;
}

function objectKey(row: ObjectIncarnationIdentity): R2ObjectKey {
	return row.kind === 'nar'
		? narObjectKey(nixSha256HashSchema.parse(row.objectId), row.incarnation)
		: casObjectKey(sha256HexDigestSchema.parse(row.objectId), row.incarnation);
}

/**
 * Retries deletion of R2 objects after their `blob_state` or `cas_object` rows
 * have been deleted. Each marker identifies one immutable R2 key, so deleting
 * that key cannot remove an object created by a later promotion. A future
 * removal deadline keeps the old object available while a preceding Worker or
 * cached narinfo can still refer to it.
 */
export async function drainObjectDeletions(
	database: DrizzleD1Database<typeof d1Schema>,
	blobs: R2Bucket,
	kind: SharedObjectKind,
	limit: number
): Promise<number> {
	const now = isoTimestamp(new Date());
	const rows = await database
		.select({
			kind: d1Schema.objectDeletion.kind,
			objectId: d1Schema.objectDeletion.objectId,
			incarnation: d1Schema.objectDeletion.incarnation,
			removeAfter: d1Schema.objectDeletion.removeAfter
		})
		.from(d1Schema.objectDeletion)
		.where(
			and(
				eq(d1Schema.objectDeletion.kind, kind),
				lte(d1Schema.objectDeletion.removeAfter, now)
			)
		)
		.orderBy(
			asc(d1Schema.objectDeletion.removeAfter),
			asc(d1Schema.objectDeletion.objectId),
			asc(d1Schema.objectDeletion.incarnation)
		)
		.limit(limit)
		.all();

	if (rows.length === 0) {
		return 0;
	}

	await blobs.delete(rows.map((row) => objectKey(row)));

	const deletions = rows.map((row) =>
		database
			.delete(d1Schema.objectDeletion)
			.where(
				and(
					eq(d1Schema.objectDeletion.kind, row.kind),
					eq(d1Schema.objectDeletion.objectId, row.objectId),
					eq(d1Schema.objectDeletion.incarnation, row.incarnation),
					eq(d1Schema.objectDeletion.removeAfter, row.removeAfter)
				)
			)
	);
	const [first, ...rest] = deletions;

	if (first !== undefined) {
		await database.batch([first, ...rest]);
	}

	return rows.length;
}

function positiveSafeInteger(value: string | undefined): number | undefined {
	const parsed = Number(value);

	return value !== undefined && Number.isSafeInteger(parsed) && parsed > 0
		? parsed
		: undefined;
}

function sha256Hex(object: R2Object): string | undefined {
	const checksum = object.checksums.sha256;

	return checksum === undefined
		? undefined
		: [...new Uint8Array(checksum)]
				.map((byte) => byte.toString(16).padStart(2, '0'))
				.join('');
}

function blobStateIsBehind(
	database: DrizzleD1Database<typeof d1Schema>,
	narHash: NixSha256HashString | SQLWrapper,
	incarnation: number | SQLWrapper
) {
	const currentOrNewer = and(
		eq(d1Schema.blobState.narHash, narHash),
		gte(d1Schema.blobState.incarnation, incarnation)
	);
	const stateRow = database
		.select({ one: sql`1` })
		.from(d1Schema.blobState)
		.where(currentOrNewer);

	return notExists(stateRow);
}

function casObjectIsBehind(
	database: DrizzleD1Database<typeof d1Schema>,
	digest: Sha256HexDigest | SQLWrapper,
	incarnation: number | SQLWrapper
) {
	const currentOrNewer = and(
		eq(d1Schema.casObject.digest, digest),
		gte(d1Schema.casObject.incarnation, incarnation)
	);
	const stateRow = database
		.select({ one: sql`1` })
		.from(d1Schema.casObject)
		.where(currentOrNewer);

	return notExists(stateRow);
}

async function didRetireIncarnation(
	database: DrizzleD1Database<typeof d1Schema>,
	blobs: R2Bucket,
	row: ObjectIncarnationIdentity,
	staleBefore: IsoTimestamp
): Promise<boolean> {
	const stateRowBehind =
		row.kind === 'nar'
			? blobStateIsBehind(
					database,
					nixSha256HashSchema.parse(row.objectId),
					row.incarnation
				)
			: casObjectIsBehind(
					database,
					sha256HexDigestSchema.parse(row.objectId),
					row.incarnation
				);
	const now = isoTimestamp(new Date());
	const retire = database
		.update(d1Schema.objectIncarnation)
		.set({ state: 'absent', reservationOwner: sql`null`, updatedAt: now })
		.where(
			and(
				eq(d1Schema.objectIncarnation.kind, row.kind),
				eq(d1Schema.objectIncarnation.objectId, row.objectId),
				eq(d1Schema.objectIncarnation.incarnation, row.incarnation),
				inArray(d1Schema.objectIncarnation.state, ['pending', 'live']),
				lte(d1Schema.objectIncarnation.updatedAt, staleBefore),
				stateRowBehind
			)
		)
		.returning({ objectId: d1Schema.objectIncarnation.objectId });
	const retiredIdentity = and(
		eq(d1Schema.objectIncarnation.kind, row.kind),
		eq(d1Schema.objectIncarnation.objectId, row.objectId),
		eq(d1Schema.objectIncarnation.incarnation, row.incarnation),
		eq(d1Schema.objectIncarnation.state, 'absent')
	);
	const queueDeletion = database
		.insert(d1Schema.objectDeletion)
		.select(
			database
				.select({
					kind: d1Schema.objectIncarnation.kind,
					objectId: d1Schema.objectIncarnation.objectId,
					incarnation: d1Schema.objectIncarnation.incarnation,
					removeAfter: sql<IsoTimestamp>`${now}`.as('remove_after')
				})
				.from(d1Schema.objectIncarnation)
				.where(retiredIdentity)
		)
		.onConflictDoNothing();
	const [retiredRows] = await database.batch([retire, queueDeletion]);
	const retired = retiredRows.at(0);

	if (retired === undefined) {
		return false;
	}

	await blobs.delete(objectKey(row));
	await database
		.delete(d1Schema.objectDeletion)
		.where(
			and(
				eq(d1Schema.objectDeletion.kind, row.kind),
				eq(d1Schema.objectDeletion.objectId, row.objectId),
				eq(d1Schema.objectDeletion.incarnation, row.incarnation)
			)
		);

	return true;
}

async function didRecoverNar(
	database: DrizzleD1Database<typeof d1Schema>,
	row: ObjectIncarnationIdentity,
	object: R2Object,
	staleBefore: IsoTimestamp
): Promise<boolean> {
	const parsedNarHash = nixSha256HashSchema.safeParse(row.objectId);
	const narSize = positiveSafeInteger(object.customMetadata?.narSize);
	const checksum = object.checksums.sha256;

	if (
		checksum === undefined ||
		narSize === undefined ||
		!parsedNarHash.success
	) {
		return false;
	}

	const narHash: NixSha256HashString = parsedNarHash.data;
	const fileHash = NixSha256Hash.fromDigest(new Uint8Array(checksum)).value;
	const now = isoTimestamp(new Date());
	const [activated] = await database
		.update(d1Schema.objectIncarnation)
		.set({ state: 'live', reservationOwner: sql`null`, updatedAt: now })
		.where(
			and(
				eq(d1Schema.objectIncarnation.kind, 'nar'),
				eq(d1Schema.objectIncarnation.objectId, narHash),
				eq(d1Schema.objectIncarnation.incarnation, row.incarnation),
				inArray(d1Schema.objectIncarnation.state, ['pending', 'live']),
				lte(d1Schema.objectIncarnation.updatedAt, staleBefore)
			)
		)
		.returning({ incarnation: d1Schema.objectIncarnation.incarnation });

	if (activated === undefined) {
		return false;
	}

	await database.run(sql`
		INSERT INTO blob_state
			(nar_hash, file_hash, file_size, compression, nar_size,
			 incarnation, verified_at, delete_after)
		SELECT ${narHash}, ${fileHash}, ${object.size}, 'zstd',
			${narSize}, ${row.incarnation}, ${now}, NULL
		FROM object_incarnation
		WHERE kind = 'nar' AND object_id = ${narHash}
			AND incarnation = ${row.incarnation} AND state = 'live'
		ON CONFLICT(nar_hash) DO UPDATE SET
			file_hash = excluded.file_hash,
			file_size = excluded.file_size,
			compression = excluded.compression,
			nar_size = excluded.nar_size,
			incarnation = excluded.incarnation,
			delete_after = NULL,
			verified_at = excluded.verified_at
		WHERE blob_state.incarnation <= excluded.incarnation
	`);

	return isObjectIncarnationLive(database, 'nar', narHash, row.incarnation);
}

async function didRecoverCas(
	database: DrizzleD1Database<typeof d1Schema>,
	row: ObjectIncarnationIdentity,
	object: R2Object,
	staleBefore: IsoTimestamp
): Promise<boolean> {
	if (sha256Hex(object) !== row.objectId) {
		return false;
	}

	const now = isoTimestamp(new Date());
	const [activated] = await database
		.update(d1Schema.objectIncarnation)
		.set({ state: 'live', reservationOwner: sql`null`, updatedAt: now })
		.where(
			and(
				eq(d1Schema.objectIncarnation.kind, 'cas'),
				eq(d1Schema.objectIncarnation.objectId, row.objectId),
				eq(d1Schema.objectIncarnation.incarnation, row.incarnation),
				inArray(d1Schema.objectIncarnation.state, ['pending', 'live']),
				lte(d1Schema.objectIncarnation.updatedAt, staleBefore)
			)
		)
		.returning({ incarnation: d1Schema.objectIncarnation.incarnation });

	if (activated === undefined) {
		return false;
	}

	await database.run(sql`
		INSERT INTO cas_object
			(digest, size, incarnation, stored_at, delete_after)
		SELECT ${row.objectId}, ${object.size}, ${row.incarnation}, ${now}, NULL
		FROM object_incarnation
		WHERE kind = 'cas' AND object_id = ${row.objectId}
			AND incarnation = ${row.incarnation} AND state = 'live'
		ON CONFLICT(digest) DO UPDATE SET
			size = excluded.size,
			incarnation = excluded.incarnation,
			delete_after = NULL,
			stored_at = excluded.stored_at
		WHERE cas_object.incarnation <= excluded.incarnation
	`);

	return isObjectIncarnationLive(
		database,
		'cas',
		row.objectId,
		row.incarnation
	);
}

/**
 * Recovers or retires old promotion reservations whose state-table row is
 * missing or older. Version and age predicates stop a repair if a promoter or
 * collector changes the object while the R2 probe is in flight. A failed probe
 * moves behind the current stale page so later reservations can make progress.
 */
export async function recoverAbandonedIncarnations(
	database: DrizzleD1Database<typeof d1Schema>,
	blobs: R2Bucket,
	kind: SharedObjectKind,
	now: Date,
	limit: number,
	logger: Logger
): Promise<number> {
	const staleBefore = isoTimestamp(new Date(now.getTime() - blobReaperGraceMs));
	const stateRowBehind =
		kind === 'nar'
			? blobStateIsBehind(
					database,
					d1Schema.objectIncarnation.objectId,
					d1Schema.objectIncarnation.incarnation
				)
			: casObjectIsBehind(
					database,
					d1Schema.objectIncarnation.objectId,
					d1Schema.objectIncarnation.incarnation
				);
	const rows = await database
		.select({
			kind: d1Schema.objectIncarnation.kind,
			objectId: d1Schema.objectIncarnation.objectId,
			incarnation: d1Schema.objectIncarnation.incarnation
		})
		.from(d1Schema.objectIncarnation)
		.where(
			and(
				eq(d1Schema.objectIncarnation.kind, kind),
				inArray(d1Schema.objectIncarnation.state, ['pending', 'live']),
				lte(d1Schema.objectIncarnation.updatedAt, staleBefore),
				stateRowBehind
			)
		)
		.orderBy(
			asc(d1Schema.objectIncarnation.state),
			asc(d1Schema.objectIncarnation.updatedAt),
			asc(d1Schema.objectIncarnation.objectId)
		)
		.limit(limit)
		.all();

	let recovered = 0;

	for (const row of rows) {
		let object: R2Object | null;

		try {
			object = await blobs.head(objectKey(row));
		} catch {
			await database
				.update(d1Schema.objectIncarnation)
				.set({ updatedAt: isoTimestamp(now) })
				.where(
					and(
						eq(d1Schema.objectIncarnation.kind, row.kind),
						eq(d1Schema.objectIncarnation.objectId, row.objectId),
						eq(d1Schema.objectIncarnation.incarnation, row.incarnation),
						inArray(d1Schema.objectIncarnation.state, ['pending', 'live']),
						lte(d1Schema.objectIncarnation.updatedAt, staleBefore)
					)
				)
				.run();
			logger.warn('object incarnation recovery probe failed', {
				kind: row.kind,
				incarnation: row.incarnation,
				reason: 'r2-head-failed'
			});
			continue;
		}

		if (object === null) {
			recovered += (await didRetireIncarnation(
				database,
				blobs,
				row,
				staleBefore
			))
				? 1
				: 0;
			continue;
		}

		const didRecover =
			row.kind === 'nar'
				? await didRecoverNar(database, row, object, staleBefore)
				: await didRecoverCas(database, row, object, staleBefore);

		if (didRecover) {
			recovered += 1;
			continue;
		}

		// The server cannot reconstruct the missing row without this metadata, so
		// the object cannot be published safely.
		recovered += (await didRetireIncarnation(database, blobs, row, staleBefore))
			? 1
			: 0;
	}

	return recovered;
}
