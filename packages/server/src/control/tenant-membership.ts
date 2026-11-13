import { rootLogger } from '@cupboard/logger';
import {
	type CacheAccessMode,
	type CacheScope,
	firstCacheGeneration,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	kvOperationsPerInvocation,
	kvOperationsReserve
} from '@cupboard/protocol/platform';
import { type TenantStatus } from '@cupboard/protocol/tenants';
import { type ReadUser } from '@cupboard/shared/http';
import { and, eq, gt, lte, ne } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';

import { cacheIdentityCondition } from '../db/cache.ts';
import {
	type CacheLifecycleVersion,
	firstCacheReadRevision
} from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { readWithOneRetry } from '../db/transient.ts';
import {
	boundedSubrequest,
	SharedDeadline,
	unboundedCapMs
} from '../do/deadline.ts';
import { TenantAdmissionUnavailableError } from '../errors.ts';
import { cacheCatalogueVersion } from '../migration/cache-access.ts';
import { readRequestBudgetMs } from '../policy/streaming.ts';
import {
	type ReadPasswordHash,
	type ReadPasswordSalt
} from '../read/read-auth.ts';
import { tenantServer } from '../routing/durable-object.ts';

import { BinaryFuse8 } from './binary-fuse-filter/index.ts';
import {
	tenantMemberKey,
	tenantMemberKeyPrefix,
	tenantMemberSlug
} from './tenant-member-key.ts';

// Admission first checks an in-memory filter, then a per-tenant KV marker, and
// finally the authoritative D1 row. The first two layers can reject a slug or
// fall through, but cannot admit it. Missing or unreadable cache data therefore
// adds D1 work instead of making a live tenant unavailable.

type Database = DrizzleD1Database<typeof d1Schema>;

const filterKey = 'tenant-filter';
const defaultCacheScope: CacheScope = { kind: 'default' };

// How long a colo trusts its cached filter before refetching. The filter only
// rejects unknown tenants; it never supplies security-sensitive tenant state.
const filterCacheTtlSeconds = 10;
// KV reads of the per-tenant marker are edge-cached for at least this long, so a
// repeated probe for the same slug is self-limiting. Tier 1 already absorbs
// distinct-slug spray, so this only blunts repeated probes.
const memberKeyCacheTtlSeconds = 60;

