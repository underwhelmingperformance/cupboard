import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type NixSha256HashString,
	referencesSchema,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { and, eq, inArray } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	StoredReferencesInvalidError,
	StoredSignaturesInvalidError
} from '../errors.ts';
import {
	narInfoCacheControl,
	narInfoObjectKey,
	narObjectKey
} from '../http/http.ts';
import { parseStored } from '../http/parse.ts';

import {
	batchNonEmpty,
	chunk,
	deleteObjects,
	maxInClauseValues,
	maxOutgoingConnections
} from './bulk.ts';
import { type ServerContext } from './context.ts';
import { storedSignaturesSchema } from './signing-keys.ts';

type NarInfoRow = typeof schema.narInfos.$inferSelect;

// A committed reference edge as read from D1: the path, the generation the row
// must still name, and the NAR hash it points at.
interface CommittedReferenceEdge {
	readonly storePathHash: StorePathHash;
	readonly generation: number;
	readonly narHash: NixSha256HashString;
}

// The canonical compressed metadata a narinfo advertises, the subset of
// `blob_state` {@link NarInfoObjectsService.buildNarInfo} needs.
type NarInfoBlobFields = Pick<
	typeof d1Schema.blobState.$inferSelect,
	'fileHash' | 'fileSize' | 'compression'
>;

// Identifies a committed reference edge by the three columns negotiate matches a
// narinfo row against: the path, its generation, and the hash it points at.
function referenceKey(
	storePathHash: StorePathHash,
	generation: number,
	narHash: NixSha256HashString
): string {
	return `${storePathHash} ${String(generation)} ${narHash}`;
}

export class NarInfoObjectsService {
	// The in-flight publish per (cache, path); see {@link publishNarInfoObject}.
	private readonly publishes = new Map<string, Promise<void>>();

	constructor(private readonly context: ServerContext) {}

	// The link a publish adds to its path's chain: settle behind the previous
	// publish (however it settled; its own caller heard any failure), then put
	// the object and fence it.
	private async chainedPublish(
		previous: Promise<void> | undefined,
		cache: string,
		storePathHash: StorePathHash,
		generation: number,
		narHash: NixSha256HashString,
		narInfo: NarInfo
	): Promise<void> {
		if (previous !== undefined) {
			try {
				await previous;
			} catch {
				// The earlier publish's caller heard its failure; this link only
				// needs it settled so the puts stay ordered.
			}
		}

		await this.putNarInfoObject(cache, storePathHash, narInfo);
		await this.context.criticalSection(() =>
			this.confirmPublishedObjectLocked(
				cache,
				storePathHash,
				generation,
				narHash
			)
		);
	}

	// The post-publish fence: the object landed outside any gate, so re-read the
	// row under one. A row still naming the published version means nothing
	// moved and the publish stands, at no gate cost beyond the synchronous read.
	// Anything else means a delete or recommit gated between the charge and the
	// object landing, so the object is rewritten from the row as this gate sees
	// it: deleted with the row, or re-rendered to the version that superseded
	// the published one.
	private async confirmPublishedObjectLocked(
		cache: string,
		storePathHash: StorePathHash,
		generation: number,
		narHash: NixSha256HashString
	): Promise<void> {
		const row = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();

		if (row?.generation === generation && row.narHash === narHash) {
			return;
		}

		if (
			this.context.offboarding ||
			row === undefined ||
			!(await this.hasCommittedReference(cache, row))
		) {
			await this.deleteNarInfoObject(cache, storePathHash);

			return;
		}

		const narInfo = await this.narInfoFromRow(row);

		// No shared fact means the blob was demoted; the demote path owns the
		// object from here.
		if (narInfo === undefined) {
			return;
		}

		await this.putNarInfoObject(cache, storePathHash, narInfo);
	}

