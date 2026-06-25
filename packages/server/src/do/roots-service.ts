import {
	type RootName,
	type StorePathHash,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, resolveRootTargets } from '@cupboard/nix-store/store-path';
import {
	type ParsedRootSetBody,
	type RootListResponse,
	type RootRemoveResponse,
	type RootSetResponse,
	type RootSummary
} from '@cupboard/protocol/retention';
import { and, eq } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import { RootTargetsUnavailableError } from '../errors.ts';
import { coldPathTtlSeconds, resolveRootExpiry } from '../policy/cold-path.ts';

import { type CacheAdminService } from './cache-admin-service.ts';
import { type RootSetCommand, type ServerContext } from './context.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { type RetentionService } from './retention-service.ts';

interface StoredRoot {
	readonly expiresAt: string | undefined;
	readonly createdAt: string;
	readonly updatedAt: string;
}

type RootWrite =
	| { readonly kind: 'rejected'; readonly unavailable: readonly string[] }
	| { readonly kind: 'written'; readonly stored: StoredRoot };

export class RootsService {
	constructor(
		private readonly context: ServerContext,
		private readonly cacheAdmin: CacheAdminService,
		private readonly retention: RetentionService,
		private readonly narInfoObjects: NarInfoObjectsService
	) {}

	private writeRoot(cache: string, request: RootSetCommand): StoredRoot {
		const now = new Date();
		const nowIso = now.toISOString();
		// Precedence: an explicit TTL, then a matching retention policy, then the
		// cold-path default for an implicit pin, otherwise permanent.
		const expiresAt = resolveRootExpiry({
			explicitTtlSeconds: request.ttlSeconds,
			policyTtlSeconds: this.retention.resolvePolicyTtl(cache, request.name),
			name: request.name,
			coldPathTtlSeconds: coldPathTtlSeconds(this.context.env),
			now
		});

		this.cacheAdmin.loadOrCreateCache(cache);

		// Replace the root wholesale: a re-set fully declares the channel, so the
		// old row and target set are dropped and rewritten. The createdAt of an
		// existing channel is preserved; an absent expiry stores SQL NULL via the
		// undefined insert value.
		const createdAt = this.context.db.transaction((tx) => {
			const existing = tx
				.select()
				.from(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cache, cache),
						eq(schema.retentionRoots.name, request.name)
					)
				)
				.get();
			const created = existing?.createdAt ?? nowIso;

			tx.delete(schema.retentionRootTargets)
				.where(
					and(
						eq(schema.retentionRootTargets.cache, cache),
						eq(schema.retentionRootTargets.rootName, request.name)
					)
				)
				.run();
			tx.delete(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cache, cache),
						eq(schema.retentionRoots.name, request.name)
					)
				)
				.run();

			tx.insert(schema.retentionRoots)
				.values({
					cache,
					name: request.name,
					expiresAt,
					createdAt: created,
					updatedAt: nowIso
				})
				.run();

			tx.insert(schema.retentionRootTargets)
				.values(
					request.targets.map((target) => ({
						cache,
						rootName: request.name,
						storePathHash: target.storePathHash,
						storePath: target.storePath
					}))
				)
				.run();

			return created;
		});

		return { expiresAt, createdAt, updatedAt: nowIso };
	}

	private rootTargetRows(
		cache: string,
		name: RootName
	): readonly { storePathHash: StorePathHash; storePath: StorePathString }[] {
		return this.context.db
			.select({
				storePathHash: schema.retentionRootTargets.storePathHash,
				storePath: schema.retentionRootTargets.storePath
			})
			.from(schema.retentionRootTargets)
			.where(
				and(
					eq(schema.retentionRootTargets.cache, cache),
					eq(schema.retentionRootTargets.rootName, name)
				)
			)
			.all();
	}

	// The set of distinct target hashes that would serve, the same predicate the
	// read path uses. The common case (the narinfo object is present) is settled by
	// a bounded fan-out of R2 heads outside any critical section; only a target
	// whose object is missing falls back to the gated heal-and-recheck, so a large
	// root no longer heads, or heals, every path under the gate.
	private async servableTargets(
		cache: string,
		targets: readonly { storePathHash: StorePathHash }[]
	): Promise<ReadonlySet<StorePathHash>> {
		const hashes = [...new Set(targets.map((target) => target.storePathHash))];
		const servable = new Set(
			await this.narInfoObjects.existingNarInfoObjects(cache, hashes)
		);

		for (const hash of hashes) {
			if (servable.has(hash)) {
				continue;
			}

			if (await this.narInfoObjects.isServable(cache, hash)) {
				servable.add(hash);
			}
		}

		return servable;
	}

	// Whether a committed narinfo row still exists for this path, a synchronous DO
	// SQLite read. A delete is row-first and runs under the gate, so a row still
	// present inside the write gate cannot be mid-delete; this is the cheap
	// re-check that lets the expensive serve probe run outside the gate.
	private rowPresent(cache: string, storePathHash: StorePathHash): boolean {
		return (
			this.context.db
				.select({ storePathHash: schema.narInfos.storePathHash })
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, cache),
						eq(schema.narInfos.storePathHash, storePathHash)
					)
				)
				.get() !== undefined
		);
	}

	private rootSummaryFrom(
		name: RootName,
		stored: StoredRoot,
		now: string,
		targets: readonly {
			storePathHash: StorePathHash;
			storePath: StorePathString;
		}[],
		servable: ReadonlySet<StorePathHash>
	): RootSummary {
		return {
			name,
			...(stored.expiresAt !== undefined && { expiresAt: stored.expiresAt }),
			expired: stored.expiresAt !== undefined && stored.expiresAt <= now,
			createdAt: stored.createdAt,
			updatedAt: stored.updatedAt,
			targets: targets
				.map((target) => ({
					storePathHash: target.storePathHash,
					storePath: target.storePath,
					present: servable.has(target.storePathHash)
				}))
				.toSorted((a, b) => byCodeUnit(a.storePathHash, b.storePathHash))
		};
	}

	async setRoot(
		cache: string,
		rootName: RootName,
		body: ParsedRootSetBody
	): Promise<RootSetResponse> {
		const requested: RootSetCommand = {
			name: rootName,
			targets: resolveRootTargets(body.targets),
			ttlSeconds: body.ttlSeconds
		};

		// Activation gates on the serve predicate so a root never advertises a path
		// that is not yet substitutable. The probe (repairing a merely-lost object)
		// runs outside the gate, where its R2 heads and the rare heal do not stall
		// the object; an unavailable target rejects without writing. The write then
		// takes a short gate that re-confirms, with a synchronous row read, that no
		// target was deleted since the probe: a delete is row-first and runs under
		// the gate, so a row still present here cannot be mid-delete, and the write
		// cannot interleave with one. Rejections are thrown after the section so a
		// validation error does not reset the Durable Object.
		const servable = await this.servableTargets(cache, requested.targets);
		const unavailable = requested.targets
			.filter((target) => !servable.has(target.storePathHash))
			.map((target) => target.storePath);

		if (unavailable.length > 0) {
			throw new RootTargetsUnavailableError(rootName, unavailable);
		}

		const write = await this.context.ctx.blockConcurrencyWhile(
			(): Promise<RootWrite> => {
				const deleted = requested.targets
					.filter((target) => !this.rowPresent(cache, target.storePathHash))
					.map((target) => target.storePath);

				if (deleted.length > 0) {
					return Promise.resolve({ kind: 'rejected', unavailable: deleted });
				}

				return Promise.resolve({
					kind: 'written',
					stored: this.writeRoot(cache, requested)
				});
			}
		);

		if (write.kind === 'rejected') {
			throw new RootTargetsUnavailableError(rootName, write.unavailable);
		}

		return this.rootSummaryFrom(
			rootName,
			write.stored,
			write.stored.updatedAt,
			requested.targets,
			servable
		);
	}

	async listRoots(cache: string): Promise<RootListResponse> {
		const nowDate = new Date();
		const now = nowDate.toISOString();
		const roots = this.context.db
			.select()
			.from(schema.retentionRoots)
			.where(eq(schema.retentionRoots.cache, cache))
			.all();

		const summaries: RootSummary[] = [];

		for (const root of roots) {
			const targets = this.rootTargetRows(cache, root.name);
			const servable = await this.servableTargets(cache, targets);

			summaries.push(
				this.rootSummaryFrom(
					root.name,
					{
						expiresAt: root.expiresAt ?? undefined,
						createdAt: root.createdAt,
						updatedAt: root.updatedAt
					},
					now,
					targets,
					servable
				)
			);
		}

		return {
			roots: summaries.toSorted((a, b) => byCodeUnit(a.name, b.name))
		};
	}

	removeRoot(cache: string, name: RootName): RootRemoveResponse {
		return this.context.db.transaction((tx) => {
			const existing = tx
				.select()
				.from(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cache, cache),
						eq(schema.retentionRoots.name, name)
					)
				)
				.get();

			tx.delete(schema.retentionRootTargets)
				.where(
					and(
						eq(schema.retentionRootTargets.cache, cache),
						eq(schema.retentionRootTargets.rootName, name)
					)
				)
				.run();
			tx.delete(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cache, cache),
						eq(schema.retentionRoots.name, name)
					)
				)
				.run();

			return { name, removed: existing !== undefined };
		});
	}
}
