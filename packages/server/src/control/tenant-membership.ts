import {
	type CacheAccessMode,
	type CacheScope,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type TenantStatus } from '@cupboard/protocol/tenants';
import { type ReadUser } from '@cupboard/shared/http';
import { and, eq, ne } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';

import { cacheIdentityCondition } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { readWithOneRetry } from '../db/transient.ts';
import { TenantAdmissionUnavailableError } from '../errors.ts';
import {
	type ReadPasswordHash,
	type ReadPasswordSalt
} from '../read/read-auth.ts';

import { BinaryFuse8 } from './binary-fuse-filter/index.ts';

// Admission first checks an in-memory filter, then a per-tenant KV marker, and
// finally the authoritative D1 row. The first two layers can reject a slug or
// fall through, but cannot admit it. Missing or unreadable cache data therefore
// adds D1 work instead of making a live tenant unavailable.

type Database = DrizzleD1Database<typeof d1Schema>;

const memberKeyPrefix = 'tenant-member:';
const filterKey = 'tenant-filter';

// How long a colo trusts its cached filter before refetching. The filter only
// rejects unknown tenants; it never supplies security-sensitive tenant state.
const filterCacheTtlSeconds = 10;
// KV reads of the per-tenant marker are edge-cached for at least this long, so a
// repeated probe for the same slug is self-limiting. Tier 1 already absorbs
// distinct-slug spray, so this only blunts repeated probes.
const memberKeyCacheTtlSeconds = 60;

/**
 * A read verifier loaded from D1. It can come from the authoritative tenant row
 * or from one cache-specific credential row.
 */
export interface TenantReadVerifier {
	readonly user: ReadUser;
	readonly passwordHash: ReadPasswordHash;
	readonly passwordSalt: ReadPasswordSalt;
}

export interface TenantEntry {
	readonly status: TenantStatus;
	readonly readVerifier?: TenantReadVerifier;
}

// Current admission reads D1 and returns `fresh: true`. The flag remains in the
// dispatch boundary while deployments with the old tenant-row cache drain.
export interface TenantAdmission {
	readonly entry: TenantEntry;
	readonly fresh: boolean;
	readonly cache?: {
		readonly access: CacheAccessMode;
		readonly isDeleted: boolean;
	};
	readonly cacheVerifier?: TenantReadVerifier;
}

interface DeferredContext {
	waitUntil(promise: Promise<unknown>): void;
}

export function tenantMemberKey(slug: TenantId): string {
	return `${memberKeyPrefix}${slug}`;
}

// Writes the per-tenant membership marker. Reliable on create (the caller awaits
// and retries), with the cron reconcile as a backstop, so a tier-2 miss is a
// sound 404: every live tenant's marker is present or reasserted within a tick.
export async function writeTenantMember(
	kv: KVNamespace,
	slug: TenantId
): Promise<void> {
	await kv.put(tenantMemberKey(slug), '1');
}

export async function deleteTenantMember(
	kv: KVNamespace,
	slug: TenantId
): Promise<void> {
	await kv.delete(tenantMemberKey(slug));
}

type MemberLookup = 'present' | 'absent' | 'error';

// Tier 2: the per-tenant marker resolves a filter positive. A definitive miss is
// a 404 with no D1; a KV fault is the fail-open path, deferring to the row read.
// The miss/error split is load-bearing: a miss means "not a tenant", an error
// means "cache unavailable".
async function lookupTenantMember(
	kv: KVNamespace,
	slug: TenantId
): Promise<MemberLookup> {
	try {
		const value = await kv.get(tenantMemberKey(slug), {
			cacheTtl: memberKeyCacheTtlSeconds
		});

		return value === null ? 'absent' : 'present';
	} catch {
		return 'error';
	}
}

export function buildMembershipFilter(slugs: readonly TenantId[]): Uint8Array {
	return BinaryFuse8.build(slugs).serialise();
}

function filterCacheKey(): Request {
	return new Request('https://tenant-filter.cupboard.invalid/current');
}

function deserialiseFilter(bytes: Uint8Array): BinaryFuse8 | undefined {
	try {
		return BinaryFuse8.deserialise(bytes);
	} catch {
		return undefined;
	}
}