/**
A read verifier loaded from D1. It can come from the authoritative tenant row
or from one private cache's credential row.
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
	// The generation and read revision of the addressed cache. The Workers
	// Cache key of a public read carries both, so a response the previous cache
	// of that name produced is not served.
	readonly cacheVersion: CacheLifecycleVersion;
}

// The version assumed for a cache with no lifecycle row. A deletion always
// writes the row, so a cache without one has never been deleted and has no
// earlier incarnation.
const firstCacheVersion: CacheLifecycleVersion = {
	generation: firstCacheGeneration,
	readRevision: firstCacheReadRevision
};

interface DeferredContext {
	waitUntil(promise: Promise<unknown>): void;
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
		const value = await boundedSubrequest(
			() =>
				kv.get(tenantMemberKey(slug), { cacheTtl: memberKeyCacheTtlSeconds }),
			'kv.get',
			unboundedCapMs
		);

		return value === null ? 'absent' : 'present';
	} catch {
		return 'error';
	}
}

export function buildMembershipFilter(slugs: readonly TenantId[]): Uint8Array {
	return BinaryFuse8.build(slugs).serialise();
}

/**
The Cache API key of the membership filter. Every Worker in a zone shares
the Cache API, so two deployments with custom domains in one zone would
otherwise read each other's filter and reject each other's tenants. Each
deployment's tenant Worker has its own Durable Object namespace, and
`idFromName` derives an ID from the namespace without any I/O, so the ID of a
fixed name identifies the deployment in every request, cron and queue
context.
*/
export function membershipFilterCacheKey(
	deployment: Pick<DurableObjectNamespace, 'idFromName'>
): Request {
	const id = deployment.idFromName('cache-key:tenant-filter').toString();

	return new Request(`https://tenant-filter.cupboard.invalid/${id}`);
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
	const cacheKey = membershipFilterCacheKey(env.CUPBOARD_DO);
	const cached = await boundedSubrequest(
		async () => {
			const response = await caches.default.match(cacheKey);

			return response === undefined
				? undefined
				: new Uint8Array(await response.arrayBuffer());
		},
		'cache.match',
		unboundedCapMs
	);

	if (cached !== undefined) {
		return deserialiseFilter(cached);
	}

	let bytes: ArrayBuffer | null;

	try {
		bytes = await boundedSubrequest(
			() => env.TENANT_CACHE.get(filterKey, 'arrayBuffer'),
			'kv.get',
			unboundedCapMs
		);
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
	cacheCatalogueVersion: d1Schema.tenant.cacheCatalogueVersion,
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
// Reads the tenant row, the addressed cache's credential row and its lifecycle
// row in one D1 batch.
async function readTenantAndCacheRows(
	database: Database,
	slug: TenantId,
	cache: CacheScope,
	phase: RefusalPhase
): Promise<{
	tenant: TenantAdmissionRow | undefined;
	credential: TenantReadVerifier | undefined;
	cache:
		| { readonly access: CacheAccessMode; readonly isDeleted: boolean }
		| undefined;
	version: CacheLifecycleVersion;
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
							generation: d1Schema.cacheLifecycle.generation,
							readRevision: d1Schema.cacheLifecycle.readRevision,
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
						},
			version:
				lifecycle === undefined
					? firstCacheVersion
					: {
							generation: lifecycle.generation,
							readRevision: lifecycle.readRevision
						}
		};
	} catch (error) {
		throw tenantRefusal(phase, slug, 'tenant-and-cache-rows', error);
	}
}

/**
When in a request the failed step ran. `admission` is the step that decides
whether the request may proceed. `recheck` is a D1 read after admission that
confirms the tenant's status or the cache's read authority again.
*/
export type RefusalPhase = 'admission' | 'recheck';

type RefusalStep =
	'tenant-and-cache-rows' | 'cache-catalogue-migration' | 'tenant-status';

const refusalMessages: Record<RefusalPhase, string> = {
	admission: 'tenant admission refused',
	recheck: 'tenant recheck refused'
};

/**
Creates the retryable refusal for a failed read and logs the underlying
error at `warn`. The 503 response does not contain the error, so the record
shows why the read failed.
*/
export function tenantRefusal(
	phase: RefusalPhase,
	tenant: TenantId,
	step: RefusalStep,
	error: unknown
): TenantAdmissionUnavailableError {
	rootLogger().warn(refusalMessages[phase], { tenant, step, error });

	return new TenantAdmissionUnavailableError(error);
}

interface TenantAdmissionRow {
	status: TenantEntry['status'];
	cacheCatalogueVersion: number | null;
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

// Tier 3 reads the authoritative tenant row and the addressed cache's
// credential and lifecycle rows. It reads D1 directly, so suspension, deletion
// and credential changes take effect as soon as the control API commits them.
export async function readTenantEntry(
	env: Env,
	slug: TenantId,
	cache: CacheScope,
	phase: RefusalPhase
): Promise<TenantAdmission | undefined> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	let rows = await readTenantAndCacheRows(database, slug, cache, phase);

	if (rows.tenant === undefined || rows.tenant.status === 'offboarded') {
		return undefined;
	}

	if (rows.tenant.cacheCatalogueVersion !== cacheCatalogueVersion) {
		try {
			await boundedSubrequest(
				() => tenantServer(env, slug).migrateCacheCatalogue(slug),
				'tenant.migrateCacheCatalogue',
				unboundedCapMs
			);
		} catch (error) {
			throw tenantRefusal(phase, slug, 'cache-catalogue-migration', error);
		}

		rows = await readTenantAndCacheRows(database, slug, cache, phase);

		if (rows.tenant === undefined || rows.tenant.status === 'offboarded') {
			return undefined;
		}
	}

