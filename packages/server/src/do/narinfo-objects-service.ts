import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type NarInfoGeneration,
	type NixSha256HashString,
	referencesSchema,
	type SigningKeyGeneration,
	signingKeyGenerationSchema,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { and, eq, inArray } from 'drizzle-orm';

import {
	isMetadataOfCommit,
	isNarInfoObjectVersion,
	type NarInfoObjectMetadata,
	narInfoObjectMetadata,
	type NarInfoObjectVersion,
	type NarInfoReferenceVersion,
	recordedNarInfoMetadata
} from '../blob/narinfo-object-metadata.ts';
import { cacheIdentityCondition, type ResolvedCache } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	StoredReferencesInvalidError,
	StoredSignaturesInvalidError
} from '../errors.ts';
import {
	legacyNarInfoObjectKey,
	narInfoCacheControl,
	narInfoObjectKey,
	narObjectKey
} from '../http/http.ts';
import { parseStored } from '../http/parse.ts';
import { readR2CompatibilityState } from '../migration/r2-compatibility.ts';

import {
	batchNonEmpty,
	chunk,
	deleteObjects,
	maxInClauseValues,
	maxOutgoingConnections,
	presentNarObjects,
	recordedNarObjects
} from './bulk.ts';
import { type ServerContext } from './context.ts';
import { storedSignaturesSchema } from './signing-keys.ts';

type NarInfoRow = typeof schema.narInfos.$inferSelect;

function effectiveSignatureGeneration(row: NarInfoRow): SigningKeyGeneration {
	return row.pendingSignatureGeneration ?? row.signatureGeneration;
}

interface CommittedReferenceEdge {
	readonly storePathHash: StorePathHash;
	readonly generation: NarInfoGeneration;
	readonly narHash: NixSha256HashString;
}

type NarInfoBlobFields = Pick<
	typeof d1Schema.blobState.$inferSelect,
	'fileHash' | 'fileSize' | 'compression' | 'incarnation'
>;

function referenceKey(
	storePathHash: StorePathHash,
	generation: NarInfoGeneration,
	narHash: NixSha256HashString
): string {
	return `${storePathHash} ${String(generation)} ${narHash}`;
}

export class NarInfoObjectsService {
	private readonly publishes = new Map<string, Promise<void>>();

	constructor(private readonly context: ServerContext) {}

	// A failed publish must not break the per-path sequence. Its caller receives
	// the failure, but the next publish still waits until the failed attempt has
	// finished before writing the same object.
	private async chainedPublish(
		previous: Promise<void> | undefined,
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		narHash: NixSha256HashString,
		narInfo: NarInfo
	): Promise<void> {
		if (previous !== undefined) {
			try {
				await previous;
			} catch {
				// Continue the sequence; the earlier caller receives this failure.
			}
		}

		const version = await this.putCurrentNarInfoObject(
			cache,
			storePathHash,
			generation,
			narHash,
			narInfo
		);
		await this.context.criticalSection(() =>
			this.confirmPublishedObjectLocked(cache, storePathHash, version)
		);
	}

	private async putCurrentNarInfoObject(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		narHash: NixSha256HashString,
		narInfo: NarInfo
	): Promise<NarInfoObjectVersion> {
		const row = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();
		const isRowMatch =
			row?.generation === generation && row.narHash === narHash;
		const currentSignatures = isRowMatch
			? storedSignaturesSchema.parse(JSON.parse(row.sigsJson) as unknown)
			: undefined;
		const suppliedSignatures = narInfo.toFields().sigs;
		const shouldRenderCurrent =
			isRowMatch &&
			JSON.stringify(currentSignatures) !== JSON.stringify(suppliedSignatures);
		const currentNarInfo = shouldRenderCurrent
			? await this.narInfoFromRow(row)
			: undefined;
		const publishedNarInfo = currentNarInfo ?? narInfo;
		const version: NarInfoObjectVersion = {
			generation,
			narHash,
			narUrl: publishedNarInfo.url,
			signatureGeneration: isRowMatch
				? effectiveSignatureGeneration(row)
				: signingKeyGenerationSchema.parse(0)
		};

		await this.putNarInfoObject(
			cache,
			storePathHash,
			version,
			publishedNarInfo
		);

		return version;
	}

