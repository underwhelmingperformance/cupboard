import {
	type CachePriority,
	type NixSha256HashString,
	type StoredCache,
	type StorePathHash,
	storePathHashSchema,
	type TenantId
} from '@cupboard/nix-store/scalars';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import type { UploadId } from '@cupboard/protocol/upload';
import {
	AnonymousAccessDeniedError,
	CredentialCacheMismatchError,
	CredentialCannotWriteError,
	DeletionNotImplementedError
} from '@cupboard/s3/errors';
import type {
	CredentialResolver,
	ListObjectsQuery,
	ListObjectsResult,
	S3Principal
} from '@cupboard/s3/ports';
import { and, asc, eq, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfoObjectKey } from '../http/http.ts';

import type { BlobStore } from './blob-store.ts';
import { renderNixCacheInfoObject } from './cache-info-object.ts';
import { createS3CredentialStore } from './credential-store.ts';
import {
	createS3CredentialResolver,
	type EncryptionKeyset
} from './credentials.ts';
import type { NixCacheBackend } from './nix-cache-object-store.ts';
import type {
	CacheAuthoriser,
	CacheListing,
	CacheRecords,
	CacheRemover,
	IngestPipeline,
	NarResolver,
	NixCacheServiceDependencies,
	UploadSettlement,
	UploadSettlementTarget
} from './nix-cache-service.ts';
import { createNixCacheService } from './nix-cache-service.ts';
import { S3StagingAccounting } from './staging-accounting.ts';

const uploadGrant = 'upload:commit';

/**
 * The dependencies that connect the S3 backend to a tenant Durable Object.
 */
export interface S3BackendContext {
	readonly db: SchemaDatabaseLike;
	readonly d1: DrizzleD1Database<typeof d1Schema>;
	readonly tenant: TenantId;
	readonly blobStore: BlobStore;
	readonly encryptionKeyset: EncryptionKeyset;
	readonly commit: (
		cache: StoredCache,
		uploadId: UploadId
	) => Promise<CommitKind>;
	readonly settleUpload: (
		uploadId: UploadId,
		target: UploadSettlementTarget
	) => Promise<UploadSettlement>;
	// Resolves the hash in a `nar/<hash>` key to a canonical NAR hash that the
	// selected cache references. The committed reference edges live in D1.
	readonly resolveServableNar: (
		cache: StoredCache,
		hash: NixSha256HashString
	) => Promise<NixSha256HashString | undefined>;
	readonly now: () => Date;
	readonly newId: () => UploadId;
}

export interface CommitKind {
	readonly kind: 'settled' | 'deferred';
}

// The minimal database surface the backend uses, so this module avoids importing
// the Durable Object's concrete drizzle type.
type SchemaDatabaseLike = Parameters<typeof createS3CredentialStore>[0];

/**
 * Builds the production {@link NixCacheBackend} and {@link CredentialResolver}
 * for a tenant Durable Object, wiring the S3 ports to the commit pipeline, the
 * cache records and the credential table.
 */
export function createS3Backend(context: S3BackendContext): {
	readonly backend: NixCacheBackend;
	readonly resolver: CredentialResolver;
} {
	const pipeline: IngestPipeline = {
		registerPending(row) {
			context.db.insert(schema.pendingUploads).values(row).run();
		},
		commit: (cache, uploadId) => context.commit(cache, uploadId),
		settleUpload: (uploadId, target) => context.settleUpload(uploadId, target)
	};

	const caches: CacheRecords = {
		find(cache) {
			const row = context.db
				.select()
				.from(schema.caches)
				.where(eq(schema.caches.name, cache))
				.get();
			return Promise.resolve(
				row === undefined
					? undefined
					: { priority: row.priority, createdAt: row.createdAt }
			);
		}
	};

	const authoriser: CacheAuthoriser = {
		read: (cache, principal) => authorise(cache, principal, false),
		async write(cache, principal) {
			await authorise(cache, principal, true);
			if (
				principal?.accessKeyId === undefined ||
				principal.credentialId === undefined
			) {
				throw new CredentialCannotWriteError();
			}

			const current = context.db
				.select({ credentialId: schema.s3Credentials.credentialId })
				.from(schema.s3Credentials)
				.where(eq(schema.s3Credentials.accessKeyId, principal.accessKeyId))
				.get();
			if (current?.credentialId !== principal.credentialId) {
				throw new CredentialCannotWriteError();
			}
		}
	};

	const listing: CacheListing = {
		list: (cache, query) => listCache(context, cache, query)
	};

	const remover: CacheRemover = {
		remove: () => Promise.reject(new DeletionNotImplementedError())
	};

	const nars: NarResolver = {
		resolveServableNar: (cache, hash) => context.resolveServableNar(cache, hash)
	};

	const dependencies: NixCacheServiceDependencies = {
		tenant: context.tenant,
		blobStore: context.blobStore,
		pipeline,
		caches,
		authoriser,
		listing,
		remover,
		nars,
		stagingAccounting: new S3StagingAccounting(
			context.d1,
			context.tenant,
			context.now,
			() => crypto.randomUUID()
		),
		now: context.now,
		newId: context.newId
	};

	const credentialStore = createS3CredentialStore(
		context.db,
		context.tenant,
		context.now
	);

	return {
		backend: createNixCacheService(dependencies),
		resolver: createS3CredentialResolver(
			credentialStore,
			context.encryptionKeyset
		)
	};
}