	const entry = entryFromRow(rows.tenant);
	const admission = {
		entry,
		fresh: true,
		cache: rows.cache,
		cacheVersion: rows.version
	};

	if (rows.credential === undefined) {
		return admission;
	}

	return { ...admission, cacheVerifier: rows.credential };
}

/**
Admits a tenant request. The membership filter and marker reject unknown
slugs, while a cache fault falls through to the authoritative D1 read.

Pass the cache the request addresses. Admission resolves that cache's access,
lifecycle version, deletion state and cache-specific verifier before routing
can authenticate the request or consult Workers Cache.

Admission runs within `deadline`, or within an enclosing deadline that ends
sooner. The scope ends when admission returns, so it does not bound the
request's response or the work after admission. Pass the deadline that a
later step of the same request, such as the check of a read token, also
runs within, so that the two steps share one budget.
*/
export function admitTenant(
	env: Env,
	ctx: DeferredContext,
	slug: TenantId,
	cache: CacheScope = defaultCacheScope,
	deadline = new SharedDeadline(readRequestBudgetMs)
): Promise<TenantAdmission | undefined> {
	return deadline.run(
		() => admitWithinDeadline(env, ctx, slug, cache),
		'tenant.admission'
	);
}

async function admitWithinDeadline(
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

	return readTenantEntry(env, slug, cache, 'admission');
}

/**
The number of markers that one refresh page writes. Each marker is one KV
operation, so a page writes as many markers as the KV operations of an
invocation allow, less the reserve of KV operations.
*/
export const membershipMarkersPerPage =
	kvOperationsPerInvocation - kvOperationsReserve;

/**
A queued step of the membership reconcile. It continues from `after` and
`listCursor`, which `MembershipReconcilePosition` describes. A message from an
earlier build has only `after`. The step then lists the markers from the start
and skips the ones that sort at or before `after`.
*/
export interface MembershipRefreshMessage {
	readonly kind: 'membership-refresh';
	readonly after?: TenantId | undefined;
	readonly listCursor?: string | undefined;
}

type MembershipRefreshQueue = Pick<
	Queue<MembershipRefreshMessage>,
	'sendBatch'
>;

export interface MembershipRefreshPage {
	/**
	The number of markers that the page wrote.
	*/
	readonly written: number;
	/**
	The id of the last tenant of the page, present when more live tenants
	follow it.
	*/
	readonly cursor?: TenantId;
}

// Writes every live tenant's marker and rebuilds the filter in one invocation,
// so it fails on a deployment with more live tenants than the KV operations of
// an invocation (`kvOperationsPerInvocation`). It serves the legacy
// `membership.rebuild` request and the test harness. Reassertion repairs a
// marker lost during creation, which keeps a definitive marker miss safe to
// return as 404.
export async function refreshTenantMembership(env: Env): Promise<number> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const live = await liveTenantSlugs(database);

	await Promise.all(
		live.map((slug) => writeTenantMember(env.TENANT_CACHE, slug))
	);
	await publishMembershipFilter(env, live);

	return live.length;
}

/**
Writes the markers of one page of live tenants, in id order after `after`, or
from the first tenant. The first page also rebuilds the filter from the
registry. The `membership.rebuild` procedure calls it for each request that has
a `page`. It writes every marker of the page, because a deploy that changes the
admission format needs every marker reasserted. The cron uses
`reconcileTenantMembership` instead.
*/
export async function refreshTenantMembershipPage(
	env: Env,
	after?: TenantId
): Promise<MembershipRefreshPage> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const size = membershipMarkersPerPage;
	const rows = await liveTenantSlugs(database, { after, limit: size + 1 });
	const page = rows.slice(0, size);
	const last = page.at(-1);
	const hasMore = last !== undefined && rows.length > page.length;

	await Promise.all(
		page.map((slug) => writeTenantMember(env.TENANT_CACHE, slug))
	);

	if (after === undefined) {
		if (hasMore) {
			await rebuildMembershipFilter(env);
		} else {
			await publishMembershipFilter(env, page);
		}
	}

	return { written: page.length, ...(hasMore && { cursor: last }) };
}

