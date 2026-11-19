import {
	type CacheAccessMode,
	type CacheScope,
	isSameCacheScope,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import {
	type DependencyStatusEntry,
	dependencyStatusMaxPaths,
	type DependencyStatusResponse
} from '@cupboard/protocol/dependency-status';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import { and, eq, exists, inArray, notExists, sql } from 'drizzle-orm';

import { type CacheId, type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { UploadRequestLimitExceededError } from '../errors.ts';

import { type ServerContext } from './context.ts';
import { inFlightUploadSelect } from './in-flight-upload.ts';
import { jsonValueList } from './json-list.ts';
import { ReuseViewLookupService } from './reuse-view-lookup-service.ts';

// The most caches that the source lookup considers: the first caches in
// identity order that the token may reuse from. It looks up each absent hash
// in each of them, so a full page makes at most 16,384 lookups, each with at
// most one in-flight probe. A source beyond these caches is missed. A source
// is a hint, so a miss costs the client only a copy that it could have made.
const sourceProbeLimit = 16;

interface DestinationRow {
	readonly storePathHash: StorePathHash;
	readonly buildInputsVersion: number | null;
	readonly isInFlight: boolean;
}

/**
The answer for a path without a narinfo row in the destination.
*/
interface AbsentPath {
	// An upload of the path into the destination is in flight but has not
	// reserved its row yet. A commit marks its upload `committing` before it
	// reserves the row.
	readonly isUploading: boolean;
	readonly source?: CacheScope;
}

/**
Answers the `dependency-status` procedure from the tenant object's own
SQLite. All caches of a tenant live in this object, so the procedure reads
no D1 and no R2, and it writes nothing.
*/
export class DependencyStatusService {
	constructor(private readonly context: ServerContext) {}

	private destinationRows(
		destination: ResolvedCache,
		storePathHashes: readonly StorePathHash[]
	): Map<StorePathHash, DestinationRow> {
		if (storePathHashes.length === 0) {
			return new Map();
		}

		const inFlight = exists(
			inFlightUploadSelect(this.context.db, destination.id)
		).mapWith(Boolean);
		const listed = inArray(
			schema.narInfos.storePathHash,
			jsonValueList(storePathHashes)
		);
		const rows = this.context.db
			.select({
				storePathHash: schema.narInfos.storePathHash,
				buildInputsVersion: schema.narInfos.buildInputsVersion,
				isInFlight: inFlight
			})
			.from(schema.narInfos)
			.where(and(eq(schema.narInfos.cacheId, destination.id), listed))
			.all();

		return new Map(rows.map((row) => [row.storePathHash, row]));
	}

	// The access of `scope`, or for a cache that does not exist the access
	// that a write would create it with: a named cache takes the default
	// cache's access. A tenant without a default cache counts as public, the
	// access that permits fewer sources.
	private destinationAccess(
		scope: CacheScope,
		destination: ResolvedCache | undefined
	): CacheAccessMode {
		if (destination !== undefined) {
			return destination.access;
		}

		if (scope.kind === 'default') {
			return 'public';
		}

		return (
			this.context.cacheRepository.resolve({ kind: 'default' })?.access ??
			'public'
		);
	}

	// The first `sourceProbeLimit` live caches in identity order, other than
	// the destination, from which `grants` may reuse a NAR, keyed by identity.
	// A private cache never supplies a public one.
	private permittedSources(
		scope: CacheScope,
		destination: ResolvedCache | undefined,
		grants: AuthorizationDetails
	): Map<CacheId, CacheScope> {
		const authority = new ReuseViewLookupService(this.context).reuseAuthority(
			scope,
			grants
		);
		const access = this.destinationAccess(scope, destination);

		return new Map(
			this.context.cacheRepository
				.live()
				.filter(
					(cache) =>
						!isSameCacheScope(cache.scope, scope) &&
						(cache.access === 'public' || access === 'private') &&
						authority.permits({ cache: cache.scope, access: cache.access })
				)
				.slice(0, sourceProbeLimit)
				.map((cache) => [cache.id, cache.scope])
		);
	}

	// The first of `permitted`, in identity order, with a committed row for
	// the hash that the outer statement is looking at. SQLite looks up the
	// hash in each permitted cache through `narinfo_store_path_hash_cache_idx`.
	private firstPermittedHolder(permitted: ReadonlyMap<CacheId, CacheScope>) {
		const committed = notExists(
			inFlightUploadSelect(this.context.db, schema.narInfos.cacheId)
		);
		const permittedIds = jsonValueList(permitted.keys().toArray());

		return this.context.db
			.select({ cacheId: schema.narInfos.cacheId })
			.from(schema.narInfos)
			.where(
				and(
					sql`${schema.narInfos.cacheId} in (${permittedIds})`,
					sql`${schema.narInfos.storePathHash} = requested.value`,
					committed
				)
			)
			.orderBy(schema.narInfos.cacheId)
			.limit(1);
	}

	// Answers the paths without a narinfo row in one statement: whether an
	// upload into the destination is in flight, and the first permitted cache
	// that can supply the path.
	private absentPaths(
		scope: CacheScope,
		destination: ResolvedCache | undefined,
		storePathHashes: readonly StorePathHash[],
		grants: AuthorizationDetails
	): Map<StorePathHash, AbsentPath> {
		if (storePathHashes.length === 0) {
			return new Map();
		}

		const permitted = this.permittedSources(scope, destination, grants);
		const uploading =
			destination === undefined
				? sql`0`
				: exists(
						inFlightUploadSelect(
							this.context.db,
							destination.id,
							sql`requested.value`
						)
					);
		const source =
			permitted.size === 0
				? sql`NULL`
				: sql`(${this.firstPermittedHolder(permitted)})`;
		const rows = this.context.db.all<{
			storePathHash: StorePathHash;
			uploading: number;
			cacheId: CacheId | null;
		}>(sql`
			SELECT requested.value AS storePathHash,
			       ${uploading} AS uploading,
			       ${source} AS cacheId
			FROM json_each(${JSON.stringify(storePathHashes)}) AS requested
		`);

		return new Map(
			rows.map((row) => [
				row.storePathHash,
				absentPath(row.uploading === 1, row.cacheId, permitted)
			])
		);
	}

	/**
	Reports the state of each listed path in `scope`, in request order. A
	cache that has never been created, or that has been removed, has no
	rows, so every path in it is `absent`.

	A path whose upload into `scope` has not reserved its row yet is
	`in-flight`. For an absent path, `source` is the first cache with a
	committed row for the path among the first `sourceProbeLimit` live caches
	in identity order, other than `scope`, that `ReuseAuthority` lets `grants`
	reuse from. A private cache is a source only for a private `scope`.
	*/
	status(
		scope: CacheScope,
		storePathHashes: readonly StorePathHash[],
		grants: AuthorizationDetails
	): DependencyStatusResponse {
		if (storePathHashes.length > dependencyStatusMaxPaths) {
			throw new UploadRequestLimitExceededError(
				dependencyStatusMaxPaths,
				`The dependency-status request lists more than ${String(dependencyStatusMaxPaths)} store paths. Send at most ${String(dependencyStatusMaxPaths)} paths per request.`
			);
		}

		const requested = [...new Set(storePathHashes)];
		const destination = this.context.cacheRepository.resolve(scope);
		const rows =
			destination === undefined
				? new Map<StorePathHash, DestinationRow>()
				: this.destinationRows(destination, requested);
		const absent = this.absentPaths(
			scope,
			destination,
			requested.filter((storePathHash) => !rows.has(storePathHash)),
			grants
		);

		return {
			paths: storePathHashes.map((storePathHash) =>
				statusEntry(
					storePathHash,
					rows.get(storePathHash),
					absent.get(storePathHash)
				)
			)
		};
	}
}

function absentPath(
	isUploading: boolean,
	cacheId: CacheId | null,
	permitted: ReadonlyMap<CacheId, CacheScope>
): AbsentPath {
	const source = cacheId === null ? undefined : permitted.get(cacheId);

	if (isUploading || source === undefined) {
		return { isUploading };
	}

	return { isUploading, source };
}

function statusEntry(
	storePathHash: StorePathHash,
	row: DestinationRow | undefined,
	absent: AbsentPath | undefined
): DependencyStatusEntry {
	if (row === undefined && absent?.isUploading === true) {
		return { storePathHash, state: 'in-flight' };
	}

	if (row === undefined) {
		return {
			storePathHash,
			state: 'absent',
			...(absent?.source !== undefined && { source: absent.source })
		};
	}

	if (row.isInFlight) {
		return { storePathHash, state: 'in-flight' };
	}

	if (row.buildInputsVersion === null) {
		return { storePathHash, state: 'present' };
	}

	return {
		storePathHash,
		state: 'recorded',
		buildInputsVersion: row.buildInputsVersion
	};
}
