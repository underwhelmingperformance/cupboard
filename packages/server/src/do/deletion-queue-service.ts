import { storePathHashSchema } from '@cupboard/nix/scalars';
import { type DeletePathResponse } from '@cupboard/protocol/upload';
import { and, eq } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfoCachePath, narInfoObjectKey } from '../http/http.ts';
import { parseRequestValue } from '../http/parse.ts';

import { type AuthKeysService } from './auth-keys-service.ts';
import {
	type SchemaWriter,
	type ServerContext,
	singleTenant
} from './context.ts';

export class DeletionQueueService {
	constructor(
		private readonly context: ServerContext,
		private readonly authKeys: AuthKeysService
	) {}

	async handleDeletePath(
		request: Request,
		cache: string,
		hash: string
	): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		const storePathHash = parseRequestValue(storePathHashSchema, hash);
		const result = await this.deleteStorePath(
			cache,
			storePathHash,
			new URL(request.url).origin
		);

		return Response.json(result satisfies DeletePathResponse);
	}

	enqueueNarInfoDeletion(
		handle: SchemaWriter,
		cache: string,
		storePathHash: string,
		narHash: string,
		generation: number,
		now: string
	): void {
		handle
			.insert(schema.narInfoDeletions)
			.values({ cache, storePathHash, narHash, generation, createdAt: now })
			.onConflictDoUpdate({
				target: [
					schema.narInfoDeletions.cache,
					schema.narInfoDeletions.storePathHash,
					schema.narInfoDeletions.generation
				],
				set: { narHash, createdAt: now }
			})
			.run();
	}

	// Retires the D1 reference edge for one captured narinfo version, then drops the
	// tenant's `tenant_blob` presence once it holds no more edges for the hash. The
	// edge delete targets the exact `(tenant, cache, store_path_hash, generation)`,
	// so a newer recommitted edge is never touched.
	private async retireBlobRefEdge(
		cache: string,
		storePathHash: string,
		generation: number,
		narHash: string
	): Promise<void> {
		await this.context.d1
			.delete(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, singleTenant),
					eq(d1Schema.blobReference.cache, cache),
					eq(d1Schema.blobReference.storePathHash, storePathHash),
					eq(d1Schema.blobReference.generation, generation)
				)
			)
			.run();

		const stillReferenced = await this.context.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, singleTenant),
					eq(d1Schema.blobReference.narHash, narHash)
				)
			)
			.get();

		if (stillReferenced === undefined) {
			await this.context.d1
				.delete(d1Schema.tenantBlob)
				.where(
					and(
						eq(d1Schema.tenantBlob.tenant, singleTenant),
						eq(d1Schema.tenantBlob.narHash, narHash)
					)
				)
				.run();
		}
	}

	// Whether no committed narinfo, in any tenant, still references this NAR hash —
	// the "safe to reclaim" probe, on `blob_ref` (its indexed `nar_hash`) rather than
	// any one tenant's narinfos. The reaper does the actual reclamation against
	// `blob_state.delete_after`; a delete only reports this so a client learns its
	// NAR became unreferenced.
	private async blobHashUnreferenced(narHash: string): Promise<boolean> {
		const referenced = await this.context.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference)
			.where(eq(d1Schema.blobReference.narHash, narHash))
			.get();

		return referenced === undefined;
	}

	private clearQueuedNarInfoDeletion(
		cache: string,
		storePathHash: string,
		generation: number
	): void {
		this.context.db
			.delete(schema.narInfoDeletions)
			.where(
				and(
					eq(schema.narInfoDeletions.cache, cache),
					eq(schema.narInfoDeletions.storePathHash, storePathHash),
					eq(schema.narInfoDeletions.generation, generation)
				)
			)
			.run();
	}

	// Runs inside the caller's critical section; must not open its own.
	async flushQueuedNarInfoDeletions(origin?: string): Promise<number> {
		const queued = this.context.db.select().from(schema.narInfoDeletions).all();
		let deleted = 0;

		for (const entry of queued) {
			const { objectDeleted } = await this.deleteQueuedNarInfo(
				entry.cache,
				entry.storePathHash,
				entry.generation,
				origin
			);

			if (objectDeleted) {
				deleted += 1;
			}
		}

		return deleted;
	}

	// Runs inside the caller's critical section; must not open its own.
	async deleteQueuedNarInfo(
		cache: string,
		storePathHash: string,
		generation: number,
		origin?: string
	): Promise<{ objectDeleted: boolean; narScheduledForDeletion: boolean }> {
		// Must run inside a DO critical section: the row check, object delete, NAR
		// scheduling and queue clear span awaits and must not interleave with a
		// commit or another flush.
		const queued = this.context.db
			.select()
			.from(schema.narInfoDeletions)
			.where(
				and(
					eq(schema.narInfoDeletions.cache, cache),
					eq(schema.narInfoDeletions.storePathHash, storePathHash),
					eq(schema.narInfoDeletions.generation, generation)
				)
			)
			.get();

		if (queued === undefined) {
			return { objectDeleted: false, narScheduledForDeletion: false };
		}

		const current = this.context.db
			.select({ generation: schema.narInfos.generation })
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();
		const newerCommitted =
			current !== undefined && current.generation !== queued.generation;

		if (newerCommitted) {
			await this.retireBlobRefEdge(
				cache,
				storePathHash,
				queued.generation,
				queued.narHash
			);
			await this.retireAttestationRefs(cache, storePathHash, queued.generation);
			await this.attestations.materialiseList(cache, storePathHash);

			const narScheduledForDeletion = await this.blobHashUnreferenced(
				queued.narHash
			);
			this.clearQueuedNarInfoDeletion(cache, storePathHash, generation);
			return { objectDeleted: false, narScheduledForDeletion };
		}

		await this.context.env.BLOBS.delete(narInfoObjectKey(storePathHash, cache));

		if (origin !== undefined) {
			await this.purgeCachedNarInfo(
				`${origin}${narInfoCachePath(storePathHash, cache)}`
			);
		}

		await this.retireBlobRefEdge(
			cache,
			storePathHash,
			queued.generation,
			queued.narHash
		);
		await this.retireAttestationRefs(cache, storePathHash, queued.generation);
		await this.attestations.materialiseList(cache, storePathHash);

		// Report whether the NAR is now unreferenced (the reaper will reclaim it).
		// Re-check against the live edges: a path may have committed the same NAR
		// since the row was removed.
		const narScheduledForDeletion = await this.blobHashUnreferenced(
			queued.narHash
		);

		this.clearQueuedNarInfoDeletion(cache, storePathHash, generation);

		return { objectDeleted: true, narScheduledForDeletion };
	}

	private async purgeCachedNarInfo(url: string): Promise<void> {
		// Best-effort and colo-local: recovery correctness rests on the R2 delete
		// and row cleanup, so a failed edge purge must not abort them. Other colos
		// serve the stale narinfo until its TTL expires.
		try {
			await caches.default.delete(url);
		} catch {
			/* edge purge is best-effort */
		}
	}

	deleteStorePath(
		cache: string,
		storePathHash: string,
		origin: string
	): Promise<DeletePathResponse> {
		// One critical section so the row transaction and the opportunistic object
		// cleanup cannot interleave with a heal that would re-materialise the
		// object.
		return this.context.ctx.blockConcurrencyWhile(async () => {
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
				return {
					storePathHash,
					deleted: false,
					narScheduledForDeletion: false
				};
			}

			// Row-first: once this transaction commits the path is logically gone.
			// The narinfo object cleanup, and with it the NAR scheduling, runs
			// afterwards and is best-effort; the grace clock for the NAR only starts
			// once the object is actually removed.
			const now = new Date().toISOString();

			this.context.db.transaction((tx) => {
				tx.delete(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cache, row.cache),
							eq(schema.narInfos.storePathHash, storePathHash)
						)
					)
					.run();
				this.enqueueNarInfoDeletion(
					tx,
					row.cache,
					storePathHash,
					row.narHash,
					row.generation,
					now
				);
			});

			let narScheduledForDeletion = false;

			try {
				({ narScheduledForDeletion } = await this.deleteQueuedNarInfo(
					row.cache,
					storePathHash,
					row.generation,
					origin
				));
			} catch {
				// the durable queue row remains for GC to retry
			}

			return { storePathHash, deleted: true, narScheduledForDeletion };
		});
	}

	async removeStaleNarInfo(
		row: typeof schema.narInfos.$inferSelect,
		origin: string
	): Promise<void> {
		await this.context.ctx.blockConcurrencyWhile(() =>
			this.reconcileMissingNar(row, origin)
		);
	}

	// Removes a narinfo whose NAR is gone, row-first, as for deleteStorePath: the
	// transaction removes the row and queues the narinfo object cleanup, so an
	// interrupted recovery cannot resurrect the path through a heal. The object
	// delete that follows is opportunistic and GC finishes anything left in the
	// queue. The caller owns the critical section so verification can reconcile a
	// whole batch in one without nesting `blockConcurrencyWhile`.
	//
	// Runs inside the caller's critical section; must not open its own.
	async reconcileMissingNar(
		row: typeof schema.narInfos.$inferSelect,
		origin?: string
	): Promise<void> {
		const now = new Date().toISOString();

		this.context.db.transaction((tx) => {
			tx.delete(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, row.cache),
						eq(schema.narInfos.storePathHash, row.storePathHash)
					)
				)
				.run();
			this.enqueueNarInfoDeletion(
				tx,
				row.cache,
				row.storePathHash,
				row.narHash,
				row.generation,
				now
			);
		});

		try {
			await this.deleteQueuedNarInfo(
				row.cache,
				row.storePathHash,
				row.generation,
				origin
			);
		} catch {
			// the durable queue row remains for GC to retry
		}
	}
}