/**
Where a membership reconcile continues. Every slug that sorts at or before
`after` is already reconciled. `listCursor` is the KV listing cursor of the
page that contains the first marker after `after`, and is absent when that page
is the first one.
*/
export interface MembershipReconcilePosition {
	readonly after?: TenantId | undefined;
	readonly listCursor?: string | undefined;
}

/**
What one step of the membership reconcile did.
*/
export interface MembershipReconcileStep {
	/**
	The number of markers that the step wrote.
	*/
	readonly written: number;
	/**
	The number of stale markers that the step deleted.
	*/
	readonly deleted: number;
	/**
	Where the next step continues. It is present while markers or live
	tenants remain after this step.
	*/
	readonly next?: MembershipReconcilePosition;
}

// The most keys that one KV listing returns.
const kvListLimit = 1000;

// The most pages that a step skips to reach the first marker after `after`.
// Each skipped page is a KV operation, so it reduces the writes and deletes of
// the step.
const maxSkippedListPages = 100;

// A page of the KV listing. KV can return a page with no keys while it is not
// complete, because it steps over the tombstones of deleted keys. Such a page
// covers no slug. A key whose slug is not a tenant id is not a marker that this
// code wrote, and no admission lookup uses it, so the page leaves it out.
interface MarkerPage {
	readonly slugs: readonly TenantId[];
	readonly isComplete: boolean;
	readonly cursor: string | undefined;
}

async function listMarkerPage(
	kv: KVNamespace,
	cursor: string | undefined
): Promise<MarkerPage> {
	const listing = await kv.list({
		prefix: tenantMemberKeyPrefix,
		limit: kvListLimit,
		...(cursor !== undefined && { cursor })
	});
	const slugs = listing.keys
		.map((key) => tenantIdSchema.safeParse(tenantMemberSlug(key.name)))
		.filter((parsed) => parsed.success)
		.map((parsed) => parsed.data);

	return listing.list_complete
		? { slugs, isComplete: true, cursor: undefined }
		: { slugs, isComplete: false, cursor: listing.cursor };
}

// Lists the page of markers that starts at `cursor`. Earlier steps write
// markers that sort before `after`, so a cursor from before those writes can
// lead to a page whose markers all sort at or before `after`. The function
// skips such pages, and pages that cover no slug. It returns the cursor that
// leads to the page that it returns, so the step can continue from that page.
async function listMarkersAfter(
	kv: KVNamespace,
	after: TenantId | undefined,
	cursor: string | undefined
): Promise<{
	page: MarkerPage;
	cursor: string | undefined;
	skipped: number;
}> {
	let current = cursor;
	let skipped = 0;
	let page = await listMarkerPage(kv, current);

	while (
		!page.isComplete &&
		skipped < maxSkippedListPages &&
		isBeforeOrAt(page.slugs.at(-1), after)
	) {
		current = page.cursor;
		skipped += 1;
		page = await listMarkerPage(kv, current);
	}

	return { page, cursor: current, skipped };
}

// Whether a page whose last slug is `last` has nothing after `after`. A page
// with no slug has nothing after any slug.
function isBeforeOrAt(
	last: TenantId | undefined,
	after: TenantId | undefined
): boolean {
	return last === undefined || (after !== undefined && last <= after);
}

function laterSlug(
	left: TenantId | undefined,
	right: TenantId | undefined
): TenantId | undefined {
	if (left === undefined || right === undefined) {
		return left ?? right;
	}

	return right > left ? right : left;
}

interface MarkerChange {
	readonly kind: 'write' | 'delete';
	readonly slug: TenantId;
}