	// Re-materialises a lost narinfo object when the row, the matching reference
	// edge, and the shared blob are still present. The caller must already hold the
	// DO critical section: running against a freshly read row inside one is what
	// stops a concurrent delete from being undone by re-materialising from a stale
	// copy.
	private async materialiseIfRecoverable(
		cache: string,
		storePathHash: StorePathHash,
		committedEdges?: readonly CommittedReferenceEdge[]
	): Promise<void> {
		// A tenant being offboarded must not have its objects re-materialised, or the
		// drain would chase an object this path recreated behind it.
		if (this.context.offboarding) {
			return;
		}

		const row = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
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

		const existing = await this.context.env.BLOBS.head(
			narInfoObjectKey(this.context.requireTenant(), storePathHash, cache)
		);

		if (existing !== null) {
			return;
		}

		const narInfo = await this.narInfoFromRow(row);

		// No shared fact means the blob was demoted; leave the path non-servable
		// until a re-upload re-promotes it.
		if (narInfo === undefined) {
			return;
		}

		await this.putNarInfoObject(cache, storePathHash, narInfo);
	}

	// Whether the row's exact version is still committed. Given a batch of edges
	// already read from D1 it first checks the snapshot in memory; if the
	// snapshot does not match, a fresh single-row D1 read confirms before
	// returning false, so a generation the snapshot predates does not cause a
	// false negative. Without a snapshot it goes directly to the D1 read.
	private async rowStillCommitted(
		cache: string,
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

		// The snapshot may predate a commit that advanced this row's generation.
		// Confirm with a fresh D1 read before treating the absence as uncommitted.
		return this.hasCommittedReference(cache, row);
	}

	// {@link demoteUnbacked}'s body, run inside the critical section so the
	// object-absence check and the delete cannot interleave with a concurrent commit
	// materialising the path between them, which would otherwise let the demote delete
	// a freshly re-materialised object.
	private async demoteUnbackedLocked(
		cache: string,
		storePathHash: StorePathHash,
		narHash: NixSha256HashString
	): Promise<void> {
		const row = this.context.db
			.select({ narHash: schema.narInfos.narHash })
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();

		if (row?.narHash !== narHash) {
			return;
		}

		const blob = await this.context.env.BLOBS.head(narObjectKey(narHash));

		if (blob !== null) {
			return;
		}

		await this.deleteNarInfoObject(cache, storePathHash);
	}

	// Publishes a freshly materialised narinfo's object, keeping the R2 put out
	// of the caller's critical section. Two guards keep a put that lands late
	// from outliving what a gated delete or recommit decided meanwhile: the
	// publishes for one path run in order behind each other, and each one
	// re-reads the row under a short gate after its put. A row still naming the
	// published version is the common case and costs the gate nothing beyond
	// synchronous SQLite; anything else hands the path to the recovery that
	// deletes or re-renders the object against the row as the gate sees it.
	async publishNarInfoObject(
		cache: string,
		storePathHash: StorePathHash,
		generation: number,
		narHash: NixSha256HashString,
		narInfo: NarInfo
	): Promise<void> {
		const key = `${cache} ${storePathHash}`;
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

	// Renders a narinfo by joining the tenant row (identity, uncompressed NarHash/
	// NarSize, references, signature) with the canonical compressed metadata in
	// `blob_state` (the narinfo row holds no compressed fields of its own). Returns
	// undefined when the shared fact is gone (a demoted blob), so the caller leaves
	// the path non-servable until a re-upload heals it.
	async narInfoFromRow(
		row: typeof schema.narInfos.$inferSelect
	): Promise<NarInfo | undefined> {
		const blob = await this.context.d1
			.select({
				fileHash: d1Schema.blobState.fileHash,
				fileSize: d1Schema.blobState.fileSize,
				compression: d1Schema.blobState.compression
			})
			.from(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, row.narHash))
			.get();

		if (blob === undefined) {
			return undefined;
		}

		return this.buildNarInfo(row, blob);
	}

