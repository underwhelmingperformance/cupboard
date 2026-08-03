import {
	type NixSha256HashString,
	type RootName,
	type StoredCache,
	type StorePathHash,
	type StorePathString,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, resolveRootTargets } from '@cupboard/nix-store/store-path';
import {
	type ParsedRootEnsureBody,
	type ParsedRootSetBody,
	type RootEnsureResponse,
	rootListPageSize,
	type RootListResponse,
	type RootRemoveResponse,
	type RootSetResponse,
	type RootSummary,
	type RootTargetsPage
} from '@cupboard/protocol/retention';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { chunk } from '@cupboard/shared/collections';
import { and, eq, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import { RootTargetsUnavailableError } from '../errors.ts';
import { coldPathTtlSeconds, resolveRootExpiry } from '../policy/cold-path.ts';
import { requireServedStorePaths } from '../policy/served-store.ts';

import { type CacheAdminService } from './cache-admin-service.ts';
import { type RootSetCommand, type ServerContext } from './context.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { type RetentionService } from './retention-service.ts';

interface StoredRoot {
	readonly expiresAt: IsoTimestamp | undefined;
	readonly createdAt: IsoTimestamp;
	readonly updatedAt: IsoTimestamp;
}

// Each target contributes four values to its INSERT. Cloudflare SQLite admits
// at most 100 bound parameters per query.
export const maxRootTargetInsertRows = 25;

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

export class RootsService {
	constructor(
		private readonly context: ServerContext,
		private readonly cacheAdmin: CacheAdminService,
		private readonly retention: RetentionService,
		private readonly narInfoObjects: NarInfoObjectsService
	) {}

	private writeRoot(cache: StoredCache, request: RootSetCommand): StoredRoot {
		const now = new Date();
		const nowIso = isoTimestamp(now);
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

		// The targets the replacement releases receive a grace deadline, so they
		// are read before the wholesale delete below discards them.
		const requested = new Set<string>(
			request.targets.map((target) => target.storePathHash)
		);
		const released = this.rootTargetRows(cache, request.name)
			.map((target) => target.storePathHash)
			.filter((storePathHash) => !requested.has(storePathHash));

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

			for (const targets of chunk(request.targets, maxRootTargetInsertRows)) {
				tx.insert(schema.retentionRootTargets)
					.values(
						targets.map((target) => ({
							cache,
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
		cache: StoredCache,
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
	// read path uses.
	private async servableTargets(
		cache: StoredCache,
		targets: readonly { storePathHash: StorePathHash }[]
	): Promise<ReadonlySet<StorePathHash>> {
		return this.narInfoObjects.servableStorePathHashes(
			cache,
			targets.map((target) => target.storePathHash)
		);
	}

	// The exact identity behind each of `targets` that {@link servableTargets}
	// finds servable, snapshotted synchronously before that probe's R2 heads and
	// D1 reads run. `ensureRoot` revalidates this snapshot inside the write gate,
	// so a delete-and-recommit landing during the probe cannot be answered
	// `retained`: a hash whose row is gone by snapshot time is excluded here the
	// same as one that never had a row.
	private async servableTargetIdentities(
		cache: StoredCache,
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

	// Whether a committed narinfo row still exists for this path, a synchronous DO
	// SQLite read. A delete is row-first and runs under the gate, so a row still
	// present inside the write gate cannot be mid-delete; this is the cheap
	// re-check that lets the expensive serve probe run outside the gate.
	private rowPresent(
		cache: StoredCache,
		storePathHash: StorePathHash
	): boolean {
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

	// The store paths among `targets` whose current row no longer matches the
	// identity `servableTargetIdentities` snapshotted off-gate: the row is gone,
	// or a recommit changed its generation or narHash. A synchronous DO SQLite
	// read, so this settles inside the same critical section as the write it
	// gates.
	private mismatchedTargets(
		cache: StoredCache,
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

	// Every root write starts here, so this is where a submitted target is held
	// to the store directory the cache serves: a root over a path from another
	// store could never be satisfied by anything this cache can serve.
	private buildRootSetCommand(
		rootName: RootName,
		body: ParsedRootSetBody
	): RootSetCommand {
		requireServedStorePaths(body.targets);

		return {
			name: rootName,
			targets: resolveRootTargets(body.targets),
			ttlSeconds: body.ttlSeconds
		};
	}

	// A root may reference any target whose narinfo row exists: reserved at
	// commit, committed, or servable. A push records retention over a path that
	// is still verifying, and the path becomes servable when the verify pass
	// materialises it (`present` reflects that, staying false until then).
	// `servableTargets` heals a merely-lost object and drives the per-target
	// `present` flag; its R2 heads run outside this gate. Without
	// `expectedIdentities` (the `setRoot` path) the gate rejects only a target
	// with no narinfo row (never uploaded, or deleted): a synchronous row read
	// that, since a delete is row-first and runs under the gate, cannot
	// interleave with one. With `expectedIdentities` (the `ensureRoot` path)
	// the gate additionally refuses a target whose row's generation or narHash
	// has moved on from the snapshot the caller took off-gate, so a
	// delete-and-recommit landing during that probe cannot be answered
	// `retained` for content the probe never actually verified. The section
	// returns a rejected outcome rather than throwing, so the caller decides
	// how to report it once the gate has closed: a validation error surfaced
	// only after the section does not reset the Durable Object.
	private async gatedRootWrite(
		cache: StoredCache,
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

	// Binds a push's run root at negotiate: created on the push's first
	// negotiate, extended forward-only after that. The run root accretes and is
	// never replaced, so nothing is released, no grace transition runs, and no
	// target list is touched; committed paths join it as their commits finalise.
	// The expiry resolves through the same precedence a root write uses: the
	// explicit TTL, then a matching retention policy, then the cold-path default
	// for an implicit pin, otherwise permanent. A single upsert on the single
	// writer, so it needs no gate.
	bindRunRoot(
		cache: StoredCache,
		name: RootName,
		explicitTtlSeconds: TtlSeconds | undefined
	): void {
		const now = new Date();
		const nowIso = isoTimestamp(now);
		const expiresAt = resolveRootExpiry({
			explicitTtlSeconds,
			policyTtlSeconds: this.retention.resolvePolicyTtl(cache, name),
			name,
			coldPathTtlSeconds: coldPathTtlSeconds(this.context.env),
			now
		});

		this.cacheAdmin.loadOrCreateCache(cache);

		this.context.db
			.insert(schema.retentionRoots)
			.values({
				cache,
				name,
				expiresAt,
				createdAt: nowIso,
				updatedAt: nowIso
			})
			.onConflictDoUpdate({
				target: [schema.retentionRoots.cache, schema.retentionRoots.name],
				set: {
					// SQL `max` answers NULL when either side is NULL, which reads a
					// permanent expiry as the latest possible one in both directions;
					// over ISO-8601 UTC strings it is chronological, so a shorter TTL
					// never truncates what an earlier negotiate established.
					expiresAt: sql`max(${schema.retentionRoots.expiresAt}, excluded.expires_at)`,
					updatedAt: nowIso
				}
			})
			.run();
	}

	// Attaches already-served paths to a push's run root at negotiate. A path
	// the cache already serves is answered as a skip, a publication that
	// settles with no commit, so the root gains it here through the same
	// additive, idempotent insert the commit gate applies, keyed by cache,
	// root and store-path hash. Nothing is released, no grace transition runs
	// and the root row is untouched. Chunked inserts on the single writer, so
	// it needs no gate.
	attachRunRootTargets(
		cache: StoredCache,
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
						cache,
						rootName: name,
						storePathHash: target.storePathHash,
						storePath: target.storePath
					}))
				)
				.onConflictDoNothing()
				.run();
		}
	}

	// Replaces a root's contents with exactly what the caller declares. An
	// empty declaration is a replacement like any other: the target rows go,
	// the root row and its resolved expiry stay, and every released target
	// takes the grace a replaced generation takes.
	async setRoot(
		cache: StoredCache,
		rootName: RootName,
		body: ParsedRootSetBody
	): Promise<RootSetResponse> {
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
		cache: StoredCache,
		rootName: RootName,
		body: ParsedRootEnsureBody
	): Promise<RootEnsureResponse> {
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

	// The listing summarises: counted in SQLite and keyset-paginated by name, it
	// reads no target rows and probes nothing in R2, so a tenant whose run
	// roots have accreted thousands of paths lists them in bounded pages. A
	// root's targets are read through {@link rootTargets}.
	listRoots(
		cache: StoredCache,
		options: { readonly cursor?: string; readonly limit?: number } = {}
	): RootListResponse {
		const limit = Math.min(options.limit ?? rootListPageSize, rootListPageSize);
		const now = isoTimestamp(new Date());
		const rows = this.context.db
			.select({
				name: schema.retentionRoots.name,
				expiresAt: schema.retentionRoots.expiresAt,
				createdAt: schema.retentionRoots.createdAt,
				updatedAt: schema.retentionRoots.updatedAt,
				targetCount: sql<number>`(select count(*) from ${schema.retentionRootTargets} where ${schema.retentionRootTargets.cache} = ${schema.retentionRoots.cache} and ${schema.retentionRootTargets.rootName} = ${schema.retentionRoots.name})`
			})
			.from(schema.retentionRoots)
			.where(
				and(
					eq(schema.retentionRoots.cache, cache),
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

	// One page of a root's targets, keyset-paginated by store-path hash. The
	// serve probe runs per page, so the page bound also bounds the per-target
	// probe fan-out an unbounded run root would otherwise fan out in one
	// request. An unknown root reads as a root with no targets.
	async rootTargets(
		cache: StoredCache,
		name: RootName,
		options: { readonly cursor?: string; readonly limit?: number } = {}
	): Promise<RootTargetsPage> {
		const limit = Math.min(options.limit ?? rootListPageSize, rootListPageSize);
		const rows = this.context.db
			.select({
				storePathHash: schema.retentionRootTargets.storePathHash,
				storePath: schema.retentionRootTargets.storePath
			})
			.from(schema.retentionRootTargets)
			.where(
				and(
					eq(schema.retentionRootTargets.cache, cache),
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

	removeRoot(cache: StoredCache, name: RootName): RootRemoveResponse {
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

			// Applied inside the same transaction as the delete above: a crash
			// between the two could otherwise release these targets with no
			// deadline ever established.
			this.retention.applyGraceTransition(cache, released, nowIso, tx);

			return { name, removed: existing !== undefined };
		});
	}

	// Drops a store path from every retention root's target set. A deferred upload
	// that fails verification can never become servable, so a root must stop
	// advertising it; the next push over that root rewrites its targets wholesale.
	// One delete on the single writer, so it needs no gate.
	pruneRetentionTargets(
		cache: StoredCache,
		storePathHash: StorePathHash
	): void {
		this.context.db
			.delete(schema.retentionRootTargets)
			.where(
				and(
					eq(schema.retentionRootTargets.cache, cache),
					eq(schema.retentionRootTargets.storePathHash, storePathHash)
				)
			)
			.run();
	}
}