// Compares the markers of one range with the live tenants of that range, both
// in slug order. A live tenant without a marker needs a write, and a marker
// without a live tenant needs a delete.
function markerChanges(
	markers: readonly TenantId[],
	live: readonly TenantId[]
): MarkerChange[] {
	const changes: MarkerChange[] = [];
	let marker = 0;
	let tenant = 0;

	while (marker < markers.length || tenant < live.length) {
		const markerSlug = markers[marker];
		const liveSlug = live[tenant];

		if (
			liveSlug !== undefined &&
			(markerSlug === undefined || liveSlug < markerSlug)
		) {
			changes.push({ kind: 'write', slug: liveSlug });
			tenant += 1;
			continue;
		}

		if (
			markerSlug !== undefined &&
			(liveSlug === undefined || markerSlug < liveSlug)
		) {
			changes.push({ kind: 'delete', slug: markerSlug });
			marker += 1;
			continue;
		}

		marker += 1;
		tenant += 1;
	}

	return changes;
}

/**
Reconciles one range of the membership markers with the live tenants. It lists
a page of markers and reads the live tenants in the range that the page covers.
It writes the markers that are missing and deletes the markers that have no live
tenant, so a range that is already correct makes no KV write. The first step,
which has no position, also writes the filter when its bytes differ from the
stored filter.

A step lists one page of up to 1,000 markers. It lists up to
`maxSkippedListPages` more pages while the cursor leads to pages that have
nothing after `after`. It makes at most `membershipMarkersPerPage` writes,
deletes and extra listings together, and the filter read and write. That
stays within the KV operations of an invocation. The cron runs the first step,
and the queued chain runs the others.
*/
export async function reconcileTenantMembership(
	env: Env,
	position: MembershipReconcilePosition = {}
): Promise<MembershipReconcileStep> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const { after, listCursor } = position;
	const isFirstStep = after === undefined && listCursor === undefined;

	// List before reading D1. A new tenant's row is inserted before its marker,
	// so a marker in the listing always has a row that the later read returns.
	// The reconcile therefore cannot delete the marker of a tenant that is being
	// created.
	const { page, cursor, skipped } = await listMarkersAfter(
		env.TENANT_CACHE,
		after,
		listCursor
	);

	// A page with no slug reaches this point only after the skip budget ends.
	// The page has no slug to bound a range of live tenants, so the step reads no
	// range from D1. The first step still reads every live tenant to publish the
	// filter. The step continues from the cursor of the page.
	if (!page.isComplete && page.slugs.length === 0) {
		if (isFirstStep) {
			await publishMembershipFilterIfChanged(
				env,
				await liveTenantSlugs(database)
			);
		}

		return {
			written: 0,
			deleted: 0,
			next: { after, listCursor: page.cursor }
		};
	}

	const listEnd = page.isComplete ? undefined : page.slugs.at(-1);
	const rowLimit = kvListLimit + membershipMarkersPerPage;
	const rows = await liveTenantSlugs(database, {
		after,
		upper: listEnd,
		limit: rowLimit + 1
	});
	const live = rows.slice(0, rowLimit);
	const lastLive = live.at(-1);
	const isTruncated = rows.length > live.length;

	// The step covers the slugs after `after`, up to the last live tenant that it
	// read when more follow, and otherwise up to the end of the listed page.
	const covered = isTruncated ? lastLive : listEnd;
	const markers = page.slugs.filter(
		(slug) =>
			(after === undefined || slug > after) &&
			(covered === undefined || slug <= covered)
	);
	const changes = markerChanges(markers, live);
	const applied = changes.slice(0, membershipMarkersPerPage - skipped);
	const lastApplied = applied.at(-1);

	await Promise.all(
		applied.map((change) =>
			change.kind === 'write'
				? writeTenantMember(env.TENANT_CACHE, change.slug)
				: deleteTenantMember(env.TENANT_CACHE, change.slug)
		)
	);

	if (isFirstStep) {
		// When the first step read every live tenant, the filter needs no second
		// read.
		const everyLive =
			listEnd === undefined && !isTruncated
				? live
				: await liveTenantSlugs(database);

		await publishMembershipFilterIfChanged(env, everyLive);
	}

	const written = applied.filter((change) => change.kind === 'write').length;
	const counts = { written, deleted: applied.length - written };

	if (lastApplied !== undefined && changes.length > applied.length) {
		return {
			...counts,
			next: { after: lastApplied.slug, listCursor: cursor }
		};
	}

	if (isTruncated && lastLive !== undefined) {
		return { ...counts, next: { after: lastLive, listCursor: cursor } };
	}

	if (page.isComplete) {
		return counts;
	}

	// The next step starts after this page. When every listed slug sorts at or
	// before `after`, `after` stays where it is.
	return {
		...counts,
		next: { after: laterSlug(after, listEnd), listCursor: page.cursor }
	};
}