	// Renders a narinfo from a row and the canonical compressed metadata the caller
	// has already read, so a caller holding the `blob_state` row does not read it
	// again. {@link narInfoFromRow} is the form that fetches the metadata itself.
	buildNarInfo(
		row: typeof schema.narInfos.$inferSelect,
		blob: NarInfoBlobFields
	): NarInfo {
		return new NarInfo(
			new StorePath(row.storePath),
			narObjectKey(row.narHash),
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

	// Opens its own critical section; callers must be outside one.
	async ensureNarInfoObject(
		cache: string,
		storePathHash: StorePathHash
	): Promise<void> {
		await this.context.criticalSection(() =>
			this.materialiseIfRecoverable(cache, storePathHash)
		);
	}

	// The availability predicate the read path serves on: a materialised tenant
	// narinfo R2 object exists. A recoverable gap is repaired first, so a path whose
	// object was lost but whose shared fact is still `available` counts as available
	// once re-materialised; a pending, demoted, or unknown path stays unavailable.
	// Serving, root activation, and root summaries share this so they cannot drift.
	// Opens its own critical section; callers must be outside one.
	async isServable(
		cache: string,
		storePathHash: StorePathHash,
		committedEdges?: readonly CommittedReferenceEdge[]
	): Promise<boolean> {
		return this.context.criticalSection(() =>
			this.isServableLocked(cache, storePathHash, committedEdges)
		);
	}

	// {@link isServable} for a caller that already holds the DO critical section, so
	// it can check the predicate and act on it (e.g. activate a root) atomically,
	// without a delete racing across an `await`.
	async isServableLocked(
		cache: string,
		storePathHash: StorePathHash,
		committedEdges?: readonly CommittedReferenceEdge[]
	): Promise<boolean> {
		await this.materialiseIfRecoverable(cache, storePathHash, committedEdges);

		const object = await this.context.env.BLOBS.head(
			narInfoObjectKey(this.context.requireTenant(), storePathHash, cache)
		);

		return object !== null;
	}

	async hasCommittedReference(
		cache: string,
		row: typeof schema.narInfos.$inferSelect
	): Promise<boolean> {
		const tenant = this.context.requireTenant();
		const reference = await this.context.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, tenant),
					eq(d1Schema.blobReference.cache, cache),
					eq(d1Schema.blobReference.storePathHash, row.storePathHash),
					eq(d1Schema.blobReference.generation, row.generation),
					eq(d1Schema.blobReference.narHash, row.narHash)
				)
			)
			.get();

