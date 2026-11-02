import { StorePath } from '@cupboard/nix-store/store-path';
import {
	publicationEnsureRequestSchema,
	type PublicationResultIdentity
} from '@cupboard/protocol/publication-manifests';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import { pushIdSchema, uploadIdSchema } from '@cupboard/protocol/upload';
import { and, eq, sql } from 'drizzle-orm';

import type { ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';

import type { SchemaDatabase, SchemaWriter, ServerContext } from './context.ts';

/** Called synchronously in normal publication completion's SQLite transaction,
before the upload's accepted-work protection disappears. Not a retention root. */
export function holdManifestPublication(
	context: ServerContext,
	publication: typeof schema.publicationOperations.$inferSelect,
	result: typeof schema.narInfos.$inferSelect
): void {
	const admission = context.db
		.select()
		.from(schema.publicationManifestAdmissions)
		.where(
			eq(
				schema.publicationManifestAdmissions.pushId,
				pushIdSchema.parse(publication.pushId)
			)
		)
		.get();
	if (
		admission === undefined ||
		Date.parse(admission.expiresAt) <= Date.now() ||
		admission.cacheId !== result.cacheId ||
		admission.cacheGeneration !== publication.cacheGeneration
	) {
		return;
	}
	const operation = context.db
		.select()
		.from(schema.publicationManifestOperations)
		.where(eq(schema.publicationManifestOperations.id, admission.operationId))
		.get();
	if (
		operation !== undefined &&
		(operation.kind !== 'ensure' ||
			operation.state !== 'pending' ||
			Date.parse(operation.expiresAt) <= Date.now())
	) {
		return;
	}
	const request = publicationEnsureRequestSchema.parse(
		JSON.parse(admission.canonicalJson)
	);
	const member = context.db
		.select()
		.from(schema.publicationManifestMembers)
		.where(
			and(
				eq(schema.publicationManifestMembers.digest, request.source.digest),
				eq(schema.publicationManifestMembers.storePath, result.storePath)
			)
		)
		.get();
	if (member?.narHash !== result.narHash) {
		return;
	}
	const page = context.db
		.select()
		.from(schema.publicationManifestOperationPages)
		.where(
			and(
				eq(
					schema.publicationManifestOperationPages.operationId,
					admission.operationId
				),
				eq(schema.publicationManifestOperationPages.page, member.ordinal)
			)
		)
		.get();
	const payloadJson = JSON.stringify({
		kind: 'ensure-member-admission',
		storePath: result.storePath,
		publicationId: publication.id
	});
	if (
		page?.payloadDigest !== publication.id ||
		page.payloadJson !== payloadJson
	) {
		return;
	}
	const values = {
		operationId: admission.operationId,
		publicationId: publication.id,
		cacheId: result.cacheId,
		cacheGeneration: publication.cacheGeneration,
		storePathHash: result.storePathHash,
		storePath: result.storePath,
		narHash: result.narHash,
		generation: result.generation
	};
	context.db
		.insert(schema.publicationManifestWorkHolds)
		.values(values)
		.onConflictDoUpdate({
			target: [
				schema.publicationManifestWorkHolds.operationId,
				schema.publicationManifestWorkHolds.publicationId
			],
			set: values
		})
		.run();
}

/** A proved destination version needs no ordinary publication. The namespaced
hold key cannot collide with a normal publication identity (a hex digest).
Insert with the staged proof under the same local transaction. */
export function holdManifestDestinationMember(
	database: SchemaWriter,
	operationId: string,
	cache: ResolvedCache,
	result: PublicationResultIdentity
): void {
	const hash = StorePath.hash(result.storePath);
	// Normal completion may already have installed the exact protection. Keep
	// that immutable publication identity instead of duplicating the hold.
	const existing = database
		.select()
		.from(schema.publicationManifestWorkHolds)
		.where(
			and(
				eq(schema.publicationManifestWorkHolds.cacheId, cache.id),
				eq(schema.publicationManifestWorkHolds.storePathHash, hash),
				eq(schema.publicationManifestWorkHolds.generation, result.generation),
				eq(schema.publicationManifestWorkHolds.operationId, operationId)
			)
		)
		.limit(1)
		.get();
	if (
		existing?.cacheGeneration === cache.generation &&
		existing.storePath === result.storePath &&
		existing.narHash === result.narHash
	) {
		return;
	}

	const values = {
		operationId,
		publicationId: uploadIdSchema.parse(
			`manifest-destination:${result.storePath}`
		),
		cacheId: cache.id,
		cacheGeneration: cache.generation,
		storePathHash: StorePath.hash(result.storePath),
		storePath: result.storePath,
		narHash: result.narHash,
		generation: result.generation
	};
	database
		.insert(schema.publicationManifestWorkHolds)
		.values(values)
		.onConflictDoUpdate({
			target: [
				schema.publicationManifestWorkHolds.operationId,
				schema.publicationManifestWorkHolds.publicationId
			],
			set: values
		})
		.run();
}

/** Inspect a bounded raw hold page before collection. Inactive holds are removed,
not filtered past in SQL. Return only the path prefix fully decided by this page;
the collector's existing cursor revisits an undecided path after restart. */
export function prepareManifestWorkHolds(
	database: SchemaDatabase,
	cache: ResolvedCache,
	paths: readonly Pick<
		typeof schema.narInfos.$inferSelect,
		'storePathHash' | 'storePath' | 'narHash' | 'generation'
	>[],
	now: IsoTimestamp,
	pageSize: number
): number {
	const first = paths.at(0);
	const last = paths.at(-1);
	if (first === undefined || last === undefined) {
		return paths.length;
	}
	const holds = database.all<{
		operationId: string;
		publicationId: string;
		hash: string;
		path: string;
		narHash: string;
		generation: number;
		live: number | null;
	}>(sql`SELECT h.operation_id AS operationId, h.publication_id AS publicationId,
		h.store_path_hash AS hash, h.store_path AS path, h.nar_hash AS narHash, h.generation,
		(h.cache_generation = ${cache.generation} AND ((h.publication_id LIKE 'manifest-destination:%'
		 AND m.cache_id = h.cache_id AND m.cache_generation = h.cache_generation
		 AND m.kind = 'ensure' AND m.state = 'pending' AND m.expires_at > ${now})
		 OR (a.cache_id = h.cache_id
		 AND a.cache_generation = h.cache_generation AND a.expires_at > ${now}
		 AND p.state = 'servable' AND p.cache_id = h.cache_id AND p.cache_generation = h.cache_generation
		 AND (m.id IS NULL OR (m.kind = 'ensure' AND m.state = 'pending' AND m.expires_at > ${now}))))) AS live
		FROM publication_manifest_work_hold h INDEXED BY publication_manifest_work_hold_path_idx
		LEFT JOIN publication_manifest_admission a ON a.operation_id = h.operation_id
		LEFT JOIN publication_operation p ON p.id = h.publication_id
		LEFT JOIN publication_manifest_operation m ON m.id = h.operation_id
		WHERE h.cache_id = ${cache.id} AND h.store_path_hash >= ${first.storePathHash} AND h.store_path_hash <= ${last.storePathHash}
		ORDER BY h.store_path_hash, h.generation, h.operation_id LIMIT ${pageSize + 1}`);
	const byHash = new Map<string, (typeof paths)[number]>(
		paths.map((path) => [path.storePathHash, path])
	);
	const active = new Set<string>();
	for (const hold of holds.slice(0, pageSize)) {
		const path = byHash.get(hold.hash);
		if (
			hold.live === 1 &&
			path?.generation === hold.generation &&
			path.storePath === hold.path &&
			path.narHash === hold.narHash
		) {
			active.add(hold.hash);
			continue;
		}
		database.run(
			sql`DELETE FROM publication_manifest_work_hold WHERE operation_id = ${hold.operationId} AND publication_id = ${hold.publicationId}`
		);
	}
	const next = holds[pageSize];
	if (next === undefined) {
		return paths.length;
	}
	return paths.filter(
		(path) =>
			path.storePathHash < next.hash ||
			(path.storePathHash === next.hash && active.has(next.hash))
	).length;
}
