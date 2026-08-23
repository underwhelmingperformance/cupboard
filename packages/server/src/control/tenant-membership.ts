import { type TenantId } from '@cupboard/nix-store/scalars';
import {
	type TenantReadMode,
	tenantReadModeSchema,
	type TenantStatus,
	tenantStatusSchema
} from '@cupboard/protocol/tenants';
import { type ReadUser, readUserSchema } from '@cupboard/shared/http';
import { eq, ne } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import { readWithOneRetry } from '../db/transient.ts';
import { TenantAdmissionUnavailableError } from '../errors.ts';
import {
	type ReadPasswordHash,
	readPasswordHashSchema,
	type ReadPasswordSalt,
	readPasswordSaltSchema
} from '../read/read-auth.ts';

import { BinaryFuse8 } from './binary-fuse-filter/index.ts';

// Admission first checks an in-memory filter, then a per-tenant KV marker, and
// finally the authoritative D1 row. The first two layers can reject a slug or
// fall through, but cannot admit it. Missing or unreadable cache data therefore
// adds D1 work instead of making a live tenant unavailable.

type Database = DrizzleD1Database<typeof d1Schema>;

const memberKeyPrefix = 'tenant-member:';
const filterKey = 'tenant-filter';

// How long a colo trusts its cached filter and a cached public row before
// refetching. Both are ceilings: an early eviction only costs an extra read,
// never correctness, and a mutation purges the local entry to take effect sooner.
const filterCacheTtlSeconds = 10;
const rowCacheTtlSeconds = 10;
// KV reads of the per-tenant marker are edge-cached for at least this long, so a
// repeated probe for the same slug is self-limiting. Tier 1 already absorbs
// distinct-slug spray, so this only blunts repeated probes.
const memberKeyCacheTtlSeconds = 60;

const tenantReadVerifierSchema = z.object({
	user: readUserSchema,
	passwordHash: readPasswordHashSchema,
	passwordSalt: readPasswordSaltSchema
});

export type TenantReadVerifier = z.infer<typeof tenantReadVerifierSchema>;

export interface TenantEntry {
	readonly status: TenantStatus;
	readonly readMode: TenantReadMode;
	readonly readVerifier?: TenantReadVerifier;
}

// A write can trust a fresh D1 status. A cached entry may lag a suspension, so
// the write path must confirm its status against D1 before dispatch.
export interface TenantAdmission {
	readonly entry: TenantEntry;
	readonly fresh: boolean;
}

interface DeferredContext {
	waitUntil(promise: Promise<unknown>): void;
}

const tenantEntrySchema = z.object({
	status: tenantStatusSchema,
	readMode: tenantReadModeSchema,
	readVerifier: tenantReadVerifierSchema.optional()
});

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

function rowCacheKey(slug: TenantId): Request {
	return new Request(
		`https://tenant-row.cupboard.invalid/${encodeURIComponent(slug)}`
	);
}

// Every content request depends on this row. After the bounded retry, report a
// persistent D1 fault as a retryable refusal rather than an internal error.
async function readTenantRow(
	database: Database,
	slug: TenantId
): Promise<TenantAdmissionRow | undefined> {
	try {
		return await readWithOneRetry(() =>
			database
				.select({
					status: d1Schema.tenant.status,
					readMode: d1Schema.tenant.readMode,
					readUser: d1Schema.tenant.readUser,
					readPasswordHash: d1Schema.tenant.readPasswordHash,
					readPasswordSalt: d1Schema.tenant.readPasswordSalt
				})
				.from(d1Schema.tenant)
				.where(eq(d1Schema.tenant.id, slug))
				.get()
		);
	} catch (error) {
		throw new TenantAdmissionUnavailableError(error);
	}
}

interface TenantAdmissionRow {
	status: TenantEntry['status'];
	readMode: TenantEntry['readMode'];
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
			readMode: row.readMode,
			readVerifier: {
				user: row.readUser,
				passwordHash: row.readPasswordHash,
				passwordSalt: row.readPasswordSalt
			}
		};
	}

	return { status: row.status, readMode: row.readMode };
}

// Tier 3 reads one authoritative row. Public entries have a short edge-cache
// TTL. Private entries are never cached, so credential rotation and revocation
// take effect immediately.
async function readTenantEntry(
	env: Env,
	ctx: DeferredContext,
	slug: TenantId
): Promise<TenantAdmission | undefined> {
	const cacheKey = rowCacheKey(slug);
	const cached = await caches.default.match(cacheKey);

	if (cached !== undefined) {
		const parsed = tenantEntrySchema.safeParse(await cached.json());

		if (parsed.success) {
			return { entry: parsed.data, fresh: false };
		}
	}

	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const row = await readTenantRow(database, slug);

	if (row === undefined || row.status === 'offboarded') {
		return undefined;
	}

	const entry = entryFromRow(row);

	if (entry.readMode === 'public') {
		const cacheControl = `max-age=${String(rowCacheTtlSeconds)}`;
		const cachedResponse = Response.json(entry, {
			headers: { 'cache-control': cacheControl }
		});
		ctx.waitUntil(caches.default.put(cacheKey, cachedResponse));
	}

	return { entry, fresh: true };
}

// Returns the tenant's admission entry, or undefined when the layered gate can
// prove that the slug is absent. A cache fault falls through to the authoritative
// D1 row instead of rejecting the tenant.
export async function admitTenant(
	env: Env,
	ctx: DeferredContext,
	slug: TenantId
): Promise<TenantAdmission | undefined> {
	const filter = await loadMembershipFilter(env, ctx);

	if (filter !== undefined && !filter.has(slug)) {
		return undefined;
	}

	const member = await lookupTenantMember(env.TENANT_CACHE, slug);

	if (member === 'absent') {
		return undefined;
	}

	return readTenantEntry(env, ctx, slug);
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

// After creation, publish the live registry immediately so the new tenant need
// not wait for scheduled maintenance. This is the sole writer of the filter key;
// a negative result remains definitive until a later rebuild includes the tenant.
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

// Invalidates a tenant's cached row in this colo, so a status, readMode, or
// credential change made here takes effect without waiting on the row TTL. The
// control plane calls this when it mutates a tenant. Best-effort and per-colo:
// other colos refresh on their own TTL.
export async function invalidateTenantRow(slug: TenantId): Promise<void> {
	try {
		await caches.default.delete(rowCacheKey(slug));
	} catch {
		// A failed purge only leaves the row cached until its TTL, so a mutation
		// must not fail on it; the row TTL is the backstop.
	}
}
