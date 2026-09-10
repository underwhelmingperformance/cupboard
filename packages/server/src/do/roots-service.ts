import {
	type CacheScope,
	type NixSha256HashString,
	type RootName,
	type StorePathHash,
	type StorePathString,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, resolveRootTargets } from '@cupboard/nix-store/store-path';
import {
	type RootEnsureBody,
	type RootEnsureResponse,
	rootListPageSize,
	type RootListResponse,
	type RootRemoveResponse,
	type RootSetBody,
	type RootSetResponse,
	type RootSummary,
	type RootTargetsPage
} from '@cupboard/protocol/retention';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { chunk } from '@cupboard/shared/collections';
import { and, eq, sql } from 'drizzle-orm';

import type { ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { RootTargetsUnavailableError } from '../errors.ts';
import { requireServedStorePaths } from '../policy/served-store.ts';

import { maxBoundParameters } from './bulk.ts';
import { type RootSetCommand, type ServerContext } from './context.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { type RetentionService } from './retention-service.ts';

interface StoredRoot {
	readonly expiresAt: IsoTimestamp | undefined;
	readonly createdAt: IsoTimestamp;
	readonly updatedAt: IsoTimestamp;
}

// Each target row supplies all four columns of `retention_root_target`, so the
// INSERT binds four parameters per row and nothing else. A full chunk uses all
// 100 parameters. Update this calculation if the statement gains another column
// or a fixed parameter.
const rootTargetInsertColumns = 4;
export const maxRootTargetInsertRows = Math.floor(
	maxBoundParameters / rootTargetInsertColumns
);

// A narinfo row's exact version, snapshotted off-gate so a gated re-check can
// tell an unchanged row from one a delete-and-recommit replaced.
interface TargetIdentity {
	readonly generation: number;
	readonly narHash: NixSha256HashString;
}

type RootWrite =
	| {
			readonly kind: 'rejected';
			readonly unavailable: readonly StorePathString[];
	  }
	| { readonly kind: 'written'; readonly stored: StoredRoot };

function rootExpiry(
	ttlSeconds: TtlSeconds | undefined,
	now: Date
): IsoTimestamp | undefined {
	if (ttlSeconds === undefined) {
		return undefined;
	}

	return isoTimestamp(new Date(now.getTime() + ttlSeconds * 1000));
}

export class RootsService {
	constructor(
		private readonly context: ServerContext,
		private readonly retention: RetentionService,
		private readonly narInfoObjects: NarInfoObjectsService
	) {}

	private writeRoot(cache: ResolvedCache, request: RootSetCommand): StoredRoot {
		const now = new Date();
		const nowIso = isoTimestamp(now);
		const expiresAt = rootExpiry(
			request.ttlSeconds ?? this.retention.resolveRootTtl(cache, request.name),
			now
		);

		// The targets the replacement releases receive a grace deadline, so they
		// are read before the wholesale delete below discards them.
		const requested = new Set<string>(
			request.targets.map((target) => target.storePathHash)
		);
		const released = this.rootTargetRows(cache, request.name)
			.map((target) => target.storePathHash)
			.filter((storePathHash) => !requested.has(storePathHash));

		// A set request replaces the complete target set. Preserve the original
		// creation time while storing no expiry as SQL NULL.
		const createdAt = this.context.db.transaction((tx) => {
			const existing = tx
				.select()
				.from(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cacheId, cache.id),
						eq(schema.retentionRoots.name, request.name)
					)
				)
				.get();
			const created = existing?.createdAt ?? nowIso;

			tx.delete(schema.retentionRootTargets)
				.where(
					and(
						eq(schema.retentionRootTargets.cacheId, cache.id),
						eq(schema.retentionRootTargets.rootName, request.name)
					)
				)
				.run();
			tx.delete(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cacheId, cache.id),
						eq(schema.retentionRoots.name, request.name)
					)
				)
				.run();

			tx.insert(schema.retentionRoots)
				.values({
					cacheId: cache.id,
					name: request.name,
					expiresAt,
					createdAt: created,
					updatedAt: nowIso
				})
				.run();

			for (const targets of chunk(request.targets, maxRootTargetInsertRows)) {
				tx.insert(schema.retentionRootTargets)
					.values(
						targets.map((target) => ({
							cacheId: cache.id,
							rootName: request.name,
							storePathHash: target.storePathHash,
							storePath: target.storePath
						}))
					)
					.run();
			}

			// Applied inside the same transaction as the delete above: a crash
			// between the two could otherwise release these targets from the old
			// root's retention with no deadline ever established.
			this.retention.applyGraceTransition(cache, released, nowIso, tx);

			return created;
		});

		return { expiresAt, createdAt, updatedAt: nowIso };
	}

	private rootTargetRows(
		cache: ResolvedCache,
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
					eq(schema.retentionRootTargets.cacheId, cache.id),
					eq(schema.retentionRootTargets.rootName, name)
				)
			)
			.all();
	}

	private async servableTargets(
		cache: ResolvedCache,
		targets: readonly { storePathHash: StorePathHash }[]
	): Promise<ReadonlySet<StorePathHash>> {
		return this.narInfoObjects.servableStorePathHashes(
			cache,
			targets.map((target) => target.storePathHash)
		);
	}

	// Snapshot each row before the R2 probe. `ensureRoot` rechecks the generation
	// and NAR hash inside the write gate, so a delete and recommit during the probe
	// cannot retain content that the probe did not verify.
	private async servableTargetIdentities(
		cache: ResolvedCache,
		targets: readonly { storePathHash: StorePathHash }[]
	): Promise<ReadonlyMap<StorePathHash, TargetIdentity>> {
		const hashes = [...new Set(targets.map((target) => target.storePathHash))];
		const snapshot = new Map(
			this.narInfoObjects
				.narInfoRowsFor(cache, hashes)
				.map((row) => [
					row.storePathHash,
					{ generation: row.generation, narHash: row.narHash }
				])
		);
		const servable = await this.servableTargets(cache, targets);

		return new Map(
			[...servable].flatMap((hash) => {
				const identity = snapshot.get(hash);

				return identity === undefined ? [] : [[hash, identity] as const];
			})
		);
	}

	private rowPresent(
		cache: ResolvedCache,
		storePathHash: StorePathHash
	): boolean {
		return (
			this.context.db
				.select({ storePathHash: schema.narInfos.storePathHash })
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cacheId, cache.id),
						eq(schema.narInfos.storePathHash, storePathHash)
					)
				)
				.get() !== undefined
		);
	}

	private mismatchedTargets(
		cache: ResolvedCache,
		targets: readonly {
			storePathHash: StorePathHash;
			storePath: StorePathString;
		}[],
		expected: ReadonlyMap<StorePathHash, TargetIdentity>
	): readonly StorePathString[] {
		const current = new Map(
			this.narInfoObjects
				.narInfoRowsFor(
					cache,
					targets.map((target) => target.storePathHash)
				)
				.map((row) => [row.storePathHash, row])
		);

		return targets
			.filter((target) => {
				const expectedIdentity = expected.get(target.storePathHash);
				const currentRow = current.get(target.storePathHash);

				return (
					expectedIdentity === undefined ||
					currentRow?.generation !== expectedIdentity.generation ||
					currentRow.narHash !== expectedIdentity.narHash
				);
			})
			.map((target) => target.storePath);
	}

	private rootSummaryFrom(
		name: RootName,
		stored: StoredRoot,
		now: IsoTimestamp,
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

	private buildRootSetCommand(
		rootName: RootName,
		body: RootSetBody
	): RootSetCommand {
		requireServedStorePaths(body.targets);

		return {
			name: rootName,
			targets: resolveRootTargets(body.targets),
			ttlSeconds: body.ttlSeconds
		};
	}

	// A set request may retain a row that is still being verified. An ensure
	// request first proves servability outside the gate, then supplies the exact
	// generation and NAR hash for this synchronous recheck. Deletion removes the
	// row first under the same gate, so neither path can write a root for a row
	// that disappeared or was recommitted during an awaited probe. Return the
	// rejection after leaving the gate because throwing inside it resets the
	// Durable Object.
	private async gatedRootWrite(
		cache: ResolvedCache,
		requested: RootSetCommand,
		expectedIdentities?: ReadonlyMap<StorePathHash, TargetIdentity>
	): Promise<RootWrite> {
		return this.context.criticalSection((): Promise<RootWrite> => {
			const absent =
				expectedIdentities === undefined
					? requested.targets
							.filter((target) => !this.rowPresent(cache, target.storePathHash))
							.map((target) => target.storePath)
					: this.mismatchedTargets(
							cache,
							requested.targets,
							expectedIdentities
						);

			if (absent.length > 0) {
				return Promise.resolve({ kind: 'rejected', unavailable: absent });
			}

			return Promise.resolve({
				kind: 'written',
				stored: this.writeRoot(cache, requested)
			});
		});
	}

	// The first negotiation creates a run root; later negotiations can only extend
	// its expiry. They do not replace targets or release paths into grace. Commits
	// add their paths as they finish.
	bindRunRoot(
		cache: ResolvedCache,
		name: RootName,
		explicitTtlSeconds: TtlSeconds | undefined
	): void {
		const now = new Date();
		const nowIso = isoTimestamp(now);
		const expiresAt = rootExpiry(
			explicitTtlSeconds ?? this.retention.resolveRootTtl(cache, name),
			now
		);

		this.context.db
			.insert(schema.retentionRoots)
			.values({
				cacheId: cache.id,
				name,
				expiresAt,
				createdAt: nowIso,
				updatedAt: nowIso
			})
			.onConflictDoUpdate({
				target: [schema.retentionRoots.cacheId, schema.retentionRoots.name],
				set: {
					// SQLite `max` returns NULL when either operand is NULL, so a
					// permanent root stays permanent. ISO-8601 UTC strings compare in
					// chronological order, so a shorter TTL cannot reduce the expiry.
					expiresAt: sql`max(${schema.retentionRoots.expiresAt}, excluded.expires_at)`,
					updatedAt: nowIso
				}
			})
			.run();
	}

	// A skipped path has no later commit at which to join the run root, so attach
	// it during negotiation. The insert is additive and idempotent; it neither
	// replaces targets nor starts a grace transition.
	attachRunRootTargets(
		cache: ResolvedCache,
		name: RootName,
		targets: readonly {
			readonly storePathHash: StorePathHash;
			readonly storePath: StorePathString;
		}[]
	): void {
		for (const batch of chunk(targets, maxRootTargetInsertRows)) {
			this.context.db
				.insert(schema.retentionRootTargets)
				.values(
					batch.map((target) => ({
						cacheId: cache.id,
						rootName: name,
						storePathHash: target.storePathHash,
						storePath: target.storePath
					}))
				)
				.onConflictDoNothing()
				.run();
		}
	}

	// Replace the complete target set, including when it is empty. The root and
	// its resolved expiry remain, and released targets enter retention grace.
	async setRoot(
		cacheScope: CacheScope,
		rootName: RootName,
		body: RootSetBody
	): Promise<RootSetResponse> {
		const cache = this.context.cacheRepository.require(cacheScope);
		const requested = this.buildRootSetCommand(rootName, body);
		const servable = await this.servableTargets(cache, requested.targets);
		const write = await this.gatedRootWrite(cache, requested);

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

	async ensureRoot(
		cacheScope: CacheScope,
		rootName: RootName,
		body: RootEnsureBody
	): Promise<RootEnsureResponse> {
		const cache = this.context.cacheRepository.require(cacheScope);
		const requested = this.buildRootSetCommand(rootName, body);
		const identities = await this.servableTargetIdentities(
			cache,
			requested.targets
		);
		const unavailable = requested.targets
			.filter((target) => !identities.has(target.storePathHash))
			.map((target) => target.storePath);

		if (unavailable.length > 0) {
			return { status: 'build-required', unavailable };
		}

		const write = await this.gatedRootWrite(cache, requested, identities);

		if (write.kind === 'rejected') {
			return {
				status: 'build-required',
				unavailable: [...write.unavailable]
			};
		}

		return {
			status: 'retained',
			root: this.rootSummaryFrom(
				rootName,
				write.stored,
				write.stored.updatedAt,
				requested.targets,
				new Set(identities.keys())
			)
		};
	}

	// Count targets in SQLite and paginate roots by name without reading target
	// rows or probing R2. Large run roots therefore do not expand this request.
	listRoots(
		cacheScope: CacheScope,
		options: { readonly cursor?: string; readonly limit?: number } = {}
	): RootListResponse {
		const cache = this.context.cacheRepository.resolve(cacheScope);

		if (cache === undefined) {
			return { roots: [] };
		}

		const limit = Math.min(options.limit ?? rootListPageSize, rootListPageSize);
		const now = isoTimestamp(new Date());
		const rows = this.context.db
			.select({
				name: schema.retentionRoots.name,
				expiresAt: schema.retentionRoots.expiresAt,
				createdAt: schema.retentionRoots.createdAt,
				updatedAt: schema.retentionRoots.updatedAt,
				targetCount: sql<number>`(select count(*) from ${schema.retentionRootTargets} where ${schema.retentionRootTargets.cacheId} = ${schema.retentionRoots.cacheId} and ${schema.retentionRootTargets.rootName} = ${schema.retentionRoots.name})`
			})
			.from(schema.retentionRoots)
			.where(
				and(
					eq(schema.retentionRoots.cacheId, cache.id),
					options.cursor === undefined
						? undefined
						: sql`${schema.retentionRoots.name} > ${options.cursor}`
				)
			)
			.orderBy(schema.retentionRoots.name)
			.limit(limit + 1)
			.all();
		const page = rows.slice(0, limit);
		const last = page.at(-1);

		return {
			roots: page.map((row) => ({
				name: row.name,
				...(row.expiresAt !== null && { expiresAt: row.expiresAt }),
				expired: row.expiresAt !== null && row.expiresAt <= now,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
				targetCount: row.targetCount
			})),
			...(rows.length > limit && last !== undefined && { cursor: last.name })
		};
	}

	// Paginate by store-path hash before probing servability, which bounds the R2
	// fan-out for a large run root. An unknown root returns an empty page.
	async rootTargets(
		cacheScope: CacheScope,
		name: RootName,
		options: { readonly cursor?: string; readonly limit?: number } = {}
	): Promise<RootTargetsPage> {
		const cache = this.context.cacheRepository.resolve(cacheScope);

		if (cache === undefined) {
			return { targets: [] };
		}

		const limit = Math.min(options.limit ?? rootListPageSize, rootListPageSize);
		const rows = this.context.db
			.select({
				storePathHash: schema.retentionRootTargets.storePathHash,
				storePath: schema.retentionRootTargets.storePath
			})
			.from(schema.retentionRootTargets)
			.where(
				and(
					eq(schema.retentionRootTargets.cacheId, cache.id),
					eq(schema.retentionRootTargets.rootName, name),
					options.cursor === undefined
						? undefined
						: sql`${schema.retentionRootTargets.storePathHash} > ${options.cursor}`
				)
			)
			.orderBy(schema.retentionRootTargets.storePathHash)
			.limit(limit + 1)
			.all();
		const page = rows.slice(0, limit);
		const last = page.at(-1);
		const servable = await this.servableTargets(cache, page);

		return {
			targets: page.map((target) => ({
				storePathHash: target.storePathHash,
				storePath: target.storePath,
				present: servable.has(target.storePathHash)
			})),
			...(rows.length > limit &&
				last !== undefined && { cursor: last.storePathHash })
		};
	}

	removeRoot(cacheScope: CacheScope, name: RootName): RootRemoveResponse {
		const cache = this.context.cacheRepository.resolve(cacheScope);

		if (cache === undefined) {
			return { name, removed: false };
		}

		const released = this.rootTargetRows(cache, name).map(
			(target) => target.storePathHash
		);
		const nowIso = isoTimestamp(new Date());

		return this.context.db.transaction((tx) => {
			const existing = tx
				.select()
				.from(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cacheId, cache.id),
						eq(schema.retentionRoots.name, name)
					)
				)
				.get();

			tx.delete(schema.retentionRootTargets)
				.where(
					and(
						eq(schema.retentionRootTargets.cacheId, cache.id),
						eq(schema.retentionRootTargets.rootName, name)
					)
				)
				.run();
			tx.delete(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cacheId, cache.id),
						eq(schema.retentionRoots.name, name)
					)
				)
				.run();

			// Applied inside the same transaction as the delete above: a crash
			// between the two could otherwise release these targets with no
			// deadline ever established.
			this.retention.applyGraceTransition(cache, released, nowIso, tx);

			return { name, removed: existing !== undefined };
		});
	}

	// A deferred upload that fails verification cannot become servable. Remove it
	// from every root so later listings do not continue to advertise it.
	pruneRetentionTargets(
		cache: ResolvedCache,
		storePathHash: StorePathHash
	): void {
		this.context.db
			.delete(schema.retentionRootTargets)
			.where(
				and(
					eq(schema.retentionRootTargets.cacheId, cache.id),
					eq(schema.retentionRootTargets.storePathHash, storePathHash)
				)
			)
			.run();
	}
}