	// The R2 put runs outside the critical section. Re-read the row under the
	// critical section so a put that finishes after a delete or recommit cannot
	// restore stale metadata. Remove the object if the row was deleted, or render
	// the version that superseded the late publish.
	private async confirmPublishedObjectLocked(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		version: NarInfoObjectVersion
	): Promise<void> {
		const row = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();

		const blob =
			row === undefined
				? undefined
				: await this.context.d1
						.select({ incarnation: d1Schema.blobState.incarnation })
						.from(d1Schema.blobState)
						.where(eq(d1Schema.blobState.narHash, row.narHash))
						.get();

		if (
			blob !== undefined &&
			row?.generation === version.generation &&
			row.narHash === version.narHash &&
			version.narUrl === narObjectKey(row.narHash, blob.incarnation) &&
			effectiveSignatureGeneration(row) === version.signatureGeneration
		) {
			return;
		}

		if (
			row === undefined ||
			this.context.offboarding ||
			!(await this.hasCommittedReference(cache, row))
		) {
			await this.deleteNarInfoObject(cache, storePathHash);

			return;
		}

		const narInfo = await this.narInfoFromRow(row);

		// Demotion owns the object after the shared blob state disappears.
		if (narInfo === undefined) {
			return;
		}

		await this.putNarInfoObject(
			cache,
			storePathHash,
			{
				generation: row.generation,
				narHash: row.narHash,
				narUrl: narInfo.url,
				signatureGeneration: effectiveSignatureGeneration(row)
			},
			narInfo
		);
	}

	// The caller must hold the critical section. Reading the row and restoring its
	// object under the same section prevents a concurrent delete from being undone
	// with stale row data.
	private async materialiseIfRecoverable(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		committedEdges?: readonly CommittedReferenceEdge[]
	): Promise<void> {
		// Offboarding must not recreate an object while the drain is deleting it.
		if (this.context.offboarding) {
			return;
		}

		const row = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();

		if (
			row === undefined ||
			!(await this.rowStillCommitted(cache, row, committedEdges))
		) {
			await this.deleteNarInfoObject(cache, storePathHash);
			return;
		}

		const narInfo = await this.narInfoFromRow(row);

		// Demotion owns the object after the shared blob state disappears.
		if (narInfo === undefined) {
			return;
		}

		const existing = await this.context.env.BLOBS.head(
			narInfoObjectKey(
				this.context.requireTenant(),
				storePathHash,
				cache.scope,
				cache.generation
			)
		);

		if (
			isNarInfoObjectVersion(existing, {
				generation: row.generation,
				narHash: row.narHash,
				narUrl: narInfo.url,
				signatureGeneration: effectiveSignatureGeneration(row)
			})
		) {
			return;
		}

		await this.putNarInfoObject(
			cache,
			storePathHash,
			{
				generation: row.generation,
				narHash: row.narHash,
				narUrl: narInfo.url,
				signatureGeneration: effectiveSignatureGeneration(row)
			},
			narInfo
		);
	}

	// A missing edge in the supplied snapshot is not conclusive because a commit
	// can replace the row and edge after that snapshot. Confirm a miss with D1
	// before treating the current row as uncommitted.
	private async rowStillCommitted(
		cache: ResolvedCache,
		row: NarInfoRow,
		committedEdges: readonly CommittedReferenceEdge[] | undefined
	): Promise<boolean> {
		if (committedEdges === undefined) {
			return this.hasCommittedReference(cache, row);
		}

		if (
			this.committedReferencesFrom(committedEdges, [row]).has(row.storePathHash)
		) {
			return true;
		}

		return this.hasCommittedReference(cache, row);
	}

