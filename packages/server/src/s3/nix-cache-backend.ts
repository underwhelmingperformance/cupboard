import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type NixSha256HashString,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
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
import { eq } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import { narInfoObjectKey, narObjectKey } from '../http/http.ts';

import type { BlobStore } from './blob-store.ts';
import { createS3CredentialStore } from './credential-store.ts';
import {
	createS3CredentialResolver,
	type EncryptionKeyset
} from './credentials.ts';
import type { NixCacheBackend } from './nix-cache-object-store.ts';
import type {
	CacheAuthorizer,
	CacheListing,
	CacheRecords,
	CacheRemover,
	IngestPipeline,
	NarResolver,
	NixCacheServiceDeps,
	UploadSettlement
} from './nix-cache-service.ts';
import { createNixCacheService } from './nix-cache-service.ts';

const uploadGrant = 'upload:commit';

/**
 * The DO services the S3 backend wires its ports to. Kept as a structural
 * interface so the factory does not depend on the whole Durable Object.
 */
export interface S3BackendContext {
	readonly db: SchemaDatabaseLike;
	readonly tenant: string;
	readonly blobStore: BlobStore;
	readonly encryptionKeyset: EncryptionKeyset;
	readonly commit: (cache: string, uploadId: string) => Promise<CommitKind>;
	readonly settleUpload: (uploadId: string) => Promise<UploadSettlement>;
	// Resolves the hash in a `nar/<hash>` key to a canonical NAR hash this tenant
	// may read, gating cross-tenant access. Injected because tenant ownership
	// lives in D1, which the Durable Object owns.
	readonly resolveServableNar: (
		hash: NixSha256HashString
	) => Promise<NixSha256HashString | undefined>;
	readonly now: () => Date;
	readonly newId: () => string;
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
		settleUpload: (uploadId) => context.settleUpload(uploadId)
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

	const authorizer: CacheAuthorizer = {
		read: (cache, principal) => authorize(cache, principal, false),
		write: (cache, principal) => authorize(cache, principal, true)
	};

	const listing: CacheListing = {
		list: (cache, query) => listCache(context, cache, query)
	};

	// Deletion through S3 unrefs a path, which the cache's deletion services own;
	// wiring it is deferred, so a delete is rejected rather than silently lost.
	const remover: CacheRemover = {
		remove: () => Promise.reject(new DeletionNotImplementedError())
	};

	const nars: NarResolver = {
		resolveServableNar: (hash) => context.resolveServableNar(hash)
	};

	const deps: NixCacheServiceDeps = {
		tenant: context.tenant,
		blobStore: context.blobStore,
		pipeline,
		caches,
		authorizer,
		listing,
		remover,
		nars,
		now: context.now,
		newId: context.newId
	};

	const credentialStore = createS3CredentialStore(
		context.db,
		context.tenant,
		context.now
	);

	return {
		backend: createNixCacheService(deps),
		resolver: createS3CredentialResolver(
			credentialStore,
			context.encryptionKeyset
		)
	};
}

export function authorize(
	cache: string,
	principal: S3Principal | undefined,
	isWrite: boolean
): Promise<void> {
	if (principal === undefined) {
		return Promise.reject(new AnonymousAccessDeniedError());
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
	readonly priority: number;
	readonly createdAt: string;
}

interface ListEntry {
	readonly key: string;
	readonly isPrefix: boolean;
}

function byteOrder(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

async function listCache(
	context: S3BackendContext,
	cache: string,
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

	// Every object the cache exposes, as S3 keys within the cache: the rendered
	// `nix-cache-info`, each path's `<hash>.narinfo`, and each content-addressed
	// `nar/<narHash>.nar.zst` (a NAR hash shared by several paths lists once). The
	// decorator scopes these under a named cache.
	const rows = context.db
		.select({
			storePathHash: schema.narInfos.storePathHash,
			narHash: schema.narInfos.narHash
		})
		.from(schema.narInfos)
		.where(eq(schema.narInfos.cache, cache))
		.all();

	const keys = new Set<string>(['nix-cache-info']);
	for (const row of rows) {
		keys.add(`${row.storePathHash}.narinfo`);
		keys.add(narObjectKey(row.narHash));
	}

	const entries = collectEntries(
		[...keys],
		query.prefix,
		query.delimiter
	).toSorted((left, right) => byteOrder(left.key, right.key));

	const token = query.continuationToken;
	const windowed =
		token === undefined
			? entries
			: entries.filter((entry) => entry.key > token);
	const page = windowed.slice(0, query.maxKeys);
	const isTruncated = windowed.length > page.length;

	const objects = [];
	for (const entry of page) {
		if (entry.isPrefix) {
			continue;
		}
		const stat = await statForKey(context, cache, entry.key, record);
		if (stat === undefined) {
			continue;
		}
		objects.push({
			key: entry.key,
			size: stat.size,
			etag: stat.etag,
			lastModified: stat.lastModified
		});
	}

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

// Splits the prefix-matching keys into object keys and the common prefixes the
// delimiter rolls them up into, so a delimited listing returns folders rather
// than every key beneath them.
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
	cache: string,
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
	const body = new TextEncoder().encode(
		new CacheInfo('/nix/store', true, record.priority).render()
	);
	const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(body));
	const etag = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return { size: body.length, etag, lastModified: new Date(record.createdAt) };
}
