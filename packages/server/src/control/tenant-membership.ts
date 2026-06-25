import { type TenantId } from '@cupboard/nix-store/scalars';
import { eq, ne } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';

import { BinaryFuse8 } from './binary-fuse-filter/index.ts';

// The admission gate is layered: an in-memory membership filter (tier 1) rejects
// unknown slugs with no network call, a per-tenant KV marker (tier 2) resolves
// the filter's false positives at KV cost, and the authoritative D1 `tenant` row
// (tier 3) decides admission. Tiers 1-2 are a negative cache that can only reject
// or fall through, never admit, so the row read is always the real gate and the
// global artifacts can never cause an availability outage, only extra D1 cost.

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

// A private cache's read verifier as the admission entry carries it: the
// Basic-auth user and the salted hash of its password, never the plaintext.
const tenantReadVerifierSchema = z.object({
	user: z.string(),
	passwordHash: z.string(),
	passwordSalt: z.string()
});

export type TenantReadVerifier = z.infer<typeof tenantReadVerifierSchema>;

// What admission resolves for a provisioned slug: the authoritative row fields the
// read and dispatch paths gate on. Built from the single `tenant` row, so it never
// reflects a torn or stale aggregate.
export interface TenantEntry {
	readonly status: 'active' | 'suspended' | 'offboarding' | 'offboarded';
	readonly readMode: 'public' | 'private';
	readonly readVerifier?: TenantReadVerifier;
}

// The slice of the execution context admission needs: deferred row-cache writes.
// A structural subset of `ExecutionContext`, matching the read path, so a Hono
// `executionCtx` passes without the global-type mismatch.
interface DeferredContext {
	waitUntil(promise: Promise<unknown>): void;
}

const tenantEntrySchema = z.object({
	status: z.enum(['active', 'suspended', 'offboarding', 'offboarded']),
	readMode: z.enum(['public', 'private']),
	readVerifier: tenantReadVerifierSchema.optional()
});

export function tenantMemberKey(slug: string): string {
	return `${memberKeyPrefix}${slug}`;
}

// Writes the per-tenant membership marker. Reliable on create (the caller awaits
// and retries), with the cron reconcile as a backstop, so a tier-2 miss is a
// sound 404: every live tenant's marker is present or reasserted within a tick.
export async function writeTenantMember(
	kv: KVNamespace,
	slug: string
): Promise<void> {
	await kv.put(tenantMemberKey(slug), '1');
}

export async function deleteTenantMember(
	kv: KVNamespace,
	slug: string
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
	slug: string
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

// The membership filter is a binary fuse8: a static, immutable structure with no
// false negatives, built wholesale from the live slug set and queried read-only,
// exactly as the cron rebuild and the admission gate use it.
export function buildMembershipFilter(slugs: readonly string[]): Uint8Array {
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
// unparseable, or a KV fault), so the caller falls open to tier 2 rather than
// rejecting. The edge cache keeps the per-request lookup off the network without
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

function rowCacheKey(slug: string): Request {
	return new Request(
		`https://tenant-row.cupboard.invalid/${encodeURIComponent(slug)}`
	);
}

function entryFromRow(row: {
	status: TenantEntry['status'];
	readMode: TenantEntry['readMode'];
	readUser: string | null;
	readPasswordHash: string | null;
	readPasswordSalt: string | null;
}): TenantEntry {
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

// Tier 3: the authoritative single-row read. A public tenant's entry is cached at
// the edge for a short TTL; a private tenant's is never cached, so a rotated or
// revoked read credential takes effect at once. The single-row read is atomic, so
// there is no torn read and nothing staged.
async function readTenantEntry(
	env: Env,
	ctx: DeferredContext,
	slug: TenantId
): Promise<TenantEntry | undefined> {
	const cacheKey = rowCacheKey(slug);
	const cached = await caches.default.match(cacheKey);

	if (cached !== undefined) {
		const parsed = tenantEntrySchema.safeParse(await cached.json());

		if (parsed.success) {
			return parsed.data;
		}
	}

	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const row = await database
		.select({
			status: d1Schema.tenant.status,
			readMode: d1Schema.tenant.readMode,
			readUser: d1Schema.tenant.readUser,
			readPasswordHash: d1Schema.tenant.readPasswordHash,
			readPasswordSalt: d1Schema.tenant.readPasswordSalt
		})
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, slug))
		.get();

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

	return entry;
}

// Resolves a tenant slug through the layered gate, returning its authoritative
// entry or `undefined` for a slug that is not an admittable tenant. Reads only KV
// for known-absent and most present slugs; the D1 row is consulted on a filter
// positive with a present marker, or whenever a KV fault forces fail-open.
export async function admitTenant(
	env: Env,
	ctx: DeferredContext,
	slug: TenantId
): Promise<TenantEntry | undefined> {
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

// Rebuilds the membership filter from the authoritative registry and reasserts
// every live tenant's marker, run inline each cron tick. Building the filter as a
// unit gives it a well-defined as-of; reasserting the markers backstops a
// create-write that was dropped, so a tier-2 miss stays a sound 404. Returns the
// number of live tenants now carried, so a caller can report what it repaired.
export async function refreshTenantMembership(env: Env): Promise<number> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const live = await liveTenantSlugs(database);

	await Promise.all(
		live.map((slug) => writeTenantMember(env.TENANT_CACHE, slug))
	);
	await publishMembershipFilter(env, live);

	return live.length;
}

// Rebuilds and republishes just the membership filter from the live registry, the
// sole writer of the filter key. The control plane calls this after a create so a
// new tenant is admittable within the filter cache TTL rather than waiting on the
// hourly cron, without rewriting every marker. A filter negative is definitive, so
// a tenant absent from the filter 404s at tier 1 until a rebuild includes it.
export async function rebuildMembershipFilter(env: Env): Promise<void> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	await publishMembershipFilter(env, await liveTenantSlugs(database));
}

async function publishMembershipFilter(
	env: Env,
	live: readonly string[]
): Promise<void> {
	await env.TENANT_CACHE.put(filterKey, buildMembershipFilter(live));
	// Drop this colo's cached filter so it refetches the rebuilt one promptly;
	// other colos pick it up on their cache TTL.
	await caches.default.delete(filterCacheKey());
}

async function liveTenantSlugs(database: Database): Promise<string[]> {
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
export async function invalidateTenantRow(slug: string): Promise<void> {
	try {
		await caches.default.delete(rowCacheKey(slug));
	} catch {
		// A failed purge only leaves the row cached until its TTL, so a mutation
		// must not fail on it; the row TTL is the backstop.
	}
}