	// The row check, NAR absence check, and object delete must share the caller's
	// critical section. Otherwise a commit could restore the NAR and narinfo object
	// before this method deletes the newly restored object.
	private async demoteUnbackedLocked(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		narHash: NixSha256HashString
	): Promise<void> {
		const row = this.context.db
			.select({ narHash: schema.narInfos.narHash })
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();

		if (row?.narHash !== narHash) {
			return;
		}

		const state = await this.context.d1
			.select({ incarnation: d1Schema.blobState.incarnation })
			.from(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, narHash))
			.get();
		const isBlobPresent =
			state !== undefined &&
			(await this.context.env.BLOBS.head(
				narObjectKey(narHash, state.incarnation)
			)) !== null;

		if (isBlobPresent) {
			return;
		}

		await this.deleteNarInfoObject(cache, storePathHash);
	}

	private async repairNarInfoObjects(
		cache: ResolvedCache,
		rows: readonly NarInfoRow[]
	): Promise<void> {
		await mapWithConcurrency(rows, maxOutgoingConnections, async (row) => {
			const narInfo = await this.narInfoFromRow(row);

			if (narInfo === undefined) {
				return;
			}

			await this.publishNarInfoObject(
				cache,
				row.storePathHash,
				row.generation,
				row.narHash,
				narInfo
			);
		});
	}

	// Publishes one claimed verification through the ordinary ordered publication
	// path. The post-publication fence repairs a late write against the current
	// narinfo row. The caller completes the upload only while it owns the claim.
	async publishNarInfoObjectWhile(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		narHash: NixSha256HashString,
		narInfo: NarInfo,
		isStillOwned: () => boolean
	): Promise<boolean> {
		if (!isStillOwned()) {
			return false;
		}

		await this.publishNarInfoObject(
			cache,
			storePathHash,
			generation,
			narHash,
			narInfo
		);

		return isStillOwned();
	}

	async isCurrentPublishedVersion(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		narHash: NixSha256HashString
	): Promise<boolean> {
		const row = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, storePathHash),
					eq(schema.narInfos.generation, generation),
					eq(schema.narInfos.narHash, narHash)
				)
			)
			.get();

		if (row === undefined) {
			return false;
		}

		const object = await this.context.env.BLOBS.head(
			narInfoObjectKey(
				this.context.requireTenant(),
				storePathHash,
				cache.scope,
				cache.generation
			)
		);

		const narInfo = await this.narInfoFromRow(row);

		return (
			narInfo !== undefined &&
			isNarInfoObjectVersion(object, {
				generation: row.generation,
				narHash: row.narHash,
				narUrl: narInfo.url,
				signatureGeneration: effectiveSignatureGeneration(row)
			})
		);
	}

	// Serialise publications for each store path. After an R2 put, a short gate
	// compares the published generation, NAR hash, and object version with the
	// current D1 row. Recovery deletes or re-renders an object that lost this race.
	async publishNarInfoObject(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		narHash: NixSha256HashString,
		narInfo: NarInfo
	): Promise<void> {
		const key = `${String(cache.id)} ${storePathHash}`;
		const publish = this.chainedPublish(
			this.publishes.get(key),
			cache,
			storePathHash,
			generation,
			narHash,
			narInfo
		);
		this.publishes.set(key, publish);

		try {
			await publish;
		} finally {
			if (this.publishes.get(key) === publish) {
				this.publishes.delete(key);
			}
		}
	}

	// Returns undefined after the shared blob state is removed. Callers must leave
	// the path non-servable because the tenant row does not contain the compressed
	// metadata needed to render the narinfo.
	async narInfoFromRow(
		row: typeof schema.narInfos.$inferSelect
	): Promise<NarInfo | undefined> {
		const blob = await this.context.d1
			.select({
				fileHash: d1Schema.blobState.fileHash,
				fileSize: d1Schema.blobState.fileSize,
				compression: d1Schema.blobState.compression,
				incarnation: d1Schema.blobState.incarnation
			})
			.from(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, row.narHash))
			.get();

		if (blob === undefined) {
			return undefined;
		}

		return this.buildNarInfo(row, blob);
	}

	buildNarInfo(
		row: typeof schema.narInfos.$inferSelect,
		blob: NarInfoBlobFields
	): NarInfo {
		return new NarInfo(
			new StorePath(row.storePath),
			narObjectKey(row.narHash, blob.incarnation),
			blob.compression,
			NixSha256Hash.parse(blob.fileHash),
			blob.fileSize,
			NixSha256Hash.parse(row.narHash),
			row.narSize,
			parseStored(
				referencesSchema,
				row.referencesJson,
				(cause) => new StoredReferencesInvalidError(row.storePathHash, cause)
			),
			row.deriver ?? undefined,
			row.ca ?? undefined,
			parseStored(
				storedSignaturesSchema,
				row.sigsJson,
				(cause) => new StoredSignaturesInvalidError(row.storePathHash, cause)
			)
		);
	}

	// Opens a critical section; callers must not already hold one.
	async ensureNarInfoObject(
		cache: ResolvedCache,
		storePathHash: StorePathHash
	): Promise<void> {
		await this.context.criticalSection(() =>
			this.materialiseIfRecoverable(cache, storePathHash)
		);
	}

	// A missing narinfo object is still servable when its current row, exact D1
	// edge, and canonical NAR remain present. Repair that object before checking
	// availability. Pending, demoted, and unknown paths remain unavailable.
	// Opens a critical section; callers must not already hold one.
	async isServable(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		committedEdges?: readonly CommittedReferenceEdge[]
	): Promise<boolean> {
		return this.context.criticalSection(() =>
			this.isServableLocked(cache, storePathHash, committedEdges)
		);
	}

	// The caller must hold the critical section so the availability check and its
	// dependent action cannot be separated by a deletion.
	async isServableLocked(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		committedEdges?: readonly CommittedReferenceEdge[]
	): Promise<boolean> {
		await this.materialiseIfRecoverable(cache, storePathHash, committedEdges);

		const object = await this.context.env.BLOBS.head(
			narInfoObjectKey(
				this.context.requireTenant(),
				storePathHash,
				cache.scope,
				cache.generation
			)
		);

		return object !== null;
	}

	async hasCommittedReference(
		cache: ResolvedCache,
		row: typeof schema.narInfos.$inferSelect
	): Promise<boolean> {
		const tenant = this.context.requireTenant();
		const reference = await this.context.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, tenant),
					cacheIdentityCondition(
						d1Schema.blobReference.cacheKind,
						d1Schema.blobReference.cacheName,
						cache.scope
					),
					eq(d1Schema.blobReference.storePathHash, row.storePathHash),
					eq(d1Schema.blobReference.generation, row.generation),
					eq(d1Schema.blobReference.narHash, row.narHash)
				)
			)
			.get();

		return reference !== undefined;
	}

	// Returns only rows with a D1 edge for the same path, generation, and NAR hash.
	// Reads the edges in bounded batches to keep large negotiations within D1's
	// parameter limit.
	async committedReferences(
		cache: ResolvedCache,
		rows: readonly NarInfoRow[]
	): Promise<Set<StorePathHash>> {
		if (rows.length === 0) {
			return new Set();
		}

		const edges = await this.committedReferenceEdges(
			cache,
			rows.map((row) => row.storePathHash)
		);

		return this.committedReferencesFrom(edges, rows);
	}

	// Reads D1 reference edges in chunks that stay below the bound-parameter limit.
	async committedReferenceEdges(
		cache: ResolvedCache,
		storePathHashes: readonly StorePathHash[]
	): Promise<CommittedReferenceEdge[]> {
		if (storePathHashes.length === 0) {
			return [];
		}

		const tenant = this.context.requireTenant();

		const queries = chunk(storePathHashes, maxInClauseValues).map(
			(storePathHashBatch) =>
				this.context.d1
					.select({
						storePathHash: d1Schema.blobReference.storePathHash,
						generation: d1Schema.blobReference.generation,
						narHash: d1Schema.blobReference.narHash
					})
					.from(d1Schema.blobReference)
					.where(
						and(
							eq(d1Schema.blobReference.tenant, tenant),
							cacheIdentityCondition(
								d1Schema.blobReference.cacheKind,
								d1Schema.blobReference.cacheName,
								cache.scope
							),
							inArray(d1Schema.blobReference.storePathHash, storePathHashBatch)
						)
					)
		);

		const results = await batchNonEmpty(this.context.d1, queries);
		return results.flat();
	}

	narInfoRowsFor(
		cache: ResolvedCache,
		storePathHashes: readonly StorePathHash[]
	): NarInfoRow[] {
		if (storePathHashes.length === 0) {
			return [];
		}

		return chunk(storePathHashes, maxInClauseValues).flatMap(
			(storePathHashBatch) =>
				this.context.db
					.select()
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, cache.id),
							inArray(schema.narInfos.storePathHash, storePathHashBatch)
						)
					)
					.all()
		);
	}

	// An older edge must not authorise a row created by a later recommit of the
	// same path. Match the path, generation, and NAR hash as one identity.
	committedReferencesFrom(
		edges: readonly CommittedReferenceEdge[],
		rows: readonly NarInfoRow[]
	): Set<StorePathHash> {
		const committed = new Set<StorePathHash>();
		const referenceKeys = new Set(
			edges.map((edge) =>
				referenceKey(edge.storePathHash, edge.generation, edge.narHash)
			)
		);

		for (const row of rows) {
			if (
				referenceKeys.has(
					referenceKey(row.storePathHash, row.generation, row.narHash)
				)
			) {
				committed.add(row.storePathHash);
			}
		}

		return committed;
	}

	// Probe R2 before reading the row snapshot. If a recommit occurs during the
	// probes, the later row cannot match the older object and takes the repair path.
	async existingNarInfoObjects(
		cache: ResolvedCache,
		storePathHashes: readonly StorePathHash[]
	): Promise<ReadonlyMap<StorePathHash, NarInfoObjectMetadata>> {
		const tenant = this.context.requireTenant();
		const present = await mapWithConcurrency(
			[...new Set(storePathHashes)],
			maxOutgoingConnections,
			async (storePathHash) => {
				const object = await this.context.env.BLOBS.head(
					narInfoObjectKey(tenant, storePathHash, cache.scope, cache.generation)
				);
				const metadata = recordedNarInfoMetadata(object);

				return metadata === undefined
					? undefined
					: ([storePathHash, metadata] as const);
			}
		);

		return new Map(
			present.filter(
				(entry): entry is readonly [StorePathHash, NarInfoObjectMetadata] =>
					entry !== undefined
			)
		);
	}

	// A version is servable only when its live row, exact D1 edge, canonical NAR,
	// and generation-matched narinfo object are all present. The R2 probes precede
	// the row snapshot so a concurrent recommit takes the repair path. Callers that
	// complete work from this result must revalidate the returned generation.
	async servableNarInfoVersions(
		cache: ResolvedCache,
		storePathHashes: readonly StorePathHash[]
	): Promise<ReadonlyMap<StorePathHash, NarInfoReferenceVersion>> {
		const hashes = [...new Set(storePathHashes)];
		const present = await this.existingNarInfoObjects(cache, hashes);
		const rows = this.narInfoRowsFor(cache, hashes);
		const committedEdges = await this.committedReferenceEdges(cache, hashes);
		const committed = this.committedReferencesFrom(committedEdges, rows);
		const committedRows = rows.filter((row) =>
			committed.has(row.storePathHash)
		);
		const objects = await recordedNarObjects(
			this.context.d1,
			committedRows.map((row) => row.narHash)
		);
		const backed = await presentNarObjects(this.context.env.BLOBS, objects);
		const servable = new Map<StorePathHash, NarInfoReferenceVersion>();
		const hasCurrentObject = (row: NarInfoRow): boolean =>
			isMetadataOfCommit(present.get(row.storePathHash), row);

		for (const row of committedRows) {
			if (hasCurrentObject(row) && backed.has(row.narHash)) {
				servable.set(row.storePathHash, {
					generation: row.generation,
					narHash: row.narHash
				});
			}
		}

		const recoverable = committedRows.filter(
			(row) => !hasCurrentObject(row) && backed.has(row.narHash)
		);

		await this.repairNarInfoObjects(cache, recoverable);
		const repaired = await this.existingNarInfoObjects(
			cache,
			recoverable.map((row) => row.storePathHash)
		);

		for (const row of recoverable) {
			const metadata = repaired.get(row.storePathHash);
			if (
				metadata?.generation === String(row.generation) &&
				metadata.narHash === row.narHash
			) {
				servable.set(row.storePathHash, {
					generation: row.generation,
					narHash: row.narHash
				});
			}
		}

		return servable;
	}

	async servableStorePathHashes(
		cache: ResolvedCache,
		storePathHashes: readonly StorePathHash[]
	): Promise<ReadonlySet<StorePathHash>> {
		const versions = await this.servableNarInfoVersions(cache, storePathHashes);

		return new Set(versions.keys());
	}

	async committedNarInfoRow(
		cache: ResolvedCache,
		storePathHash: StorePathHash
	): Promise<typeof schema.narInfos.$inferSelect | undefined> {
		const row = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();

		if (row === undefined) {
			return undefined;
		}

		if (!(await this.hasCommittedReference(cache, row))) {
			return undefined;
		}

		// The D1 edge identifies this exact generation and NAR hash. Re-read the
		// local row after the D1 await so a concurrent recommit cannot return a row
		// that no longer matches the edge.
		const current = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();

		if (
			current?.generation !== row.generation ||
			current.narHash !== row.narHash
		) {
			return undefined;
		}

		return current;
	}

	// The global reaper owns canonical NAR removal, but this service is the only
	// writer for tenant narinfo objects. Delete the tenant narinfo object only while
	// its live row still refers to the reaped hash and the canonical NAR is absent.
	// These checks protect a concurrent recommit or re-upload and make retries
	// idempotent. Opens a critical section; callers must not already hold one.
	async demoteUnbacked(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		narHash: NixSha256HashString
	): Promise<void> {
		await this.context.criticalSection(() =>
			this.demoteUnbackedLocked(cache, storePathHash, narHash)
		);
	}

	async putNarInfoObject(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		version: NarInfoObjectVersion,
		narInfo: NarInfo
	): Promise<void> {
		const key = narInfoObjectKey(
			this.context.requireTenant(),
			storePathHash,
			cache.scope,
			cache.generation
		);
		const legacyKey = legacyNarInfoObjectKey(
			this.context.requireTenant(),
			storePathHash,
			cache.scope
		);
		const body = narInfo.render();
		const options = {
			customMetadata: narInfoObjectMetadata(version),
			httpMetadata: {
				contentType: 'text/x-nix-narinfo; charset=utf-8',
				cacheControl: narInfoCacheControl
			}
		};
		const compatibility = await readR2CompatibilityState(this.context.d1);
		const keys = compatibility.writeLegacyObjects ? [key, legacyKey] : [key];

		await this.context.objectWrites.write(keys, async () => {
			await this.context.env.BLOBS.put(key, body, options);

			if (compatibility.writeLegacyObjects) {
				await this.context.env.BLOBS.put(legacyKey, body, options);
			}
		});
	}

	// Narinfo objects are path-keyed. Order every delete behind abandoned
	// mutations for the same key so a late delete cannot remove an object written
	// by a later commit.
	async deleteNarInfoObject(
		cache: ResolvedCache,
		storePathHash: StorePathHash
	): Promise<void> {
		const key = narInfoObjectKey(
			this.context.requireTenant(),
			storePathHash,
			cache.scope,
			cache.generation
		);

		await this.context.objectWrites.write([key], () =>
			this.context.env.BLOBS.delete(key)
		);
	}

	async deleteNarInfoObjects(
		cache: ResolvedCache,
		storePathHashes: readonly StorePathHash[]
	): Promise<void> {
		if (storePathHashes.length === 0) {
			return;
		}

		const tenant = this.context.requireTenant();
		const keys = storePathHashes.map((storePathHash) =>
			narInfoObjectKey(tenant, storePathHash, cache.scope, cache.generation)
		);

		await this.context.objectWrites.write(keys, () =>
			deleteObjects(this.context.env.BLOBS, keys)
		);
	}
}
