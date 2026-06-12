import { referencesSchema } from '@cupboard/nix/scalars';
import { and, eq, isNull, lt, lte, or } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import { StoredReferencesInvalidError } from '../errors.ts';
import { internalOrigin, narObjectKey } from '../http/http.ts';
import { parseStored } from '../http/parse.ts';

import { type AuthKeysService } from './auth-keys-service.ts';
import {
	type GarbageCollectionOutcome,
	type ServerContext
} from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';

export class GarbageCollectionService {
	constructor(
		private readonly context: ServerContext,
		private readonly authKeys: AuthKeysService,
		private readonly deletionQueue: DeletionQueueService
	) {}

	private collectUnreachable(
		cache: string,
		now: string
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
		const queue: string[] = [];

		for (const target of this.context.db
			.select({ storePathHash: schema.retentionRootTargets.storePathHash })
			.from(schema.retentionRootTargets)
			.where(eq(schema.retentionRootTargets.cache, cache))
			.all()) {
			if (!visited.has(target.storePathHash)) {
				visited.add(target.storePathHash);
				queue.push(target.storePathHash);
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

			for (const reference of references) {
				const separator = reference.indexOf('-');

				if (separator <= 0) {
					continue;
				}

				const referenceHash = reference.slice(0, separator);

				if (!visited.has(referenceHash)) {
					visited.add(referenceHash);
					queue.push(referenceHash);
				}
			}
		}

		// Guard: nothing committed is reachable in this cache and no root expired
		// (no roots, or roots that only point at absent paths), so collecting would
		// empty it without a retention event. Skip.
		if (retainedCommitted.size === 0 && expiredRoots.length === 0) {
			return { rootsExpired: expiredRoots.length, pathsSwept: 0 };
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
			if (retainedCommitted.has(path.storePathHash)) {
				continue;
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

	async handleGarbageCollection(
		request: Request,
		cache?: string
	): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		// Interactive GC purges this colo's edge cache via the caller's public
		// origin. The cron sweep arrives on the internal origin and cannot know
		// the public URL, so it skips purging and relies on the narinfo TTL and
		// the orphan-blob grace window instead.
		const requestOrigin = new URL(request.url).origin;
		const purgeOrigin =
			requestOrigin === internalOrigin ? undefined : requestOrigin;

		return Response.json({
			ok: true,
			...(await this.collectGarbage(cache, purgeOrigin))
		});
	}

	collectGarbage(
		cache?: string,
		purgeOrigin?: string
	): Promise<GarbageCollectionOutcome> {
		const now = new Date().toISOString();

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
			for (const upload of expiredUploads) {
				if (upload.r2Key !== narObjectKey(upload.narHash)) {
					await this.context.env.BLOBS.delete(upload.r2Key);
				}
			}

			for (const upload of expiredAttestations) {
				await this.context.env.BLOBS.delete(upload.r2Key);
			}

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
				const swept = this.collectUnreachable(name, now);
				rootsExpired += swept.rootsExpired;
				pathsSwept += swept.pathsSwept;
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
