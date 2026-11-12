import {
	type CacheScope,
	type NixSha256HashString,
	type RootName,
	type StorePathHash,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import {
	byCodeUnit,
	type ResolvedRootTarget,
	resolveRootTargets
} from '@cupboard/nix-store/store-path';
import {
	type CacheRootRetention,
	type RootBatchBody,
	rootBatchCapacity,
	rootBatchEntryCost,
	type RootBatchResponse,
	type RootBatchResult,
	type RootEnsureBody,
	type RootEnsureResponse,
	rootListPageSize,
	type RootListResponse,
	type RootRemoveResponse,
	type RootRetentionRequest,
	type RootSetBody,
	type RootSetResponse,
	type RootSummary,
	type RootTargetsPage
} from '@cupboard/protocol/retention';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, sql } from 'drizzle-orm';

import { type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import {
	RootBatchLimitExceededError,
	RootTargetsUnavailableError
} from '../errors.ts';
import { requireServedStorePaths } from '../policy/served-store.ts';

import { CacheClosureService } from './cache-closure-service.ts';
import { type CacheRegistrationService } from './cache-registration-service.ts';
import {
	type RootSetCommand,
	type SchemaWriter,
	type ServerContext
} from './context.ts';
import { hourlyDeadline } from './hourly-deadline.ts';
import {
	allocateRootIncarnation,
	existingRootIncarnationKey,
	insertLiveRootTargets,
	liveRootTargetCount,
	liveRootTargets,
	type RootIncarnationKey,
	rootIncarnationKey,
	warnRootMissing
} from './live-root-targets.ts';
import { type NarInfoDemotionWatch } from './narinfo-demotion-watches.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { type RetentionService } from './retention-service.ts';

interface StoredRoot {
	readonly expiresAt: IsoTimestamp | undefined;
	readonly createdAt: IsoTimestamp;
	readonly updatedAt: IsoTimestamp;
}

// A narinfo row's exact version, snapshotted off-gate so a gated re-check can
// tell an unchanged row from one a delete-and-recommit replaced.
interface TargetIdentity {
	readonly generation: number;
	readonly narHash: NixSha256HashString;
}

// The targets that an ensure found servable before its gate, and the watch
// that records which of them demotion has removed since.
interface ExpectedTargets {
	readonly identities: ReadonlyMap<StorePathHash, TargetIdentity>;
	readonly demotions: NarInfoDemotionWatch;
}

type RootWrite =
	| {
			readonly kind: 'rejected';
			readonly unavailable: readonly StorePathString[];
	  }
	| { readonly kind: 'written'; readonly stored: StoredRoot };

interface RootWriteScope {
	readonly retentionEpoch: number;
	readonly inheritedRetention: (name: RootName) => CacheRootRetention;
}

interface BatchedRootRequest {
	readonly action: RootBatchBody['roots'][number]['action'];
	readonly command: RootSetCommand;
}

type EnsureCheck =
	| {
			readonly kind: 'unavailable';
			readonly unavailable: readonly StorePathString[];
	  }
	| {
			readonly kind: 'checked';
			readonly identities: ReadonlyMap<StorePathHash, TargetIdentity>;
			readonly write: RootWrite;
	  };

function rootExpiry(
	retention: CacheRootRetention,
	now: Date
): IsoTimestamp | undefined {
	if (retention.kind === 'permanent') {
		return undefined;
	}

	return isoTimestamp(new Date(now.getTime() + retention.seconds * 1000));
}

function isSameTargetSet(
	stored: readonly ResolvedRootTarget[],
	requested: readonly ResolvedRootTarget[]
): boolean {
	if (stored.length !== requested.length) {
		return false;
	}

	const storedPaths = new Map(
		stored.map((target) => [target.storePathHash, target.storePath])
	);

	return requested.every(
		(target) => storedPaths.get(target.storePathHash) === target.storePath
	);
}

export class RootsService {
	constructor(
		private readonly context: ServerContext,
		private readonly registration: CacheRegistrationService,
		private readonly retention: RetentionService,
		private readonly narInfoObjects: NarInfoObjectsService
	) {}

	// Returns the cache-level facts that every root write inside one critical
	// section uses. They are read at the first write, so a request whose roots
	// are all rejected reads none of them.
	private rootWriteScope(cache: ResolvedCache): () => RootWriteScope {
		let scope: RootWriteScope | undefined;

		return () => {
			if (scope === undefined) {
				const closure = new CacheClosureService(this.context);
				closure.assertWritable(cache);
				scope = {
					retentionEpoch: closure.epoch(cache),
					inheritedRetention: this.retention.rootRetentionResolver(cache)
				};
			}

			return scope;
		};
	}

	private writeRoot(
		cache: ResolvedCache,
		request: RootSetCommand,
		scope: RootWriteScope
	): StoredRoot {
		const closure = new CacheClosureService(this.context);
		const { retentionEpoch } = scope;
		const now = new Date();
		const nowIso = isoTimestamp(now);
		const resolvedRetention =
			request.retention.kind === 'inherit'
				? scope.inheritedRetention(request.name)
				: request.retention;
		const expiresAt = rootExpiry(resolvedRetention, now);
		const requested = new Set<string>(
			request.targets.map((target) => target.storePathHash)
		);

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
			const root: RootIncarnationKey = {
				cacheId: cache.id,
				name: request.name,
				incarnation:
					existing === undefined
						? allocateRootIncarnation(tx)
						: (existing.incarnation ?? undefined)
			};

			// A replacement gives each target that it releases a grace deadline, so
			// read the stored targets before the delete below discards them.
			const stored =
				existing === undefined ? [] : this.liveTargetRows(tx, root);
			const released = stored
				.map((target) => target.storePathHash)
				.filter((storePathHash) => !requested.has(storePathHash));
			const isTargetSetChanged = !isSameTargetSet(stored, request.targets);

			// Deleting or inserting a target row sets the cache's collection-input
			// flag. A cache that received an unchanged set at least once per minimum
			// scan interval would then never become current, and would be scanned
			// in every interval.
			if (isTargetSetChanged) {
				tx.delete(schema.retentionRootTargets)
					.where(liveRootTargets(root))
					.run();
			}
			if (existing === undefined) {
				tx.insert(schema.retentionRoots)
					.values({
						cacheId: cache.id,
						name: request.name,
						retentionEpoch,
						closeAppliedEpoch: retentionEpoch,
						expiresAt,
						createdAt: created,
						updatedAt: nowIso,
						incarnation: root.incarnation
					})
					.run();
			} else {
				// Each indexed column changed here rewrites its index entries, so set
				// only the columns whose values differ.
				tx.update(schema.retentionRoots)
					.set({
						...(existing.retentionEpoch !== retentionEpoch && {
							retentionEpoch
						}),
						...(existing.closeAppliedEpoch !== retentionEpoch && {
							closeAppliedEpoch: retentionEpoch
						}),
						...(existing.closeGraceUntil !== null && {
							closeGraceUntil: sql`NULL`
						}),
						...((existing.expiresAt ?? undefined) !== expiresAt && {
							expiresAt: expiresAt ?? sql`NULL`
						}),
						updatedAt: nowIso
					})
					.where(
						and(
							eq(schema.retentionRoots.cacheId, cache.id),
							eq(schema.retentionRoots.name, request.name)
						)
					)
					.run();
			}

			if (isTargetSetChanged) {
				insertLiveRootTargets(tx, this.retention, cache, root, request.targets);
			}

			// Applied inside the same transaction as the delete above: a crash
			// between the two could otherwise release these targets from the old
			// root's retention with no deadline ever established.
			const close =
				existing === undefined
					? undefined
					: closure.firstClose(cache, existing.retentionEpoch);
			if (close === undefined || existing === undefined) {
				this.retention.applyGraceTransition(cache, released, nowIso, tx);
			} else {
				this.retention.extendClosedRootGraceDeadlines(
					cache,
					released,
					{
						retentionEpoch: existing.retentionEpoch,
						retainUntil: close.graceUntil
					},
					tx
				);
			}

			return created;
		});

		return { expiresAt, createdAt, updatedAt: nowIso };
	}

	private liveTargetRows(
		database: SchemaWriter,
		root: RootIncarnationKey
	): readonly { storePathHash: StorePathHash; storePath: StorePathString }[] {
		return database
			.select({
				storePathHash: schema.retentionRootTargets.storePathHash,
				storePath: schema.retentionRootTargets.storePath
			})
			.from(schema.retentionRootTargets)
			.where(liveRootTargets(root))
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
		expected: ExpectedTargets
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
				const expectedIdentity = expected.identities.get(target.storePathHash);
				const currentRow = current.get(target.storePathHash);

				return (
					expectedIdentity === undefined ||
					currentRow?.generation !== expectedIdentity.generation ||
					currentRow.narHash !== expectedIdentity.narHash ||
					expected.demotions.wasDemoted(target.storePathHash)
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
			retention: body.retention
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
		expected?: ExpectedTargets
	): Promise<RootWrite> {
		return this.context.criticalSection((): Promise<RootWrite> =>
			Promise.resolve(
				this.checkedRootWrite(
					cache,
					requested,
					this.rootWriteScope(cache),
					expected
				)
			)
		);
	}

	// Call this only inside the write gate.
	private checkedRootWrite(
		cache: ResolvedCache,
		requested: RootSetCommand,
		scope: () => RootWriteScope,
		expected?: ExpectedTargets
	): RootWrite {
		const absent =
			expected === undefined
				? requested.targets
						.filter((target) => !this.rowPresent(cache, target.storePathHash))
						.map((target) => target.storePath)
				: this.mismatchedTargets(cache, requested.targets, expected);

		if (absent.length > 0) {
			return { kind: 'rejected', unavailable: absent };
		}

		return {
			kind: 'written',
			stored: this.writeRoot(cache, requested, scope())
		};
	}

	// Call this only inside the write gate. As with the single requests, an
	// ensure writes its root only when the probe found every target servable
	// and no target has changed since, and a set requires only a committed row
	// for each target.
	private batchedRootWrite(
		cache: ResolvedCache,
		request: BatchedRootRequest,
		scope: () => RootWriteScope,
		expected: ExpectedTargets
	): RootWrite {
		if (request.action === 'set') {
			return this.checkedRootWrite(cache, request.command, scope);
		}

		const unavailable = request.command.targets
			.filter((target) => !expected.identities.has(target.storePathHash))
			.map((target) => target.storePath);

		if (unavailable.length > 0) {
			return { kind: 'rejected', unavailable };
		}

		return this.checkedRootWrite(cache, request.command, scope, expected);
	}

	private batchResult(
		{ action, command }: BatchedRootRequest,
		write: RootWrite,
		servable: ReadonlySet<StorePathHash>
	): RootBatchResult {
		if (write.kind === 'written') {
			return {
				name: command.name,
				status: 'retained',
				root: this.rootSummaryFrom(
					command.name,
					write.stored,
					write.stored.updatedAt,
					command.targets,
					servable
				)
			};
		}

		if (action === 'ensure') {
			return {
				name: command.name,
				status: 'build-required',
				unavailable: [...write.unavailable]
			};
		}

		return {
			name: command.name,
			status: 'targets-unavailable',
			unavailable: [...write.unavailable]
		};
	}

	// Binding can extend an existing root's expiry without replacing targets or
	// releasing paths into grace. Commits add their paths as they finish. Every
	// publication in a run binds the root, so the expiry is rounded up to a whole
	// hour. Repeated binds leave the row unchanged while the bind time plus the
	// TTL stays within the same hour.
	bindRunRoot(
		cache: ResolvedCache,
		name: RootName,
		retention: RootRetentionRequest,
		database: SchemaWriter = this.context.db
	): void {
		const closure = new CacheClosureService(this.context);
		closure.assertWritable(cache);
		const retentionEpoch = closure.epoch(cache);
		const now = new Date();
		const nowIso = isoTimestamp(now);
		const resolvedRetention =
			retention.kind === 'inherit'
				? this.retention.resolveRootRetention(cache, name)
				: retention;
		const expiresAt =
			resolvedRetention.kind === 'permanent'
				? undefined
				: hourlyDeadline(now.getTime(), resolvedRetention.seconds);
		// Only a bind that creates the root allocates an incarnation, so repeated
		// binds do not write the work sequence.
		const isBound =
			existingRootIncarnationKey(database, cache.id, name) !== undefined;

		database
			.insert(schema.retentionRoots)
			.values({
				cacheId: cache.id,
				name,
				retentionEpoch,
				closeAppliedEpoch: retentionEpoch,
				expiresAt,
				createdAt: nowIso,
				updatedAt: nowIso,
				...(!isBound && { incarnation: allocateRootIncarnation(database) })
			})
			.onConflictDoUpdate({
				target: [schema.retentionRoots.cacheId, schema.retentionRoots.name],
				set: {
					// SQLite `max` returns NULL when either operand is NULL, so a
					// permanent root stays permanent. ISO-8601 UTC strings compare in
					// chronological order, so a shorter TTL cannot reduce the expiry.
					expiresAt: sql`CASE WHEN ${schema.retentionRoots.retentionEpoch} < ${retentionEpoch} THEN excluded.expires_at ELSE max(${schema.retentionRoots.expiresAt}, excluded.expires_at) END`,
					retentionEpoch,
					closeAppliedEpoch: retentionEpoch,
					closeGraceUntil: sql`NULL`,
					updatedAt: nowIso
				},
				setWhere: sql`${schema.retentionRoots.retentionEpoch} < ${retentionEpoch}
					OR ${schema.retentionRoots.closeAppliedEpoch} <> ${retentionEpoch}
					OR ${schema.retentionRoots.closeGraceUntil} IS NOT NULL
					OR (${schema.retentionRoots.expiresAt} IS NOT NULL AND (excluded.expires_at IS NULL OR excluded.expires_at > ${schema.retentionRoots.expiresAt}))`
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
		}[],
		database: SchemaWriter = this.context.db
	): void {
		const root = existingRootIncarnationKey(database, cache.id, name);

		if (root === undefined) {
			warnRootMissing({ cacheId: cache.id, name }, targets.length);

			return;
		}

		insertLiveRootTargets(database, this.retention, cache, root, targets);
	}

	// Replace the complete target set, including when it is empty. The root and
	// its resolved expiry remain, and released targets enter retention grace.
	async setRoot(
		cacheScope: CacheScope,
		rootName: RootName,
		body: RootSetBody
	): Promise<RootSetResponse> {
		const cache = await this.registration.forWrite(cacheScope);
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
		const cache = await this.registration.forWrite(cacheScope);
		const requested = this.buildRootSetCommand(rootName, body);
		const checked = await this.context.narInfoDemotions.watching(
			cache.id,
			requested.targets.map((target) => target.storePathHash),
			async (demotions): Promise<EnsureCheck> => {
				const identities = await this.servableTargetIdentities(
					cache,
					requested.targets
				);
				const unavailable = requested.targets
					.filter((target) => !identities.has(target.storePathHash))
					.map((target) => target.storePath);

				if (unavailable.length > 0) {
					return { kind: 'unavailable', unavailable };
				}

				const write = await this.gatedRootWrite(cache, requested, {
					identities,
					demotions
				});
				return { kind: 'checked', identities, write };
			}
		);

		if (checked.kind === 'unavailable') {
			return {
				status: 'build-required',
				unavailable: [...checked.unavailable]
			};
		}

		const { identities, write } = checked;

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

	// Apply each entry as the single set or ensure request for its root would.
	// The batch resolves the cache once, probes every target in one pass and
	// writes every root under one write gate, so the probe's fixed calls and the
	// request's own overhead are shared by all of its roots.
	async applyRoots(
		cacheScope: CacheScope,
		body: RootBatchBody
	): Promise<RootBatchResponse> {
		const cost = body.roots.reduce(
			(total, entry) => total + rootBatchEntryCost(entry),
			0
		);

		if (cost > rootBatchCapacity) {
			throw new RootBatchLimitExceededError(rootBatchCapacity);
		}

		const cache = await this.registration.forWrite(cacheScope);
		const requests = body.roots.map((entry): BatchedRootRequest => ({
			action: entry.action,
			command: this.buildRootSetCommand(entry.name, entry)
		}));
		const targets = requests.flatMap(({ command }) => command.targets);
		const { identities, writes } = await this.context.narInfoDemotions.watching(
			cache.id,
			targets.map((target) => target.storePathHash),
			async (demotions) => {
				const identities = await this.servableTargetIdentities(cache, targets);
				const writes = await this.context.criticalSection(() => {
					const scope = this.rootWriteScope(cache);

					return Promise.resolve(
						requests.map((request) => ({
							request,
							write: this.batchedRootWrite(cache, request, scope, {
								identities,
								demotions
							})
						}))
					);
				});

				return { identities, writes };
			}
		);
		const servable = new Set(identities.keys());

		return {
			roots: writes.map(({ request, write }) =>
				this.batchResult(request, write, servable)
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
				expiresAt: new CacheClosureService(this.context).effectiveRootExpiry(),
				createdAt: schema.retentionRoots.createdAt,
				updatedAt: schema.retentionRoots.updatedAt,
				targetCount: liveRootTargetCount()
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
		const root = rootIncarnationKey(this.context.db, cache.id, name);
		const rows = this.context.db
			.select({
				storePathHash: schema.retentionRootTargets.storePathHash,
				storePath: schema.retentionRootTargets.storePath
			})
			.from(schema.retentionRootTargets)
			.where(
				and(
					liveRootTargets(root),
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

		const released = this.liveTargetRows(
			this.context.db,
			rootIncarnationKey(this.context.db, cache.id, name)
		).map((target) => target.storePathHash);
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
					liveRootTargets({
						cacheId: cache.id,
						name,
						incarnation: existing?.incarnation ?? undefined
					})
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
			const close =
				existing === undefined
					? undefined
					: new CacheClosureService(this.context).firstClose(
							cache,
							existing.retentionEpoch
						);
			if (close === undefined || existing === undefined) {
				this.retention.applyGraceTransition(cache, released, nowIso, tx);
			} else {
				this.retention.extendClosedRootGraceDeadlines(
					cache,
					released,
					{
						retentionEpoch: existing.retentionEpoch,
						retainUntil: close.graceUntil
					},
					tx
				);
			}

			return { name, removed: existing !== undefined };
		});
	}
}