// Tier 1: the membership filter, served from the colo's edge cache and refetched
// from KV on a miss. Returns `undefined` when the filter is unavailable (missing,
// unparseable, or a KV fault), so the caller falls open to tier 2. The edge cache
// keeps the per-request lookup off the network without
// any module-scoped state; a rebuild purges the local entry to refetch promptly.
async function loadMembershipFilter(
	env: Env,
	ctx: DeferredContext
): Promise<BinaryFuse8 | undefined> {
	const cacheKey = filterCacheKey();
	const cached = await caches.default.match(cacheKey);

	if (cached !== undefined) {
		return deserialiseFilter(new Uint8Array(await cached.arrayBuffer()));
	}

	let bytes: ArrayBuffer | null;

	try {
		bytes = await env.TENANT_CACHE.get(filterKey, 'arrayBuffer');
	} catch {
		return undefined;
	}

	if (bytes === null) {
		return undefined;
	}

	const cacheControl = `max-age=${String(filterCacheTtlSeconds)}`;
	const cachedResponse = new Response(bytes, {
		headers: { 'cache-control': cacheControl }
	});
	ctx.waitUntil(caches.default.put(cacheKey, cachedResponse));

	return deserialiseFilter(new Uint8Array(bytes));
}

const tenantAdmissionColumns = {
	status: d1Schema.tenant.status,
	readUser: d1Schema.tenant.readUser,
	readPasswordHash: d1Schema.tenant.readPasswordHash,
	readPasswordSalt: d1Schema.tenant.readPasswordSalt
};

const cacheCredentialColumns = {
	readUser: d1Schema.tenantCacheReadCredential.readUser,
	readPasswordHash: d1Schema.tenantCacheReadCredential.readPasswordHash,
	readPasswordSalt: d1Schema.tenantCacheReadCredential.readPasswordSalt
};

// Every push and fetch depends on this authoritative row. Retry one transient
// D1 failure, then return a retryable refusal for a persistent failure.
async function readTenantAndCacheRows(
	database: Database,
	slug: TenantId,
	cache: CacheScope
): Promise<{
	tenant: TenantAdmissionRow | undefined;
	credential: TenantReadVerifier | undefined;
	cache:
		| { readonly access: CacheAccessMode; readonly isDeleted: boolean }
		| undefined;
}> {
	const credentialRow = and(
		eq(d1Schema.tenantCacheReadCredential.tenant, slug),
		cacheIdentityCondition(
			d1Schema.tenantCacheReadCredential.cacheKind,
			d1Schema.tenantCacheReadCredential.cacheName,
			cache
		)
	);
	const lifecycleRow = and(
		eq(d1Schema.cacheLifecycle.tenant, slug),
		cacheIdentityCondition(
			d1Schema.cacheLifecycle.cacheKind,
			d1Schema.cacheLifecycle.cacheName,
			cache
		)
	);

	try {
		const [tenantRows, credentialRows, lifecycleRows] = await readWithOneRetry(
			() =>
				database.batch([
					database
						.select(tenantAdmissionColumns)
						.from(d1Schema.tenant)
						.where(eq(d1Schema.tenant.id, slug)),
					database
						.select(cacheCredentialColumns)
						.from(d1Schema.tenantCacheReadCredential)
						.where(credentialRow),
					database
						.select({
							access: d1Schema.cacheLifecycle.access,
							deletedAt: d1Schema.cacheLifecycle.deletedAt
						})
						.from(d1Schema.cacheLifecycle)
						.where(lifecycleRow)
				])
		);
		const credential = credentialRows[0];
		const lifecycle = lifecycleRows[0];

		return {
			tenant: tenantRows[0],
			credential:
				credential === undefined
					? undefined
					: {
							user: credential.readUser,
							passwordHash: credential.readPasswordHash,
							passwordSalt: credential.readPasswordSalt
						},
			cache:
				lifecycle === undefined
					? undefined
					: {
							access: lifecycle.access,
							isDeleted: lifecycle.deletedAt !== null
						}
		};
	} catch (error) {
		throw new TenantAdmissionUnavailableError(error);
	}
}