		return reference !== undefined;
	}

	// The store-path hashes among `rows` whose committed reference edge still names
	// the row's exact version, the batched form of {@link hasCommittedReference}.
	// One D1 read per chunk replaces a read per path, so a large negotiate settles
	// its committed-ness in a handful of queries.
	async committedReferences(
		cache: string,
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

	// The committed reference edges D1 holds for `storePathHashes`, read in a
	// single chunked batch that stays under D1's bound-parameter cap. {@link
	// committedReferences} pairs these with live rows; a caller that heals per
	// path can also thread them into {@link isServable} so the gated re-check
	// settles in memory.
	async committedReferenceEdges(
		cache: string,
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
							eq(d1Schema.blobReference.cache, cache),
							inArray(d1Schema.blobReference.storePathHash, storePathHashBatch)
						)
					)
		);

		const results = await batchNonEmpty(this.context.d1, queries);
		return results.flat();
	}

	// The committed narinfo rows for `storePathHashes`, read from the DO's own
	// SQLite in chunks that stay under the bound-parameter cap. A caller pairs
	// these live rows with {@link committedReferenceEdges} to decide committedness.
	narInfoRowsFor(
		cache: string,
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
							eq(schema.narInfos.cache, cache),
							inArray(schema.narInfos.storePathHash, storePathHashBatch)
						)
					)
					.all()
		);
	}

	// The pure comparison half of {@link committedReferences}: which of `rows`
	// the given edges name at their exact version. The rows are the Durable
	// Object's own live SQLite state, so an edge read before a recommit bumped
	// a generation simply fails to match, failing towards "not committed".
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

	// The store-path hashes among `storePathHashes` whose tenant narinfo object is
	// already materialised in R2, gathered with a bounded fan-out of `head` reads.
	// A skip whose object is present needs no self-heal; only the absent ones do.
	async existingNarInfoObjects(
		cache: string,
		storePathHashes: readonly StorePathHash[]
	): Promise<Set<StorePathHash>> {
		const tenant = this.context.requireTenant();
		const present = await mapWithConcurrency(
			[...new Set(storePathHashes)],
			maxOutgoingConnections,
			async (storePathHash) =>
				(await this.context.env.BLOBS.head(
					narInfoObjectKey(tenant, storePathHash, cache)
				)) === null
					? undefined
					: storePathHash
		);

		return new Set(
			present.filter(
				(storePathHash): storePathHash is StorePathHash =>
					storePathHash !== undefined
			)
		);
	}

	async committedNarInfoRow(
		cache: string,
		storePathHash: StorePathHash
	): Promise<typeof schema.narInfos.$inferSelect | undefined> {
		const row = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();

		if (row === undefined) {
			return undefined;
		}

		return (await this.hasCommittedReference(cache, row)) ? row : undefined;
	}

	// De-materialises this tenant's narinfo object for a hash the global reaper found
	// has lost its shared object, so the read path stops serving a narinfo that points
	// at a NAR that is gone. It is gated on the live row still naming that hash (a
	// recommit at a different hash is left alone) and on the object still being absent
	// (a concurrent re-promote brought it back, so the path is healthy and kept), which
	// makes it idempotent and collateral-free: the reaper routes it through here, the
	// single writer of the tenant's objects, and re-drives it until the `blob_state`
	// row is gone, so a partial run converges.
	// Opens its own critical section; callers must be outside one.
	async demoteUnbacked(
		cache: string,
		storePathHash: StorePathHash,
		narHash: NixSha256HashString
	): Promise<void> {
		await this.context.criticalSection(() =>
			this.demoteUnbackedLocked(cache, storePathHash, narHash)
		);
	}

	async putNarInfoObject(
		cache: string,
		storePathHash: StorePathHash,
		narInfo: NarInfo
	): Promise<void> {
		const key = narInfoObjectKey(
			this.context.requireTenant(),
			storePathHash,
			cache
		);

		await this.context.objectWrites.write([key], () =>
			this.context.env.BLOBS.put(key, narInfo.render(), {
				httpMetadata: {
					contentType: 'text/x-nix-narinfo; charset=utf-8',
					cacheControl: narInfoCacheControl
				}
			})
		);
	}

	// Deletes one path's tenant narinfo object. Every narinfo-object delete
	// routes through here or the bulk form: the objects are path-keyed and not
	// healed on read, so the delete must order behind any abandoned mutation of
	// the same key, or a zombie could destroy an object a later commit wrote.
	async deleteNarInfoObject(
		cache: string,
		storePathHash: StorePathHash
	): Promise<void> {
		const key = narInfoObjectKey(
			this.context.requireTenant(),
			storePathHash,
			cache
		);

		await this.context.objectWrites.write([key], () =>
			this.context.env.BLOBS.delete(key)
		);
	}

	// The bulk form of {@link deleteNarInfoObject}, one ordered R2 delete for a
	// teardown chunk's paths.
	async deleteNarInfoObjects(
		cache: string,
		storePathHashes: readonly StorePathHash[]
	): Promise<void> {
		if (storePathHashes.length === 0) {
			return;
		}

		const tenant = this.context.requireTenant();
		const keys = storePathHashes.map((storePathHash) =>
			narInfoObjectKey(tenant, storePathHash, cache)
		);

		await this.context.objectWrites.write(keys, () =>
			deleteObjects(this.context.env.BLOBS, keys)
		);
	}
}
