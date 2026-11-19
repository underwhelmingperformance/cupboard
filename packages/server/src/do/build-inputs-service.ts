import {
	type CacheScope,
	referenceSet,
	storedReferencesSchema,
	type StorePathBasename,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { storePathHashOf } from '@cupboard/nix-store/store-path';
import {
	type BuildInputsClearResponse,
	type BuildInputsClearResult,
	buildInputsMaxLength,
	type BuildInputsReadResponse,
	type BuildInputsRecordBody,
	type BuildInputsRecordEntry,
	buildInputsRecordMaxBuildInputs,
	buildInputsRecordMaxEntries,
	type BuildInputsRecordResponse,
	type BuildInputsRecordResult,
	buildInputsRecordWorkBudget,
	canStoreBuildInputs,
	pathEdgesMaxJsonBytes
} from '@cupboard/protocol/build-inputs';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { BuildInputsPageLimitExceededError } from '../errors.ts';

import { CacheClosureService } from './cache-closure-service.ts';
import { type SchemaWriter, type ServerContext } from './context.ts';
import { GarbageCollectionInputs } from './garbage-collection-inputs.ts';
import { jsonValueLists } from './json-list.ts';

/**
What the server reads about one entry's row. `buildInputsCount` is undefined
when the row has no build inputs or their stored value is not a JSON array.
`buildInputsJson` is the stored value only when the entry fits in the
remaining budget, so the request loads no set that it will not record.
*/
interface StoredRow {
	readonly hasBuildInputs: boolean;
	readonly buildInputsJson: string | undefined;
	readonly buildInputsCount: number | undefined;
	readonly buildInputsVersion: number | undefined;
	readonly referencesBytes: number;
}

/**
Records, reads and clears the build inputs of the narinfo rows that a cache
already has.
*/
export class BuildInputsService {
	constructor(private readonly context: ServerContext) {}

	// SQLite counts the stored build inputs, so the request can check the
	// count and its budget before it loads the set. A row with another store
	// path matches nothing, so SQLite does not look at its build inputs.
	private storedRow(
		tx: SchemaWriter,
		cache: ResolvedCache,
		entry: BuildInputsRecordEntry,
		storePathHash: StorePathHash,
		budget: number
	): StoredRow | undefined {
		const column = schema.narInfos.buildInputsJson;
		const count = sql<
			number | null
		>`CASE WHEN json_valid(${column}) AND json_type(${column}) = 'array' THEN json_array_length(${column}) END`;
		const row = tx
			.select({
				hasBuildInputs: sql<number>`${column} IS NOT NULL`,
				buildInputsCount: count,
				buildInputsJson: sql<
					string | null
				>`CASE WHEN ${count} <= ${buildInputsMaxLength} AND ${count} + ${entry.buildInputs.length} <= ${budget} THEN ${column} END`,
				buildInputsVersion: schema.narInfos.buildInputsVersion,
				referencesBytes: sql<number>`length(${schema.narInfos.referencesJson})`
			})
			.from(schema.narInfos)
			.where(
				and(
					narInfoRow(cache, storePathHash),
					eq(schema.narInfos.storePath, entry.storePath)
				)
			)
			.get();

		if (row === undefined) {
			return undefined;
		}

		return {
			hasBuildInputs: row.hasBuildInputs === 1,
			buildInputsJson: row.buildInputsJson ?? undefined,
			buildInputsCount: row.buildInputsCount ?? undefined,
			buildInputsVersion: row.buildInputsVersion ?? undefined,
			referencesBytes: row.referencesBytes
		};
	}

	private recordEntry(
		tx: SchemaWriter,
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		entry: BuildInputsRecordEntry,
		stored: StoredRow
	): BuildInputsRecordResult {
		const { storePath } = entry;
		const storedJson = stored.buildInputsJson;
		const storedBuildInputs =
			storedJson === undefined ? [] : parseStoredBuildInputs(storedJson);

		if (storedBuildInputs === undefined) {
			return { storePath, status: 'invalid-stored' };
		}

		const union = referenceSet([...storedBuildInputs, ...entry.buildInputs]);
		const buildInputsJson = JSON.stringify(union);

		if (
			union.length > buildInputsMaxLength ||
			!canStoreBuildInputs(union) ||
			stored.referencesBytes + buildInputsJson.length > pathEdgesMaxJsonBytes
		) {
			return { storePath, status: 'limit-exceeded' };
		}

		const buildInputsVersion = Math.max(
			stored.buildInputsVersion ?? 0,
			entry.buildInputsVersion
		);

		if (buildInputsJson !== storedJson) {
			tx.update(schema.narInfos)
				.set({ buildInputsJson, buildInputsVersion })
				.where(narInfoRow(cache, storePathHash))
				.run();

			return { storePath, status: 'recorded' };
		}

		if (buildInputsVersion === stored.buildInputsVersion) {
			return { storePath, status: 'unchanged' };
		}

		// Leave `build_inputs_json` out of the update. The collection barrier
		// re-queues a marked path whenever an update sets that column, even to
		// the same value.
		tx.update(schema.narInfos)
			.set({ buildInputsVersion })
			.where(narInfoRow(cache, storePathHash))
			.run();

		return { storePath, status: 'recorded' };
	}

	/**
	Adds each entry's build inputs to its row in one transaction. The stored
	set becomes the union of the stored and the given sets, and the stored
	version the higher of the two. An entry whose row would end up with more
	build inputs than one path can store changes nothing. An entry whose path
	has no row in the cache is `absent`, and one whose stored build inputs
	cannot be read, or list more than one row can have, is `invalid-stored`.

	The entries are read one at a time, in request order. SQLite counts each
	row's stored build inputs, and the request loads and parses a stored set
	only for an entry that it records. The stored and given build inputs of
	those entries add up to at most `buildInputsRecordWorkBudget`. The first
	entry that would go over it, and every entry after it, is `deferred` and
	the client sends it again in a later request. The request reads no row
	after the first deferred entry.
	*/
	record(
		cacheScope: CacheScope,
		body: BuildInputsRecordBody
	): BuildInputsRecordResponse {
		const buildInputs = body.entries.reduce(
			(total, entry) => total + entry.buildInputs.length,
			0
		);

		if (
			body.entries.length > buildInputsRecordMaxEntries ||
			buildInputs > buildInputsRecordMaxBuildInputs
		) {
			throw new BuildInputsPageLimitExceededError(
				buildInputsRecordMaxEntries,
				buildInputsRecordMaxBuildInputs
			);
		}

		const absent = (): BuildInputsRecordResponse => ({
			entries: body.entries.map((entry) => ({
				storePath: entry.storePath,
				status: 'absent'
			}))
		});
		const cache = this.context.cacheRepository.resolve(cacheScope);

		if (cache === undefined) {
			return absent();
		}

		new CacheClosureService(this.context).assertWritable(cache);

		return this.context.db.transaction((tx) => {
			if (this.context.cacheRepository.isRemoved(cache.id)) {
				return absent();
			}

			let budget = buildInputsRecordWorkBudget;
			let isDeferring = false;
			const results: BuildInputsRecordResult[] = [];

			for (const entry of body.entries) {
				const { storePath } = entry;

				if (isDeferring) {
					results.push({ storePath, status: 'deferred' });
					continue;
				}

				const storePathHash = storePathHashSchema.parse(
					storePathHashOf(storePath)
				);
				const stored = this.storedRow(tx, cache, entry, storePathHash, budget);

				if (stored === undefined) {
					results.push({ storePath, status: 'absent' });
					continue;
				}

				// No write creates build inputs without a version, or a version
				// without build inputs, so such a row is damaged.
				if (
					stored.hasBuildInputs !== (stored.buildInputsVersion !== undefined) ||
					(stored.hasBuildInputs && stored.buildInputsCount === undefined) ||
					(stored.buildInputsCount ?? 0) > buildInputsMaxLength
				) {
					results.push({ storePath, status: 'invalid-stored' });
					continue;
				}

				const work = (stored.buildInputsCount ?? 0) + entry.buildInputs.length;

				if (work > budget) {
					isDeferring = true;
					results.push({ storePath, status: 'deferred' });
					continue;
				}

				budget -= work;
				results.push(this.recordEntry(tx, cache, storePathHash, entry, stored));
			}

			return { entries: results };
		});
	}

	/**
	Returns the build inputs and their version from one path's row.
	*/
	read(
		cacheScope: CacheScope,
		storePathHash: StorePathHash
	): BuildInputsReadResponse {
		const cache = this.context.cacheRepository.resolve(cacheScope);
		const row =
			cache === undefined
				? undefined
				: this.context.db
						.select({
							buildInputsJson: schema.narInfos.buildInputsJson,
							buildInputsVersion: schema.narInfos.buildInputsVersion
						})
						.from(schema.narInfos)
						.where(narInfoRow(cache, storePathHash))
						.get();

		if (row === undefined) {
			return { storePathHash, status: 'absent' };
		}

		if (row.buildInputsJson === null && row.buildInputsVersion === null) {
			return { storePathHash, status: 'none' };
		}

		const buildInputs =
			row.buildInputsJson === null
				? undefined
				: parseStoredBuildInputs(row.buildInputsJson);

		if (
			buildInputs === undefined ||
			buildInputs.length > buildInputsMaxLength ||
			row.buildInputsVersion === null
		) {
			return { storePathHash, status: 'invalid-stored' };
		}

		return {
			storePathHash,
			status: 'recorded',
			buildInputs: [...buildInputs],
			buildInputsVersion: row.buildInputsVersion
		};
	}

	/**
	Clears the build inputs and their version from the rows of `storePathHashes`
	in one transaction. Paths that only those build inputs kept become
	collectable, so a clear that changes a row marks the cache's collection
	inputs as changed and calls `onChange`.
	*/
	clear(
		cacheScope: CacheScope,
		storePathHashes: readonly StorePathHash[],
		onChange: () => void
	): BuildInputsClearResponse {
		const absent = (): BuildInputsClearResponse => ({
			entries: storePathHashes.map((storePathHash) => ({
				storePathHash,
				status: 'absent'
			}))
		});
		const cache = this.context.cacheRepository.resolve(cacheScope);

		if (cache === undefined) {
			return absent();
		}

		const response = this.context.db.transaction((tx) => {
			if (this.context.cacheRepository.isRemoved(cache.id)) {
				return absent();
			}

			const rows = new Map(
				jsonValueLists(storePathHashes).flatMap((list) =>
					tx
						.select({
							storePathHash: schema.narInfos.storePathHash,
							hasBuildInputs: sql<number>`${schema.narInfos.buildInputsJson} IS NOT NULL OR ${schema.narInfos.buildInputsVersion} IS NOT NULL`
						})
						.from(schema.narInfos)
						.where(
							and(
								eq(schema.narInfos.cacheId, cache.id),
								inArray(schema.narInfos.storePathHash, list)
							)
						)
						.all()
						.map(
							(row) => [row.storePathHash, row.hasBuildInputs === 1] as const
						)
				)
			);
			const cleared = storePathHashes.filter(
				(storePathHash) => rows.get(storePathHash) === true
			);

			for (const list of jsonValueLists(cleared)) {
				tx.update(schema.narInfos)
					.set({ buildInputsJson: sql`null`, buildInputsVersion: sql`null` })
					.where(
						and(
							eq(schema.narInfos.cacheId, cache.id),
							inArray(schema.narInfos.storePathHash, list)
						)
					)
					.run();
			}

			if (cleared.length > 0) {
				new GarbageCollectionInputs(this.context).recordChange(cache);
			}

			return {
				entries: storePathHashes.map(
					(storePathHash): BuildInputsClearResult => {
						const hasBuildInputs = rows.get(storePathHash);

						if (hasBuildInputs === undefined) {
							return { storePathHash, status: 'absent' };
						}

						return {
							storePathHash,
							status: hasBuildInputs ? 'cleared' : 'unchanged'
						};
					}
				)
			};
		});

		if (response.entries.some((entry) => entry.status === 'cleared')) {
			onChange();
		}

		return response;
	}
}

function narInfoRow(cache: ResolvedCache, storePathHash: StorePathHash) {
	return and(
		eq(schema.narInfos.cacheId, cache.id),
		eq(schema.narInfos.storePathHash, storePathHash)
	);
}

// Returns undefined for a stored value that is not a list of basenames.
function parseStoredBuildInputs(
	source: string
): readonly StorePathBasename[] | undefined {
	let json: unknown;

	try {
		json = JSON.parse(source);
	} catch {
		return undefined;
	}

	const parsed = storedReferencesSchema.safeParse(json);

	return parsed.success ? parsed.data : undefined;
}