export function authorise(
	cache: StoredCache,
	principal: S3Principal | undefined,
	isWrite: boolean
): Promise<void> {
	if (principal === undefined) {
		// The front worker admits an anonymous read only for a publicly readable
		// tenant, so an unauthenticated read is already permitted here; an
		// anonymous write is never allowed.
		return isWrite
			? Promise.reject(new AnonymousAccessDeniedError())
			: Promise.resolve();
	}

	if (principal.cache !== cache) {
		return Promise.reject(new CredentialCacheMismatchError());
	}

	if (isWrite && !principal.grants.includes(uploadGrant)) {
		return Promise.reject(new CredentialCannotWriteError());
	}

	return Promise.resolve();
}

interface CacheRow {
	readonly priority: CachePriority;
	readonly createdAt: IsoTimestamp;
}

interface ListEntry {
	readonly key: string;
	readonly isPrefix: boolean;
}

type CommittedStream = 'narinfo' | 'nar';

interface CommittedCandidate {
	readonly stream: CommittedStream;
	readonly entry: ListEntry;
}

function byteOrder(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

async function listCache(
	context: S3BackendContext,
	cache: StoredCache,
	query: ListObjectsQuery
): Promise<ListObjectsResult> {
	const record = context.db
		.select({
			priority: schema.caches.priority,
			createdAt: schema.caches.createdAt
		})
		.from(schema.caches)
		.where(eq(schema.caches.name, cache))
		.get();

	if (record === undefined) {
		return {
			objects: [],
			commonPrefixes: [],
			isTruncated: false,
			nextContinuationToken: undefined
		};
	}

	if (query.maxKeys === 0) {
		return {
			objects: [],
			commonPrefixes: [],
			isTruncated: false,
			nextContinuationToken: undefined
		};
	}

	const committed = await listCommittedEntries(context, cache, query);
	const cacheInfo = collectEntries(
		['nix-cache-info'],
		query.prefix,
		query.delimiter
	).filter(
		(entry) =>
			query.continuationToken === undefined ||
			entry.key > query.continuationToken
	);
	const entriesByKey = new Map<string, ListEntry>();
	for (const entry of [...committed, ...cacheInfo]) {
		const existing = entriesByKey.get(entry.key);
		entriesByKey.set(entry.key, {
			key: entry.key,
			isPrefix: entry.isPrefix || existing?.isPrefix === true
		});
	}
	const windowed = entriesByKey
		.values()
		.toArray()
		.toSorted((left, right) => byteOrder(left.key, right.key));
	const page = windowed.slice(0, query.maxKeys);
	const isTruncated = windowed.length > page.length;

	// The per-key stats are independent R2 heads; issue them together rather than
	// one after another so a full page does not serialise a thousand round trips
	// inside the single-threaded Durable Object.
	const stats = await Promise.all(
		page.map(async (entry) =>
			entry.isPrefix ? undefined : statForKey(context, cache, entry.key, record)
		)
	);

	const objects = page.flatMap((entry, index) => {
		const stat = stats[index];
		if (stat === undefined) {
			return [];
		}
		return [
			{
				key: entry.key,
				size: stat.size,
				etag: stat.etag,
				lastModified: stat.lastModified
			}
		];
	});

	return {
		objects,
		commonPrefixes: page
			.filter((entry) => entry.isPrefix)
			.map((entry) => entry.key),
		isTruncated,
		nextContinuationToken: isTruncated
			? (page.at(-1)?.key ?? windowed[0]?.key)
			: undefined
	};
}

async function listCommittedEntries(
	context: S3BackendContext,
	cache: StoredCache,
	query: ListObjectsQuery
): Promise<ListEntry[]> {
	if (query.delimiter === undefined || query.delimiter === '/') {
		return listCommonCommittedEntries(context, cache, query);
	}

	return listCommittedEntriesWithDelimiter(context, cache, query);
}

async function listCommonCommittedEntries(
	context: S3BackendContext,
	cache: StoredCache,
	query: ListObjectsQuery
): Promise<ListEntry[]> {
	const start =
		query.continuationToken !== undefined &&
		query.continuationToken > query.prefix
			? query.continuationToken
			: query.prefix;
	const limit = query.maxKeys + 2;
	const scope = and(
		eq(d1Schema.blobReference.tenant, context.tenant),
		eq(d1Schema.blobReference.cache, cache)
	);
	const storePathLowerBound = start.slice(0, 32);
	const narHashLowerBound = componentLowerBound('nar/', start, 59);
	const narinfoRows = await context.d1
		.selectDistinct({ component: d1Schema.blobReference.storePathHash })
		.from(d1Schema.blobReference)
		.where(
			and(
				scope,
				storePathLowerBound === ''
					? undefined
					: sql`${d1Schema.blobReference.storePathHash} >= ${storePathLowerBound}`
			)
		)
		.orderBy(asc(d1Schema.blobReference.storePathHash))
		.limit(limit);
	const narRows =
		narHashLowerBound === false
			? []
			: await context.d1
					.selectDistinct({ component: d1Schema.blobReference.narHash })
					.from(d1Schema.blobReference)
					.where(
						and(
							scope,
							narHashLowerBound === ''
								? undefined
								: sql`${d1Schema.blobReference.narHash} >= ${narHashLowerBound}`
						)
					)
					.orderBy(asc(d1Schema.blobReference.narHash))
					.limit(limit);
	const keys = [
		...narinfoRows.map((row) => `${row.component}.narinfo`),
		...narRows.map((row) => `nar/${row.component}.nar.zst`)
	].filter(
		(key) =>
			key.startsWith(query.prefix) &&
			(query.continuationToken === undefined || key > query.continuationToken)
	);

	return collectEntries(keys, query.prefix, query.delimiter)
		.filter(
			(entry) =>
				query.continuationToken === undefined ||
				entry.key > query.continuationToken
		)
		.toSorted((left, right) => byteOrder(left.key, right.key));
}

function componentLowerBound(
	affix: string,
	start: string,
	componentLength: number
): string | false {
	if (start < affix) {
		return '';
	}

	if (!start.startsWith(affix)) {
		return false;
	}

	return start.slice(affix.length, affix.length + componentLength);
}

async function listCommittedEntriesWithDelimiter(
	context: S3BackendContext,
	cache: StoredCache,
	query: ListObjectsQuery
): Promise<ListEntry[]> {
	const nextCandidate = async (
		stream: CommittedStream,
		start: string
	): Promise<CommittedCandidate | undefined> => {
		const scope = and(
			eq(d1Schema.blobReference.tenant, context.tenant),
			eq(d1Schema.blobReference.cache, cache)
		);
		let keys: string[];

		if (stream === 'narinfo') {
			const lowerBound = start.slice(0, 32);
			const rows = await context.d1
				.selectDistinct({ component: d1Schema.blobReference.storePathHash })
				.from(d1Schema.blobReference)
				.where(
					and(
						scope,
						lowerBound === ''
							? undefined
							: sql`${d1Schema.blobReference.storePathHash} >= ${lowerBound}`
					)
				)
				.orderBy(asc(d1Schema.blobReference.storePathHash))
				.limit(2);
			keys = rows.map((row) => `${row.component}.narinfo`);
		} else {
			const lowerBound = componentLowerBound('nar/', start, 59);
			if (lowerBound === false) {
				return;
			}

			const rows = await context.d1
				.selectDistinct({ component: d1Schema.blobReference.narHash })
				.from(d1Schema.blobReference)
				.where(
					and(
						scope,
						lowerBound === ''
							? undefined
							: sql`${d1Schema.blobReference.narHash} >= ${lowerBound}`
					)
				)
				.orderBy(asc(d1Schema.blobReference.narHash))
				.limit(2);
			keys = rows.map((row) => `nar/${row.component}.nar.zst`);
		}

		const key = keys.find(
			(candidate) => candidate >= start && candidate.startsWith(query.prefix)
		);
		if (key === undefined) {
			return;
		}

		const [entry] = collectEntries([key], query.prefix, query.delimiter);
		return entry === undefined || entry.key < start
			? undefined
			: { stream, entry };
	};

	const start =
		query.continuationToken === undefined
			? query.prefix
			: nextAsciiPrefix(query.continuationToken);
	const initialCandidates = await Promise.all(
		(['narinfo', 'nar'] as const).map((stream) => nextCandidate(stream, start))
	);
	let candidates = initialCandidates.filter(
		(candidate): candidate is CommittedCandidate => candidate !== undefined
	);
	const entries: ListEntry[] = [];

	while (entries.length < query.maxKeys + 1 && candidates.length > 0) {
		let key = candidates[0]?.entry.key ?? '';
		for (const candidate of candidates) {
			if (candidate.entry.key < key) {
				key = candidate.entry.key;
			}
		}
		const matching = candidates.filter(
			(candidate) => candidate.entry.key === key
		);
		entries.push({
			key,
			isPrefix: matching.some((candidate) => candidate.entry.isPrefix)
		});

		const remaining = candidates.filter(
			(candidate) => candidate.entry.key !== key
		);
		const advanced = await Promise.all(
			matching.map((candidate) =>
				nextCandidate(candidate.stream, nextAsciiPrefix(key))
			)
		);
		candidates = [
			...remaining,
			...advanced.filter(
				(candidate): candidate is CommittedCandidate => candidate !== undefined
			)
		];
	}

	return entries;
}

// The Nix cache exposes only ASCII keys. Incrementing the last code unit gives
// the first possible key after every object whose key starts with this prefix.
function nextAsciiPrefix(prefix: string): string {
	if (prefix === '') {
		return '\0';
	}

	const last = prefix.codePointAt(prefix.length - 1);
	if (last === undefined) {
		return '\0';
	}

	return `${prefix.slice(0, -1)}${String.fromCodePoint(last + 1)}`;
}

// Groups matching object keys under their S3 common prefixes when a delimiter
// is present.
export function collectEntries(
	keys: readonly string[],
	prefix: string,
	delimiter: string | undefined
): ListEntry[] {
	const objectKeys: string[] = [];
	const commonPrefixes = new Set<string>();

	for (const key of keys) {
		if (!key.startsWith(prefix)) {
			continue;
		}

		const rest = key.slice(prefix.length);
		const index = delimiter === undefined ? -1 : rest.indexOf(delimiter);
		if (index === -1 || delimiter === undefined) {
			objectKeys.push(key);
			continue;
		}
		commonPrefixes.add(prefix + rest.slice(0, index + delimiter.length));
	}

	return [
		...objectKeys.map((key) => ({ key, isPrefix: false })),
		...[...commonPrefixes].map((key) => ({ key, isPrefix: true }))
	];
}

async function statForKey(
	context: S3BackendContext,
	cache: StoredCache,
	key: string,
	record: CacheRow
): Promise<{ size: number; etag: string; lastModified: Date } | undefined> {
	if (key === 'nix-cache-info') {
		return renderCacheInfoStat(record);
	}

	const r2Key = key.startsWith('nar/')
		? key
		: narInfoObjectKey(context.tenant, narinfoHashOf(key), cache);
	const stat = await context.blobStore.head(r2Key);
	return stat === undefined
		? undefined
		: { size: stat.size, etag: stat.etag, lastModified: stat.lastModified };
}

function narinfoHashOf(key: string): StorePathHash {
	return storePathHashSchema.parse(key.slice(0, -'.narinfo'.length));
}

async function renderCacheInfoStat(
	record: CacheRow
): Promise<{ size: number; etag: string; lastModified: Date }> {
	const { size, etag, lastModified } = await renderNixCacheInfoObject(record);

	return { size, etag, lastModified };
}
