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

import {
	type ServerContext,
	singleTenant,
	storedSignaturesSchema
} from './context.ts';

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
		// Runs in a critical section, and against a freshly read row, so it cannot
		// race a delete: a concurrent delete that removed the row after the caller
		// read it must not be undone by re-materialising the object from a stale
		// copy.
		await this.context.ctx.blockConcurrencyWhile(async () => {
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
				return;
			}

			if (!(await this.hasCommittedReference(cache, row))) {
				await this.context.env.BLOBS.delete(
					narInfoObjectKey(storePathHash, cache)
				);
				return;
			}

			const existing = await this.context.env.BLOBS.head(
				narInfoObjectKey(storePathHash, cache)
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
		});
	}

	async hasCommittedReference(
		cache: string,
		row: typeof schema.narInfos.$inferSelect
	): Promise<boolean> {
		const reference = await this.context.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, singleTenant),
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
			narInfoObjectKey(storePathHash, cache),
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
