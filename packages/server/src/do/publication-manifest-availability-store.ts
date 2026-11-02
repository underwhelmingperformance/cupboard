import { and, eq, type SQL, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';

import type { SchemaDatabase } from './context.ts';
import { isRowBudgetExhausted } from './row-budget.ts';

export type PublicationManifestAvailabilityVersion = Pick<
	typeof schema.publicationManifestAvailabilityRevisions.$inferSelect,
	| 'cacheId'
	| 'cacheGeneration'
	| 'storePathHash'
	| 'generation'
	| 'storePath'
	| 'narHash'
>;
export type PublicationManifestAvailabilityIntent =
	typeof schema.publicationManifestAvailabilityIntents.$inferSelect;

export type PublicationManifestLifecycleIntent =
	typeof schema.publicationManifestLifecycleIntents.$inferSelect;

export interface PublicationManifestAvailabilitySnapshot {
	/**
	Global observation stamp, persisted on private destination proofs.
	*/
	readonly revision: number;
	readonly pathRevision: number;
	/**
	Conservative in-flight observation fence only; never revokes stored proofs.
	*/
	readonly lifecycleRevision: number;
	readonly unresolved: boolean;
}

export interface PublicationManifestAvailabilityDrainPage {
	readonly processed: number;
	readonly remaining: boolean;
}

function versionPredicate(
	version: PublicationManifestAvailabilityVersion
): SQL {
	return sql`cache_id = ${version.cacheId} AND cache_generation = ${version.cacheGeneration}
 AND store_path_hash = ${version.storePathHash} AND generation = ${version.generation}
 AND store_path = ${version.storePath} AND nar_hash = ${version.narHash}`;
}

/** Synchronous local SQLite transitions only. Call begin before remote I/O;
acknowledge only a known remote outcome (including an established no-op).
An ambiguous outcome must retain its original intent, including across reset.
All staging must revalidate the captured snapshot in its insertion transaction. */
export class PublicationManifestAvailabilityStore {
	constructor(private readonly database: SchemaDatabase) {}

	/** Releasing pending work changes GC liveness even for an unselected candidate.
	Use the transitioned owner; terminal replays must not dirty inputs. */
	private failPendingOperation(
		id: string,
		cache: Pick<
			PublicationManifestAvailabilityVersion,
			'cacheId' | 'cacheGeneration'
		>,
		reason: 'generation-conflict' | 'scope-changed'
	): void {
		const operation = this.database
			.all<{ cacheId: PublicationManifestAvailabilityVersion['cacheId'] }>(
				sql`UPDATE publication_manifest_operation SET state = 'failed', failure_json = ${JSON.stringify({ kind: 'failed', reason })}
			WHERE id = ${id} AND cache_id = ${cache.cacheId} AND cache_generation = ${cache.cacheGeneration} AND state = 'pending'
			RETURNING cache_id AS cacheId`
			)
			.at(0);
		if (operation === undefined) {
			return;
		}
		this.database.run(
			sql`UPDATE garbage_collection_input SET inputs_changed = 1 WHERE cache_id = ${operation.cacheId}`
		);
	}

	private clock(): typeof schema.publicationManifestAvailabilityClock.$inferSelect {
		const clock = this.database
			.select()
			.from(schema.publicationManifestAvailabilityClock)
			.where(eq(schema.publicationManifestAvailabilityClock.id, 1))
			.get();
		if (clock === undefined) {
			throw new Error('Publication manifest availability clock is missing');
		}
		return clock;
	}

	private finishIntent(intent: PublicationManifestAvailabilityIntent): void {
		this.database.run(
			sql`DELETE FROM publication_manifest_availability_intent WHERE revision = ${intent.revision} AND NOT remote_pending`
		);
		// Reclaim per-version state only when every mutation of it has finished.
		// The monotone singleton clock prevents absent-row ABA after reclamation.
		this.database
			.run(sql`DELETE FROM publication_manifest_availability_revision WHERE ${versionPredicate(intent)}
		 AND NOT EXISTS (SELECT 1 FROM publication_manifest_availability_intent INDEXED BY publication_manifest_availability_intent_version_idx WHERE ${versionPredicate(intent)} LIMIT 1)`);
		if (intent.kind === 'local' || intent.kind === 'local-replace') {
			this.database
				.run(sql`DELETE FROM publication_manifest_local_identity WHERE cache_id = ${intent.cacheId} AND store_path_hash = ${intent.storePathHash}
			 AND generation = ${intent.generation} AND store_path = ${intent.storePath} AND nar_hash = ${intent.narHash}
			 AND NOT EXISTS (SELECT 1 FROM narinfo WHERE cache_id = ${intent.cacheId} AND store_path_hash = ${intent.storePathHash})`);
		}
	}

	/** Actual REPLACE also invalidates incompatible historical snapshots. Read raw
	index pages before comparing versions; never filter through an unbounded range. */
	private drainReplacementPage(
		intent: PublicationManifestAvailabilityIntent
	): PublicationManifestAvailabilityDrainPage {
		const table = schema.publicationManifestAvailabilityIntents;
		if (intent.phase === 'owners') {
			const after =
				intent.cursorOwnerGeneration === null
					? sql``
					: sql`AND result_generation > ${intent.cursorOwnerGeneration}`;
			const owners = this.database.all<{
				generation: typeof intent.generation;
				path: string;
				narHash: string;
			}>(sql`SELECT result_generation AS generation,result_path AS path,result_nar_hash AS narHash FROM result_publication
			 WHERE cache_id = ${intent.cacheId} AND cache_generation = ${intent.cacheGeneration} AND result_hash = ${intent.storePathHash} ${after} ORDER BY result_generation LIMIT 64`);
			for (const owner of owners) {
				if (
					owner.generation === intent.replacementGeneration &&
					owner.path === intent.replacementPath &&
					owner.narHash === intent.replacementNarHash
				) {
					continue;
				}
				this.database.run(
					sql`DELETE FROM result_publication WHERE cache_id = ${intent.cacheId} AND cache_generation = ${intent.cacheGeneration} AND result_hash = ${intent.storePathHash} AND result_generation = ${owner.generation}
					AND NOT EXISTS (SELECT 1 FROM narinfo n JOIN cache_identity c ON c.id = n.cache_id
					 WHERE n.cache_id = ${intent.cacheId} AND c.generation = ${intent.cacheGeneration} AND c.deleted_at IS NULL AND n.store_path_hash = ${intent.storePathHash}
					 AND n.generation = ${owner.generation} AND n.store_path = ${owner.path} AND n.nar_hash = ${owner.narHash})`
				);
			}
			if (owners.length === 64) {
				this.database
					.update(table)
					.set({ cursorOwnerGeneration: owners.at(-1)?.generation })
					.where(eq(table.revision, intent.revision))
					.run();
				return { processed: owners.length, remaining: true };
			}
			this.finishIntent(intent);
			return { processed: owners.length, remaining: false };
		}
		const after =
			intent.cursorMaterialisationId === null
				? sql``
				: sql`AND (member_generation,member_path,member_nar_hash,materialisation_id) > (${intent.cursorMemberGeneration},${intent.cursorMemberPath},${intent.cursorMemberNarHash},${intent.cursorMaterialisationId})`;
		const edges = this.database.all<{
			generation: typeof intent.generation;
			path: typeof intent.storePath;
			narHash: typeof intent.narHash;
			materialisationId: string;
		}>(sql`SELECT member_generation AS generation,member_path AS path,member_nar_hash AS narHash,materialisation_id AS materialisationId
		 FROM result_publication_member INDEXED BY result_publication_member_reverse_idx
		 WHERE cache_id = ${intent.cacheId} AND cache_generation = ${intent.cacheGeneration} AND member_hash = ${intent.storePathHash} ${after}
		 ORDER BY member_generation,member_path,member_nar_hash,materialisation_id LIMIT 64`);
		for (const edge of edges) {
			if (
				edge.generation === intent.replacementGeneration &&
				edge.path === intent.replacementPath &&
				edge.narHash === intent.replacementNarHash
			) {
				continue;
			}
			const proof = this.database
				.all<{
					resultHash: string;
					resultGeneration: number;
					availabilityRevision: number;
				}>(
					sql`SELECT result_hash AS resultHash,result_generation AS resultGeneration,availability_revision AS availabilityRevision
			 FROM result_publication_member INDEXED BY result_publication_member_candidate_path_idx WHERE materialisation_id = ${edge.materialisationId} AND member_path = ${edge.path} LIMIT 1`
				)
				.at(0);
			if (proof === undefined) {
				throw new Error('Replacement reverse edge disappeared during drain');
			}
			if (proof.availabilityRevision >= intent.revision) {
				continue;
			}
			this.database
				.run(sql`UPDATE result_publication SET complete = 0 WHERE cache_id = ${intent.cacheId} AND cache_generation = ${intent.cacheGeneration}
			 AND result_hash = ${proof.resultHash} AND result_generation = ${proof.resultGeneration} AND materialisation_id = ${edge.materialisationId} AND complete`);
			this.failPendingOperation(
				edge.materialisationId,
				intent,
				'generation-conflict'
			);
		}
		const last = edges.at(-1);
		this.database
			.update(table)
			.set({
				cursorMaterialisationId:
					last?.materialisationId ?? intent.cursorMaterialisationId,
				cursorMemberGeneration:
					last?.generation ?? intent.cursorMemberGeneration,
				cursorMemberPath: last?.path ?? intent.cursorMemberPath,
				cursorMemberNarHash: last?.narHash ?? intent.cursorMemberNarHash,
				phase: edges.length === 64 ? 'proofs' : 'owners'
			})
			.where(eq(table.revision, intent.revision))
			.run();
		return { processed: edges.length, remaining: true };
	}

	/** Recovery must use this exact-version fence before retrying remote work,
 plus the remote object's existing generation/object fence. */
	isAccepted(version: PublicationManifestAvailabilityVersion): boolean {
		return (
			this.database
				.all(sql`SELECT 1 FROM narinfo n JOIN cache_identity c ON c.id = n.cache_id
   WHERE n.cache_id = ${version.cacheId} AND c.generation = ${version.cacheGeneration} AND c.deleted_at IS NULL
   AND n.store_path_hash = ${version.storePathHash} AND n.generation = ${version.generation}
   AND n.store_path = ${version.storePath} AND n.nar_hash = ${version.narHash} LIMIT 1`)
				.length > 0
		);
	}

	/** No accepted identities or generations are created or changed here.
 A repeat is a new mutation, with its own monotone revision and fresh cursor. */
	begin(
		version: PublicationManifestAvailabilityVersion,
		kind: Exclude<
			PublicationManifestAvailabilityIntent['kind'],
			'local' | 'local-replace'
		>
	): PublicationManifestAvailabilityIntent | undefined {
		return this.database.transaction(() => {
			if (!this.isAccepted(version)) {
				return;
			}
			this.database.run(
				sql`UPDATE publication_manifest_availability_clock SET revision = revision + 1 WHERE id = 1`
			);
			const revision = this.clock().revision;
			this.database
				.insert(schema.publicationManifestAvailabilityRevisions)
				.values({ ...version, revision })
				.onConflictDoUpdate({
					target: [
						schema.publicationManifestAvailabilityRevisions.cacheId,
						schema.publicationManifestAvailabilityRevisions.cacheGeneration,
						schema.publicationManifestAvailabilityRevisions.storePathHash,
						schema.publicationManifestAvailabilityRevisions.generation,
						schema.publicationManifestAvailabilityRevisions.storePath,
						schema.publicationManifestAvailabilityRevisions.narHash
					],
					set: { revision }
				})
				.run();
			this.database
				.insert(schema.publicationManifestAvailabilityIntents)
				.values({ ...version, revision, kind })
				.run();
			return this.getIntent(revision);
		});
	}

	snapshot(
		version: PublicationManifestAvailabilityVersion
	): PublicationManifestAvailabilitySnapshot {
		const row = this.database
			.all<{ revision: number }>(
				sql`SELECT revision FROM publication_manifest_availability_revision WHERE ${versionPredicate(version)}`
			)
			.at(0);
		const hasUnresolvedMutation =
			this.database.all(
				sql`SELECT 1 FROM publication_manifest_availability_intent INDEXED BY publication_manifest_availability_intent_version_idx WHERE ${versionPredicate(version)} AND remote_pending = 1 LIMIT 1`
			).length > 0;
		const clock = this.clock();
		return {
			revision: clock.revision,
			pathRevision: row?.revision ?? 0,
			lifecycleRevision: clock.lifecycleRevision,
			unresolved: hasUnresolvedMutation
		};
	}

	isCurrent(
		version: PublicationManifestAvailabilityVersion,
		observed: PublicationManifestAvailabilitySnapshot
	): boolean {
		if (observed.unresolved) {
			return false;
		}
		const current = this.snapshot(version);
		if (
			current.unresolved ||
			current.pathRevision !== observed.pathRevision ||
			current.lifecycleRevision !== observed.lifecycleRevision
		) {
			return false;
		}
		// Reclaimed per-path metadata cannot resurrect an older absent-row snapshot.
		// This deliberately conservatively fences other mutations for absent rows.
		return current.pathRevision !== 0 || current.revision === observed.revision;
	}

	getIntent(
		revision: number
	): PublicationManifestAvailabilityIntent | undefined {
		return this.database
			.select()
			.from(schema.publicationManifestAvailabilityIntents)
			.where(
				eq(schema.publicationManifestAvailabilityIntents.revision, revision)
			)
			.get();
	}

	/** Indexed discovery for alarm continuation and separately for remote recovery.
 Undefined discovers either state; false is locally drainable work. */
	nextIntent(
		hasRemotePending?: boolean
	): PublicationManifestAvailabilityIntent | undefined {
		const table = schema.publicationManifestAvailabilityIntents;
		return this.database
			.select()
			.from(table)
			.where(
				hasRemotePending === undefined
					? undefined
					: eq(table.remotePending, hasRemotePending)
			)
			.orderBy(table.revision)
			.limit(1)
			.get();
	}

	/**
	A per-cache temporary certificate/finalisation barrier, not a member scan.
	*/
	hasPending(
		cache: Pick<
			PublicationManifestAvailabilityVersion,
			'cacheId' | 'cacheGeneration'
		>
	): boolean {
		return (
			this.database.all(
				sql`SELECT 1 FROM (SELECT 1 FROM publication_manifest_availability_intent INDEXED BY publication_manifest_availability_intent_version_idx WHERE cache_id = ${cache.cacheId} AND cache_generation = ${cache.cacheGeneration} UNION ALL SELECT 1 FROM publication_manifest_lifecycle_intent INDEXED BY publication_manifest_lifecycle_intent_scope_idx WHERE cache_id = ${cache.cacheId} AND cache_generation = ${cache.cacheGeneration}) LIMIT 1`
			).length > 0
		);
	}

	acknowledge(revision: number): void {
		const table = schema.publicationManifestAvailabilityIntents;
		this.database
			.update(table)
			.set({ remotePending: false })
			.where(and(eq(table.revision, revision), eq(table.remotePending, true)))
			.run();
	}

	/** At most 64 raw reverse edges (or replacement owner rows), including
 already healthy/newer proofs.
 The covering reverse seek never filters past a fan-in range or uses OFFSET.
 Candidate/path uniqueness makes materialisation_id a complete cursor for one
 exact path. One indexed candidate/path lookup reads each proof's revision.
 No immutable membership/proof is removed; only the selected certificate and
 its matching pending candidate can be invalidated. */
	drainPage(revision: number): PublicationManifestAvailabilityDrainPage {
		return this.database.transaction(() => {
			const intent = this.getIntent(revision);
			if (intent === undefined) {
				return { processed: 0, remaining: false };
			}
			if (intent.kind === 'local-replace') {
				return this.drainReplacementPage(intent);
			}
			const after =
				intent.cursorMaterialisationId === null
					? sql``
					: sql`AND materialisation_id > ${intent.cursorMaterialisationId}`;
			const edges = this.database.all<{
				materialisationId: string;
			}>(sql`SELECT materialisation_id AS materialisationId
    FROM result_publication_member INDEXED BY result_publication_member_reverse_idx
    WHERE cache_id = ${intent.cacheId} AND cache_generation = ${intent.cacheGeneration}
    AND member_hash = ${intent.storePathHash} AND member_generation = ${intent.generation}
    AND member_path = ${intent.storePath} AND member_nar_hash = ${intent.narHash}
    ${after} ORDER BY materialisation_id LIMIT 64`);
			for (const edge of edges) {
				const proof = this.database
					.all<{
						resultHash: string;
						resultGeneration: number;
						availabilityRevision: number;
					}>(
						sql`SELECT result_hash AS resultHash, result_generation AS resultGeneration, availability_revision AS availabilityRevision
                FROM result_publication_member INDEXED BY result_publication_member_candidate_path_idx
                WHERE materialisation_id = ${edge.materialisationId} AND member_path = ${intent.storePath} LIMIT 1`
					)
					.at(0);
				if (proof === undefined) {
					throw new Error('Availability reverse edge disappeared during drain');
				}
				if (proof.availabilityRevision >= intent.revision) {
					continue;
				}
				this.database
					.run(sql`UPDATE result_publication SET complete = 0 WHERE cache_id = ${intent.cacheId}
     AND cache_generation = ${intent.cacheGeneration} AND result_hash = ${proof.resultHash}
     AND result_generation = ${proof.resultGeneration} AND materialisation_id = ${edge.materialisationId} AND complete`);
				this.failPendingOperation(
					edge.materialisationId,
					intent,
					'generation-conflict'
				);
			}
			const last = edges.at(-1);
			if (last !== undefined) {
				this.database
					.update(schema.publicationManifestAvailabilityIntents)
					.set({
						cursorMaterialisationId: last.materialisationId
					})
					.where(
						eq(schema.publicationManifestAvailabilityIntents.revision, revision)
					)
					.run();
			}
			if (edges.length === 64 || intent.remotePending) {
				return { processed: edges.length, remaining: true };
			}
			this.finishIntent(intent);
			return { processed: edges.length, remaining: false };
		});
	}

	/** Lifecycle work is local-only and scoped by a real identity and generation.
	No synthetic path version is exposed to remote recovery. */
	nextLifecycleIntent(): PublicationManifestLifecycleIntent | undefined {
		return this.database
			.select()
			.from(schema.publicationManifestLifecycleIntents)
			.orderBy(schema.publicationManifestLifecycleIntents.revision)
			.limit(1)
			.get();
	}

	/** Retire at most 64 raw associations OR visit at most 64 raw operations.
	Association deletion enqueues existing bounded private/portable retirement.
	Operations retain their receipts/holds; ordinary expiry/cleanup owns removal.
	Only a lifecycle transition enqueues this work: current incomplete selections
	in other accepted generations remain GC edges, independent of completeness. */
	drainLifecyclePage(
		revision: number
	): PublicationManifestAvailabilityDrainPage {
		return this.database.transaction(() => {
			const table = schema.publicationManifestLifecycleIntents;
			const intent = this.database
				.select()
				.from(table)
				.where(eq(table.revision, revision))
				.get();
			if (intent === undefined) {
				return { processed: 0, remaining: false };
			}
			if (intent.phase === 'associations') {
				const after =
					intent.cursorResultHash === null
						? sql``
						: sql`AND (result_hash,result_generation) > (${intent.cursorResultHash},${intent.cursorResultGeneration})`;
				const rows = this.database.all<{
					resultHash: typeof schema.resultPublications.$inferSelect.resultHash;
					resultGeneration: typeof schema.resultPublications.$inferSelect.resultGeneration;
				}>(sql`SELECT result_hash AS resultHash,result_generation AS resultGeneration FROM result_publication
				 WHERE cache_id = ${intent.cacheId} AND cache_generation = ${intent.cacheGeneration} ${after}
				 ORDER BY result_hash,result_generation LIMIT 64`);
				for (const row of rows) {
					this.database.run(
						sql`DELETE FROM result_publication WHERE cache_id = ${intent.cacheId} AND cache_generation = ${intent.cacheGeneration} AND result_hash = ${row.resultHash} AND result_generation = ${row.resultGeneration}`
					);
				}
				const last = rows.at(-1);
				this.database
					.update(table)
					.set({
						cursorResultHash: last?.resultHash ?? intent.cursorResultHash,
						cursorResultGeneration:
							last?.resultGeneration ?? intent.cursorResultGeneration,
						phase: rows.length === 64 ? 'associations' : 'operations'
					})
					.where(eq(table.revision, revision))
					.run();
				return { processed: rows.length, remaining: true };
			}
			const after =
				intent.cursorOperationId === null
					? sql``
					: sql`AND id > ${intent.cursorOperationId}`;
			const rows = this.database.all<{
				id: string;
			}>(sql`SELECT id FROM publication_manifest_operation INDEXED BY publication_manifest_operation_scope_idx
			 WHERE cache_id = ${intent.cacheId} AND cache_generation = ${intent.cacheGeneration} ${after} ORDER BY id LIMIT 64`);
			for (const row of rows) {
				this.failPendingOperation(row.id, intent, 'scope-changed');
			}
			const last = rows.at(-1);
			if (rows.length === 64) {
				this.database
					.update(table)
					.set({ cursorOperationId: last?.id })
					.where(eq(table.revision, revision))
					.run();
				return { processed: rows.length, remaining: true };
			}
			this.database.delete(table).where(eq(table.revision, revision)).run();
			// The singleton lifecycle stamp survives reclamation without retaining
			// metadata for physically deleted cache identities.
			return { processed: rows.length, remaining: false };
		});
	}

	/** Bounded local drain/cleanup under the existing invocation row budget.
 Remote-pending intents are discovered separately, never cleared by cleanup. */
	drain(): boolean {
		for (;;) {
			const intent = this.nextIntent(false);
			const lifecycle = this.nextLifecycleIntent();
			if (intent === undefined && lifecycle === undefined) {
				return this.nextIntent() !== undefined;
			}
			if (intent !== undefined) {
				this.drainPage(intent.revision);
			} else if (lifecycle !== undefined) {
				this.drainLifecyclePage(lifecycle.revision);
			}
			if (isRowBudgetExhausted()) {
				return (
					this.nextIntent() !== undefined ||
					this.nextLifecycleIntent() !== undefined
				);
			}
		}
	}
}
