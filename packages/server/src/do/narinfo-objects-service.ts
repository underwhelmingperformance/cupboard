import { NarInfo } from '@cupboard/nix/narinfo';
import { referencesSchema } from '@cupboard/nix/scalars';
import { and, eq } from 'drizzle-orm';

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

import { type ServerContext, storedSignaturesSchema } from './context.ts';

export class NarInfoObjectsService {
	constructor(private readonly context: ServerContext) {}

	// Renders a narinfo by joining the tenant row (identity, uncompressed NarHash/
	// NarSize, references, signature) with the canonical compressed metadata in
	// `blob_state` — the narinfo row holds no compressed fields of its own. Returns
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

		return new NarInfo(
			row.storePath,
			narObjectKey(row.narHash),
			blob.compression,
			blob.fileHash,
			blob.fileSize,
			row.narHash,
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
		storePathHash: string
	): Promise<void> {
		await this.context.ctx.blockConcurrencyWhile(() =>
			this.materialiseIfRecoverable(cache, storePathHash)
		);
	}

	// Re-materialises a lost narinfo object when the row, the matching reference
	// edge, and the shared blob are still present. The caller must already hold the
	// DO critical section: running against a freshly read row inside one is what
	// stops a concurrent delete from being undone by re-materialising from a stale
	// copy.
	private async materialiseIfRecoverable(
		cache: string,
		storePathHash: string
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

		if (row === undefined || !(await this.hasCommittedReference(cache, row))) {
			await this.context.env.BLOBS.delete(
				narInfoObjectKey(this.context.requireTenant(), storePathHash, cache)
			);
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
		// until a re-upload re-promotes it rather than render an unbacked object.
		if (narInfo === undefined) {
			return;
		}

		await this.putNarInfoObject(cache, storePathHash, narInfo);
	}

	// The availability predicate the read path serves on: a materialised tenant
	// narinfo R2 object exists. A recoverable gap is repaired first, so a path whose
	// object was lost but whose shared fact is still `available` counts as available
	// once re-materialised; a pending, demoted, or unknown path stays unavailable.
	// Serving, root activation, and root summaries share this so they cannot drift.
	// Opens its own critical section; callers must be outside one.
	async isServable(cache: string, storePathHash: string): Promise<boolean> {
		return this.context.ctx.blockConcurrencyWhile(() =>
			this.isServableLocked(cache, storePathHash)
		);
	}

	// {@link isServable} for a caller that already holds the DO critical section, so
	// it can check the predicate and act on it (e.g. activate a root) atomically
	// with the check rather than racing a delete across an `await`.
	async isServableLocked(
		cache: string,
		storePathHash: string
	): Promise<boolean> {
		await this.materialiseIfRecoverable(cache, storePathHash);

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

	async committedNarInfoRow(
		cache: string,
		storePathHash: string
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

	async putNarInfoObject(
		cache: string,
		storePathHash: string,
		narInfo: NarInfo
	): Promise<void> {
		await this.context.env.BLOBS.put(
			narInfoObjectKey(this.context.requireTenant(), storePathHash, cache),
			narInfo.render(),
			{
				httpMetadata: {
					contentType: 'text/x-nix-narinfo; charset=utf-8',
					cacheControl: narInfoCacheControl
				}
			}
		);
	}
}