/**
Runs a queued step of the membership reconcile. It queues the next step when
markers or live tenants remain after this one.
*/
export async function continueTenantMembershipRefresh(
	env: Env,
	message: MembershipRefreshMessage,
	queue: MembershipRefreshQueue = env.MAINTENANCE_QUEUE
): Promise<void> {
	const step = await reconcileTenantMembership(env, message);

	if (step.next !== undefined) {
		await queue.sendBatch([{ body: membershipRefreshMessage(step.next) }]);
	}
}

/**
The message for the step of the reconcile that continues from `position`.
*/
export function membershipRefreshMessage(
	position: MembershipReconcilePosition
): MembershipRefreshMessage {
	return { kind: 'membership-refresh', ...position };
}

// Rebuild the filter after creation so the new tenant becomes admissible within
// the filter cache TTL instead of waiting for scheduled maintenance. This is
// the only writer of the filter key, so a negative result remains definitive
// until a later rebuild includes the tenant.
export async function rebuildMembershipFilter(env: Env): Promise<void> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	await publishMembershipFilter(env, await liveTenantSlugs(database));
}

// Writes the filter only when its bytes differ from the stored filter. The
// build is deterministic for a sorted list of slugs, so an unchanged tenant set
// produces the stored bytes and the write is skipped.
async function publishMembershipFilterIfChanged(
	env: Env,
	live: readonly TenantId[]
): Promise<void> {
	const bytes = buildMembershipFilter(live);
	const stored = await env.TENANT_CACHE.get(filterKey, 'arrayBuffer');

	if (stored !== null && hasSameBytes(new Uint8Array(stored), bytes)) {
		return;
	}

	await publishFilterBytes(env, bytes);
}

function hasSameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return (
		left.length === right.length &&
		left.every((byte, index) => byte === right[index])
	);
}

async function publishMembershipFilter(
	env: Env,
	live: readonly TenantId[]
): Promise<void> {
	await publishFilterBytes(env, buildMembershipFilter(live));
}

async function publishFilterBytes(env: Env, bytes: Uint8Array): Promise<void> {
	await env.TENANT_CACHE.put(filterKey, bytes);
	// Drop this colo's cached filter so it refetches the rebuilt one promptly;
	// other colos pick it up on their cache TTL.
	await caches.default.delete(membershipFilterCacheKey(env.CUPBOARD_DO));
}

async function liveTenantSlugs(
	database: Database,
	range: {
		readonly after?: TenantId | undefined;
		readonly upper?: TenantId | undefined;
		readonly limit?: number;
	} = {}
): Promise<TenantId[]> {
	const query = database
		.select({ id: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.where(
			and(
				ne(d1Schema.tenant.status, 'offboarded'),
				range.after === undefined
					? undefined
					: gt(d1Schema.tenant.id, range.after),
				range.upper === undefined
					? undefined
					: lte(d1Schema.tenant.id, range.upper)
			)
		)
		.orderBy(d1Schema.tenant.id);
	const rows = await (range.limit === undefined
		? query.all()
		: query.limit(range.limit).all());

	return rows.map((row) => row.id);
}

// Kept as the mutation-call boundary while deployments with the old row-cache
// code drain. Current admission always reads D1 and needs no local invalidation.
export function invalidateTenantRow(_slug: TenantId): Promise<void> {
	return Promise.resolve();
}