interface TenantAdmissionRow {
	status: TenantEntry['status'];
	readUser: ReadUser | null;
	readPasswordHash: ReadPasswordHash | null;
	readPasswordSalt: ReadPasswordSalt | null;
}

function entryFromRow(row: TenantAdmissionRow): TenantEntry {
	if (
		row.readUser !== null &&
		row.readPasswordHash !== null &&
		row.readPasswordSalt !== null
	) {
		return {
			status: row.status,
			readVerifier: {
				user: row.readUser,
				passwordHash: row.readPasswordHash,
				passwordSalt: row.readPasswordSalt
			}
		};
	}

	return { status: row.status };
}

export async function readTenantReadVerifier(
	database: Database,
	slug: TenantId
): Promise<TenantReadVerifier | undefined> {
	const row = await readWithOneRetry(() =>
		database
			.select(tenantAdmissionColumns)
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, slug))
			.get()
	);

	return row === undefined ? undefined : entryFromRow(row).readVerifier;
}

// Tier 3 reads the authoritative tenant row, selected cache lifecycle and
// cache-specific credential. It reads D1 directly, so lifecycle and credential
// changes take effect as soon as the control API commits them.
async function readTenantEntry(
	env: Env,
	slug: TenantId,
	cache: CacheScope
): Promise<TenantAdmission | undefined> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const rows = await readTenantAndCacheRows(database, slug, cache);

	if (rows.tenant === undefined || rows.tenant.status === 'offboarded') {
		return undefined;
	}

	const entry = entryFromRow(rows.tenant);
	const admission = { entry, fresh: true, cache: rows.cache };

	if (rows.credential === undefined) {
		return admission;
	}

	return { ...admission, cacheVerifier: rows.credential };
}

/**
 * Admits a tenant request. The membership filter and marker reject unknown
 * slugs, while a cache fault falls through to the authoritative D1 read.
 *
 * Admission resolves the selected cache's access before routing can authenticate
 * the request or consult Workers Cache.
 */
export async function admitTenant(
	env: Env,
	ctx: DeferredContext,
	slug: TenantId,
	cache: CacheScope
): Promise<TenantAdmission | undefined> {
	const filter = await loadMembershipFilter(env, ctx);

	if (filter !== undefined && !filter.has(slug)) {
		return undefined;
	}

	const member = await lookupTenantMember(env.TENANT_CACHE, slug);

	if (member === 'absent') {
		return undefined;
	}

	return readTenantEntry(env, slug, cache);
}

// Scheduled maintenance rebuilds the filter from one registry snapshot and
// reasserts every live tenant's marker. Reassertion repairs a marker lost during
// creation, which keeps a definitive marker miss safe to return as 404.
export async function refreshTenantMembership(env: Env): Promise<number> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const live = await liveTenantSlugs(database);

	await Promise.all(
		live.map((slug) => writeTenantMember(env.TENANT_CACHE, slug))
	);
	await publishMembershipFilter(env, live);

	return live.length;
}

// Rebuild the filter after creation so the new tenant becomes admissible within
// the filter cache TTL instead of waiting for scheduled maintenance. This is
// the only writer of the filter key, so a negative result remains definitive
// until a later rebuild includes the tenant.
export async function rebuildMembershipFilter(env: Env): Promise<void> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	await publishMembershipFilter(env, await liveTenantSlugs(database));
}

async function publishMembershipFilter(
	env: Env,
	live: readonly TenantId[]
): Promise<void> {
	await env.TENANT_CACHE.put(filterKey, buildMembershipFilter(live));
	// Drop this colo's cached filter so it refetches the rebuilt one promptly;
	// other colos pick it up on their cache TTL.
	await caches.default.delete(filterCacheKey());
}

async function liveTenantSlugs(database: Database): Promise<TenantId[]> {
	const rows = await database
		.select({ id: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.where(ne(d1Schema.tenant.status, 'offboarded'))
		.all();

	return rows.map((row) => row.id);
}

// Kept as the mutation-call boundary while deployments with the old row-cache
// code drain. Current admission always reads D1 and needs no local invalidation.
export function invalidateTenantRow(_slug: TenantId): Promise<void> {
	return Promise.resolve();
}
