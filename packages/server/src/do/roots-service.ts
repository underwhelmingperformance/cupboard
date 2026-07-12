import {
	type NixSha256HashString,
	type RootName,
	type StorePathHash,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, resolveRootTargets } from '@cupboard/nix-store/store-path';
import {
	type ParsedRootSetBody,
	type RootEnsureResponse,
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

// A narinfo row's exact version, snapshotted off-gate so a gated re-check can
// tell an unchanged row from one a delete-and-recommit replaced.
interface TargetIdentity {
	readonly generation: number;
	readonly narHash: NixSha256HashString;
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

		const missing = hashes.filter((hash) => !servable.has(hash));

		if (missing.length === 0) {
			return servable;
		}

		// Settle every missing target's committed-ness in one chunked D1 read, so
		// only a genuinely committed target falls through to the gated heal. The
		// same edges thread into that heal, sparing it a per-path committed read.
		const rows = this.narInfoObjects.narInfoRowsFor(cache, missing);
		const committedEdges = await this.narInfoObjects.committedReferenceEdges(
			cache,
			missing
		);
		const committed = this.narInfoObjects.committedReferencesFrom(
			committedEdges,
			rows
		);

		for (const hash of missing) {
			if (!committed.has(hash)) {
				continue;
			}

			if (await this.narInfoObjects.isServable(cache, hash, committedEdges)) {
				servable.add(hash);
			}
		}

		return servable;
	}

	// The exact identity behind each of `targets` that {@link servableTargets}
	// finds servable, snapshotted synchronously before that probe's R2 heads and
	// D1 reads run. `ensureRoot` revalidates this snapshot inside the write gate,
	// so a delete-and-recommit landing during the probe cannot be answered
	// `retained`: a hash whose row is gone by snapshot time is excluded here the
	// same as one that never had a row.
	private async servableTargetIdentities(
		cache: string,
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

	// The store paths among `targets` whose current row no longer matches the
	// identity `servableTargetIdentities` snapshotted off-gate: the row is gone,
	// or a recommit changed its generation or narHash. A synchronous DO SQLite
	// read, so this settles inside the same critical section as the write it
	// gates.
	private mismatchedTargets(
		cache: string,
		targets: readonly {
			storePathHash: StorePathHash;
			storePath: StorePathString;
		}[],
		expected: ReadonlyMap<StorePathHash, TargetIdentity>
	): readonly string[] {
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

	private buildRootSetCommand(
		rootName: RootName,
		body: ParsedRootSetBody
	): RootSetCommand {
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
		cache: string,
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

	async setRoot(
		cache: string,
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
		cache: string,
		rootName: RootName,
		body: ParsedRootSetBody
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

	// Drops a store path from every retention root's target set. A deferred upload
	// that fails verification can never become servable, so a root must stop
	// advertising it; the next push over that root rewrites its targets wholesale.
	// One delete on the single writer, so it needs no gate.
	pruneRetentionTargets(cache: string, storePathHash: StorePathHash): void {
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
