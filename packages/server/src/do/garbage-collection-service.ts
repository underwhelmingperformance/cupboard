import {
	referencesSchema,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { and, eq, isNull, lt, lte, or } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import { StoredReferencesInvalidError } from '../errors.ts';
import { narObjectKey } from '../http/http.ts';
import { parseStored } from '../http/parse.ts';

import { deleteObjects } from './bulk.ts';
import {
	type GarbageCollectionOutcome,
	type ServerContext
} from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';
import { parseStoredUploadMetadata } from './upload-metadata.ts';

// One sweep deletes at most this many committed paths before returning, so a
// chunk holds the Durable Object's gate only for its own deletes. When a sweep
// stops at this cap the caller resumes it on an alarm, draining the backlog
// across chunks.
export const maxPathsSweptPerRun = 1000;

export class GarbageCollectionService {
	constructor(
		private readonly context: ServerContext,
		private readonly deletionQueue: DeletionQueueService
	) {}

	private collectUnreachable(
		cache: string,
		now: string,
		budget: number
	): {
		rootsExpired: number;
		pathsSwept: number;
	} {
		// Expire TTL'd roots first, regardless of whether a sweep follows, so an
		// expiring channel always lapses. A NULL expiry (permanent) never matches.
		const expiredRoots = this.context.db
			.select({ name: schema.retentionRoots.name })
			.from(schema.retentionRoots)
			.where(
				and(
					eq(schema.retentionRoots.cache, cache),
					lte(schema.retentionRoots.expiresAt, now)
				)
			)
			.all();

		this.context.db.transaction((tx) => {
			for (const root of expiredRoots) {
				tx.delete(schema.retentionRootTargets)
					.where(
						and(
							eq(schema.retentionRootTargets.cache, cache),
							eq(schema.retentionRootTargets.rootName, root.name)
						)
					)
					.run();
			}

			tx.delete(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cache, cache),
						lte(schema.retentionRoots.expiresAt, now)
					)
				)
				.run();
		});

		// Mark the closure reachable from the live roots within this cache.
		// `visited` guards the traversal; `retainedCommitted` is the keep-set of
		// committed paths that the sweep spares.
		const visited = new Set<string>();
		const retainedCommitted = new Set<string>();
		const queue: StorePathHash[] = [];

		const rootTargets = this.context.db
			.select({ storePathHash: schema.retentionRootTargets.storePathHash })
			.from(schema.retentionRootTargets)
			.where(eq(schema.retentionRootTargets.cache, cache))
			.all();

		for (const target of rootTargets) {
			if (!visited.has(target.storePathHash)) {
				visited.add(target.storePathHash);
				queue.push(storePathHashSchema.parse(target.storePathHash));
			}
		}

		while (queue.length > 0) {
			const storePathHash = queue.pop();

			if (storePathHash === undefined) {
				break;
			}

			const row = this.context.db
				.select({ referencesJson: schema.narInfos.referencesJson })
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, cache),
						eq(schema.narInfos.storePathHash, storePathHash)
					)
				)
				.get();

			if (row === undefined) {
				continue;
			}

			retainedCommitted.add(storePathHash);

			const references = parseStored(
				referencesSchema,
				row.referencesJson,
				(cause) => new StoredReferencesInvalidError(storePathHash, cause)
			);

			this.enqueueReachableReferences(references, visited, queue);
		}

		// Guard: nothing committed is reachable in this cache and no root expired
		// (no roots, or roots that only point at absent paths), so collecting would
		// empty it without a retention event. Skip.
		if (retainedCommitted.size === 0 && expiredRoots.length === 0) {
			return { rootsExpired: expiredRoots.length, pathsSwept: 0 };
		}

		// A narinfo row reserved by an in-flight commit saga (`committing`/`pending`)
		// is not yet reachable from a root and carries no committed reference, so the
		// reachability sweep would delete it during the deferred-commit promote window.
		// Spare those rows; the verify pass owns them and either materialises or
		// reclaims them, mirroring how the upload sweep spares their pending rows.
		const inFlight = new Set<string>();
		const reservedVerdict = or(
			eq(schema.pendingUploads.verdict, 'committing'),
			eq(schema.pendingUploads.verdict, 'pending')
		);

		const reservedUploads = this.context.db
			.select({
				id: schema.pendingUploads.id,
				metadataJson: schema.pendingUploads.metadataJson
			})
			.from(schema.pendingUploads)
			.where(and(eq(schema.pendingUploads.cache, cache), reservedVerdict))
			.all();

		for (const upload of reservedUploads) {
			try {
				inFlight.add(
					parseStoredUploadMetadata(upload.id, upload.metadataJson)
						.storePathHash
				);
			} catch {
				// An unparseable row cannot be matched to a reserved narinfo to spare;
				// the verify pass re-drives or reclaims it, so omitting it is safe.
				continue;
			}
		}

		const committed = this.context.db
			.select({
				storePathHash: schema.narInfos.storePathHash,
				narHash: schema.narInfos.narHash,
				generation: schema.narInfos.generation
			})
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cache, cache))
			.all();
		let pathsSwept = 0;

		for (const path of committed) {
			if (
				retainedCommitted.has(path.storePathHash) ||
				inFlight.has(path.storePathHash)
			) {
				continue;
			}

			// A later sweep (resumed by the alarm, or the next scheduled run) takes
			// the remaining unreachable paths; stopping here keeps the gate hold
			// bounded.
			if (pathsSwept >= budget) {
				break;
			}

			this.context.db.transaction((tx) => {
				tx.delete(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cache, cache),
							eq(schema.narInfos.storePathHash, path.storePathHash)
						)
					)
					.run();
				this.deletionQueue.enqueueNarInfoDeletion(
					tx,
					cache,
					path.storePathHash,
					path.narHash,
					path.generation,
					now
				);
			});
			pathsSwept += 1;
		}

		return { rootsExpired: expiredRoots.length, pathsSwept };
	}

	// Walks a row's references, enqueuing each not-yet-visited reference hash for
	// the reachability traversal. Extracted from the traversal loop so the
	// per-reference skip is a plain early return rather than a nested `continue`.
	private enqueueReachableReferences(
		references: readonly string[],
		visited: Set<string>,
		queue: StorePathHash[]
	): void {
		for (const reference of references) {
			const separator = reference.indexOf('-');

			if (separator <= 0) {
				continue;
			}

			const referenceHash = reference.slice(0, separator);

			if (visited.has(referenceHash)) {
				continue;
			}

			visited.add(referenceHash);
			queue.push(storePathHashSchema.parse(referenceHash));
		}
	}

	collectGarbage(
		cache?: string,
		purgeOrigin?: string,
		sweepLimit: number = maxPathsSweptPerRun
	): Promise<GarbageCollectionOutcome> {
		const startedAt = new Date();
		const now = startedAt.toISOString();

		return this.context.ctx.blockConcurrencyWhile(async () => {
			// A `pending` or `committing` upload is a live commit saga (awaiting
			// background verification, or a crashed inline commit the verify pass
			// re-drives), not abandoned, so it and its staged bytes must survive the
			// sweep until the verify pass resolves it. The reapable states once expired
			// are a null-verdict row still awaiting its bytes and the terminal verdicts
			// (`servable`, `mismatch`, `over-quota`) whose status-observation window has
			// passed; their staging bytes are already gone.
			const reapable = and(
				lt(schema.pendingUploads.expiresAt, now),
				or(
					isNull(schema.pendingUploads.verdict),
					eq(schema.pendingUploads.verdict, 'servable'),
					eq(schema.pendingUploads.verdict, 'mismatch'),
					eq(schema.pendingUploads.verdict, 'over-quota')
				)
			);

			const expiredUploads = this.context.db
				.select()
				.from(schema.pendingUploads)
				.where(reapable)
				.all();
			const expiredAttestations = this.context.db
				.select()
				.from(schema.pendingAttestations)
				.where(lt(schema.pendingAttestations.expiresAt, now))
				.all();

			// An abandoned upload's private staging object is reclaimed directly; a
			// reuse upload's r2Key is the shared canonical key, which the reaper owns,
			// so it is left alone.
			await deleteObjects(
				this.context.env.BLOBS,
				expiredUploads
					.filter((upload) => upload.r2Key !== narObjectKey(upload.narHash))
					.map((upload) => upload.r2Key)
			);
			await deleteObjects(
				this.context.env.BLOBS,
				expiredAttestations.map((upload) => upload.r2Key)
			);

			this.context.db.delete(schema.pendingUploads).where(reapable).run();
			this.context.db
				.delete(schema.pendingAttestations)
				.where(lt(schema.pendingAttestations.expiresAt, now))
				.run();
			// An expired refresh token nobody presented again still holds a row;
			// the sweep reclaims it. A live session is untouched (rotation renews
			// its expiry on every use).
			this.context.db
				.delete(schema.refreshTokens)
				.where(lt(schema.refreshTokens.expiresAt, now))
				.run();

			// Reachability GC is per-cache: each registered cache keeps its own
			// closure. A bare /gc sweeps every cache; /cache/:name/gc sweeps one.
			// Shared NAR blobs are retired only once globally unreferenced.
			const sweepCaches =
				cache === undefined
					? this.context.db
							.select({ name: schema.caches.name })
							.from(schema.caches)
							.all()
							.map((row) => row.name)
					: [cache];
			let rootsExpired = 0;
			let pathsSwept = 0;

			for (const name of sweepCaches) {
				const swept = this.collectUnreachable(
					name,
					now,
					sweepLimit - pathsSwept
				);
				rootsExpired += swept.rootsExpired;
				pathsSwept += swept.pathsSwept;

				if (pathsSwept >= sweepLimit) {
					break;
				}
			}

			return {
				pendingUploadsDeleted: expiredUploads.length,
				pendingAttestationsDeleted: expiredAttestations.length,
				rootsExpired,
				pathsSwept,
				narInfosDeleted:
					await this.deletionQueue.flushQueuedNarInfoDeletions(purgeOrigin)
			};
		});
	}
}
