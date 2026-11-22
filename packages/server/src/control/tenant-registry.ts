import {
	firstCacheGeneration,
	type TenantId
} from '@cupboard/nix-store/scalars';
import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema
} from '@cupboard/protocol/oidc';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import {
	type TenantCreateBody,
	type TenantListResponse,
	type TenantQuota,
	type TenantQuotaResponse,
	type TenantSummary
} from '@cupboard/protocol/tenants';
import {
	and,
	eq,
	exists,
	gt,
	lte,
	ne,
	notExists,
	or,
	type SQL,
	sql
} from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import { cacheIdentityColumns, cacheIdentityCondition } from '../db/cache.ts';
import { firstCacheReadRevision } from '../db/cache-generation.ts';
import {
	type CacheLifecycleWriteTable,
	writeCacheLifecycle
} from '../db/cache-lifecycle-write.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	TenantAlreadyExistsError,
	TenantNotFoundError,
	TenantNotSuspendedError,
	TenantOffboardingError,
	TenantQuotaBelowUsageError,
	TenantRetiredError,
	TenantUsageMissingError,
	TenantUsageRepairRequiredError
} from '../errors.ts';
import { cacheCatalogueVersion } from '../migration/cache-access.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

type TenantRow = typeof d1Schema.tenant.$inferSelect;

function toSummary(row: TenantRow): TenantSummary {
	return {
		id: row.id,
		status: row.status,
		ownerIssuer: oidcIssuerSchema.parse(row.ownerIssuer),
		ownerSubject: oidcSubjectSchema.parse(row.ownerSubject),
		ownerAudience: oidcAudienceSchema.parse(row.ownerAudience),
		configVersion: row.configVersion,
		createdAt: row.createdAt
	};
}

async function hasSameConfig(
	database: Database,
	row: TenantRow,
	body: TenantCreateBody
): Promise<boolean> {
	const defaultCache = await database
		.select({ access: d1Schema.cacheLifecycle.access })
		.from(d1Schema.cacheLifecycle)
		.where(
			and(
				eq(d1Schema.cacheLifecycle.tenant, row.id),
				cacheIdentityCondition(
					d1Schema.cacheLifecycle.cacheKind,
					d1Schema.cacheLifecycle.cacheName,
					{ kind: 'default' }
				)
			)
		)
		.get();

	// A tenant row can exist without its default cache row: a crash between the
	// two writes leaves one, and so does a release that provisioned the tenant
	// before caches had lifecycle rows. There is no stored access to disagree
	// with, and `ensureTenant` writes the row once the rest of the configuration
	// matches, so an absent row is not a conflict. Comparing the access of a row
	// that may not be there would refuse every such repair.
	const isAccessMatching =
		defaultCache === undefined ||
		defaultCache.access === body.defaultCacheAccess;

	return (
		isAccessMatching &&
		row.ownerIssuer === body.ownerIssuer &&
		row.ownerSubject === body.ownerSubject &&
		row.ownerAudience === body.ownerAudience
	);
}

// Create the tenant, its default cache and its usage counter in one D1 batch.
// A concurrent matching request is idempotent; a different configuration for
// the same slug is a conflict after the stored rows are compared.
export async function ensureTenant(
	database: Database,
	body: TenantCreateBody,
	now: IsoTimestamp
): Promise<TenantSummary> {
	// The usage row carries the quota and the CHECK that enforces it, so a tenant
	// row without one accepts writes that nothing counts or limits. Write the
	// tenant, its default cache and its usage counter in one batch, which D1
	// applies as a single transaction. Take this branch only for an unclaimed
	// slug: a conflicting body must not store a cache or a usage row of its own,
	// and rows already stored must keep the access and the quota they have.
	const isClaimed = (await loadTenant(database, body.id)) !== undefined;

	if (!isClaimed) {
		await writeCacheLifecycle(database, async (table) => {
			const provisioning = provisioningStatements(database, body, now, table);
			await database.batch([
				provisioning.tenant,
				provisioning.cache,
				provisioning.usage
			]);
		});
	}

	// Either the slug was already claimed, or a concurrent create claimed it
	// between the read and the insert. Validate the existing configuration before
	// writing anything else. Otherwise a conflicting request could store a cache
	// row with the wrong access or a usage row with the wrong quota, and make a
	// later matching retry fail.
	const existing = await loadTenant(database, body.id);

	// Never reuse a slug after offboarding has begun; doing so could restore the
	// removed tenant's identity.
	if (
		existing === undefined ||
		existing.status === 'offboarding' ||
		existing.status === 'offboarded' ||
		!(await hasSameConfig(database, existing, body))
	) {
		throw new TenantAlreadyExistsError(body.id);
	}

	// A crash, or a release that provisioned less than this one, can leave the
	// tenant row without the cache and usage rows. Write them now that the stored
	// configuration is known to match. Only an empty tenant can start at zero.
	if (isClaimed) {
		await writeCacheLifecycle(database, async (table) => {
			const provisioning = provisioningStatements(database, body, now, table);
			await database.batch([provisioning.cache, provisioning.usage]);
		});
	}

	const usage = await loadUsage(database, body.id);

	if (usage === undefined) {
		throw new TenantUsageRepairRequiredError(body.id);
	}

	if ((usage.quotaBytes ?? undefined) !== body.quotaBytes) {
		throw new TenantAlreadyExistsError(body.id);
	}

	return toSummary(existing);
}

/**
The three rows a tenant is provisioned with: the tenant itself, its default
cache, and its usage counter. The cache and the usage row select from the
tenant row, so a batch that writes all three must run them in this order.

Every statement leaves a stored row alone, so a repair can run the cache and
usage statements again for a tenant that already has its row.
*/
function provisioningStatements(
	database: Database,
	body: TenantCreateBody,
	now: IsoTimestamp,
	table: CacheLifecycleWriteTable
) {
	const identity = cacheIdentityColumns({ kind: 'default' });
	const tenantFilter = liveTenantFilter(body.id);
	const cacheKind = sql<typeof identity.cacheKind>`${identity.cacheKind}`.as(
		'cache_kind'
	);
	const cacheName = sql<typeof identity.cacheName>`${identity.cacheName}`.as(
		'cache_name'
	);
	const cacheAccess = sql<
		typeof body.defaultCacheAccess
	>`${body.defaultCacheAccess}`.as('access');
	const generation = sql<number>`${firstCacheGeneration}`.as('generation');
	const readRevision = sql<number>`${firstCacheReadRevision}`.as(
		'read_revision'
	);
	const deletedAt = sql<null>`null`.as('deleted_at');
	const updatedAt = sql<IsoTimestamp>`${now}`.as('updated_at');
	const zero = sql<number>`0`;
	const quota = body.quotaBytes ?? sql<null>`null`;
	const quotaBytes = sql<number | null>`${quota}`.as('quota_bytes');
	const cacheRow = database
		.select({
			tenant: d1Schema.tenant.id,
			cacheKind,
			cacheName,
			access: cacheAccess,
			generation,
			readRevision,
			deletedAt,
			updatedAt
		})
		.from(d1Schema.tenant)
		.where(tenantFilter);
	type StoredStateTable =
		| typeof d1Schema.tenantBlob
		| typeof d1Schema.tenantCasBlob
		| typeof d1Schema.blobReference
		| typeof d1Schema.attestationReference;
	const noStoredState = (table: StoredStateTable): SQL => {
		const belongsToTenant = eq(table.tenant, body.id);
		const rows = database
			.select({ one: sql`1` })
			.from(table)
			.where(belongsToTenant);
		return notExists(rows);
	};
	const emptyTenantFilter = and(
		tenantFilter,
		noStoredState(d1Schema.tenantBlob),
		noStoredState(d1Schema.tenantCasBlob),
		noStoredState(d1Schema.blobReference),
		noStoredState(d1Schema.attestationReference)
	);
	const usageRow = database
		.select({
			tenant: d1Schema.tenant.id,
			bytes: zero.as('bytes'),
			narinfos: zero.as('narinfos'),
			blobs: zero.as('blobs'),
			casBytes: zero.as('cas_bytes'),
			casBlobs: zero.as('cas_blobs'),
			quotaBytes,
			updatedAt
		})
		.from(d1Schema.tenant)
		.where(emptyTenantFilter);

	return {
		tenant: database
			.insert(d1Schema.tenant)
			.values({
				id: body.id,
				status: 'active',
				ownerIssuer: body.ownerIssuer,
				ownerSubject: body.ownerSubject,
				ownerAudience: body.ownerAudience,
				configVersion: 1,
				cacheCatalogueVersion,
				createdAt: now
			})
			.onConflictDoNothing(),
		cache: database.insert(table).select(cacheRow).onConflictDoNothing(),
		usage: database
			.insert(d1Schema.tenantUsage)
			.select(usageRow)
			.onConflictDoNothing()
	};
}

async function loadTenant(
	database: Database,
	id: TenantId
): Promise<TenantRow | undefined> {
	return database
		.select()
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, id))
		.get();
}

async function loadUsage(
	database: Database,
	id: TenantId
): Promise<{ quotaBytes: number | null } | undefined> {
	return database
		.select({ quotaBytes: d1Schema.tenantUsage.quotaBytes })
		.from(d1Schema.tenantUsage)
		.where(eq(d1Schema.tenantUsage.tenant, id))
		.get();
}

/**
Lists the tenants that sort after `after`, or from the first tenant, in id
order. With a `limit`, a page has at most that many tenants. Its cursor is
the id of its last tenant, and is present only when more tenants follow.
Without a `limit`, the result has every remaining tenant and no cursor. That
legacy shape serves a CLI that cannot read a cursor, and it reads every row
of the tenant table.
*/
export async function listTenants(
	database: Database,
	page: { readonly after?: TenantId; readonly limit?: number } = {}
): Promise<TenantListResponse> {
	const query = database
		.select()
		.from(d1Schema.tenant)
		.where(
			page.after === undefined ? undefined : gt(d1Schema.tenant.id, page.after)
		)
		.orderBy(d1Schema.tenant.id);

	if (page.limit === undefined) {
		const all = await query.all();

		return { tenants: all.map((row) => toSummary(row)) };
	}

	const rows = await query.limit(page.limit + 1).all();
	const tenants = rows.slice(0, page.limit);
	const last = tenants.at(-1);

	return {
		tenants: tenants.map((row) => toSummary(row)),
		...(last !== undefined &&
			rows.length > tenants.length && { cursor: last.id })
	};
}

/**
Returns the id of the first tenant that is not offboarded, or undefined when
every tenant is offboarded or none exists.
*/
export async function firstLiveTenantId(
	database: Database
): Promise<TenantId | undefined> {
	const row = await database
		.select({ id: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.where(ne(d1Schema.tenant.status, 'offboarded'))
		.orderBy(d1Schema.tenant.id)
		.limit(1)
		.get();

	return row?.id;
}

// Sets a tenant's status and returns its summary. Every request reads this D1 row
// before admission, so suspension stops reads and writes as soon as the update
// commits. Offboarding refuses new work while the bounded drain runs.
export async function setTenantStatus(
	database: Database,
	id: TenantId,
	status: 'suspended' | 'offboarding'
): Promise<TenantSummary> {
	// The hourly drain selects only `offboarding` rows. Suspending one would
	// take it out of the drain, so only offboarding can retain that status.
	const sourceStatus = or(
		eq(d1Schema.tenant.status, 'active'),
		eq(d1Schema.tenant.status, 'suspended'),
		status === 'offboarding'
			? eq(d1Schema.tenant.status, 'offboarding')
			: undefined
	);
	const updated = await database
		.update(d1Schema.tenant)
		.set({ status })
		.where(and(eq(d1Schema.tenant.id, id), sourceStatus))
		.returning();
	const row = updated[0];

	if (row !== undefined) {
		return toSummary(row);
	}

	const existing = await loadTenant(database, id);

	if (existing === undefined) {
		throw new TenantNotFoundError(id);
	}

	if (status === 'offboarding' && existing.status === 'offboarded') {
		return toSummary(existing);
	}

	if (status === 'suspended' && existing.status === 'offboarding') {
		throw new TenantOffboardingError(id);
	}

	throw new TenantRetiredError(id);
}

// Only a suspended tenant can return to active.
export async function resumeTenant(
	database: Database,
	id: TenantId
): Promise<TenantSummary> {
	const updated = await database
		.update(d1Schema.tenant)
		.set({ status: 'active' })
		.where(
			and(eq(d1Schema.tenant.id, id), eq(d1Schema.tenant.status, 'suspended'))
		)
		.returning();
	const row = updated[0];

	if (row !== undefined) {
		return toSummary(row);
	}

	const existing = await loadTenant(database, id);

	if (existing === undefined) {
		throw new TenantNotFoundError(id);
	}

	if (existing.status === 'offboarding') {
		throw new TenantOffboardingError(id);
	}

	if (existing.status === 'offboarded') {
		throw new TenantRetiredError(id);
	}

	throw new TenantNotSuspendedError(id);
}

/**
Sets or removes a live tenant's storage quota and returns it with the
tenant's charged bytes. The quota is a column of the usage row, and every
charge's D1 batch checks that column, so the next charge uses the new value.
A limit below the charged bytes is refused, because the row's CHECK
constraint forbids usage above the quota.
*/
export async function setTenantQuota(
	database: Database,
	id: TenantId,
	quota: TenantQuota,
	now: IsoTimestamp
): Promise<TenantQuotaResponse> {
	const usedBytes = sql<number>`${d1Schema.tenantUsage.bytes} + ${d1Schema.tenantUsage.casBytes}`;
	const liveTenantRow = database
		.select({ id: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.where(liveTenantFilter(id));
	const isLimited = quota.kind === 'limited';
	const fitsQuota = isLimited ? lte(usedBytes, quota.bytes) : undefined;
	const usageOfTenant = eq(d1Schema.tenantUsage.tenant, id);
	// The UPDATE checks the tenant's status and usage itself. The read after it
	// runs in the same D1 transaction, so if the UPDATE is refused, the read
	// sees the same state and can explain why.
	const update = database
		.update(d1Schema.tenantUsage)
		.set({
			quotaBytes: isLimited ? quota.bytes : sql`null`,
			updatedAt: now
		})
		.where(and(usageOfTenant, fitsQuota, exists(liveTenantRow)))
		.returning({ usedBytes });
	const usageJoin = eq(d1Schema.tenantUsage.tenant, d1Schema.tenant.id);
	const observe = database
		.select({
			status: d1Schema.tenant.status,
			usageTenant: d1Schema.tenantUsage.tenant,
			usedBytes
		})
		.from(d1Schema.tenant)
		.leftJoin(d1Schema.tenantUsage, usageJoin)
		.where(eq(d1Schema.tenant.id, id));
	const [updated, observed] = await database.batch([update, observe]);
	const row = updated[0];

	if (row !== undefined) {
		return { id, quota, usedBytes: row.usedBytes };
	}

	const tenant = observed[0];

	if (tenant === undefined) {
		throw new TenantNotFoundError(id);
	}

	if (tenant.status === 'offboarding') {
		throw new TenantOffboardingError(id);
	}

	if (tenant.status === 'offboarded') {
		throw new TenantRetiredError(id);
	}

	if (tenant.usageTenant === null) {
		throw new TenantUsageMissingError(id);
	}

	// Any other row the UPDATE skipped is a live tenant that already uses more
	// than the requested limit. Clearing the quota can't fail this way.
	throw new TenantQuotaBelowUsageError(id, tenant.usedBytes);
}

export async function getTenantQuota(
	database: Database,
	id: TenantId
): Promise<TenantQuotaResponse> {
	const usageJoin = eq(d1Schema.tenantUsage.tenant, d1Schema.tenant.id);
	const row = await database
		.select({
			status: d1Schema.tenant.status,
			usageTenant: d1Schema.tenantUsage.tenant,
			quotaBytes: d1Schema.tenantUsage.quotaBytes,
			usedBytes: sql<number>`${d1Schema.tenantUsage.bytes} + ${d1Schema.tenantUsage.casBytes}`
		})
		.from(d1Schema.tenant)
		.leftJoin(d1Schema.tenantUsage, usageJoin)
		.where(eq(d1Schema.tenant.id, id))
		.get();

	if (row === undefined) {
		throw new TenantNotFoundError(id);
	}

	if (row.status === 'offboarded') {
		throw new TenantRetiredError(id);
	}

	if (row.usageTenant === null) {
		throw new TenantUsageMissingError(id);
	}

	return {
		id,
		quota:
			row.quotaBytes === null
				? { kind: 'unlimited' }
				: { kind: 'limited', bytes: row.quotaBytes },
		usedBytes: row.usedBytes
	};
}

// Matches a tenant while its status permits writes. The `offboarding` and
// `offboarded` states are terminal.
function liveTenantFilter(id: TenantId): SQL | undefined {
	return and(
		eq(d1Schema.tenant.id, id),
		ne(d1Schema.tenant.status, 'offboarding'),
		ne(d1Schema.tenant.status, 'offboarded')
	);
}

// Keep a tombstone so the slug cannot be reused, but clear the owner identity
// and usage in one batch. The caller separately purges the
// tenant's Durable Object. The owner columns are not nullable, so finalisation
// stores empty strings rather than deleting them.
export async function finaliseOffboardedTenant(
	database: Database,
	id: TenantId
): Promise<void> {
	await writeCacheLifecycle(database, async (table) => {
		await database.batch([
			database
				.update(d1Schema.tenant)
				.set({
					status: 'offboarded',
					ownerIssuer: '',
					ownerSubject: '',
					ownerAudience: ''
				})
				.where(eq(d1Schema.tenant.id, id)),
			database
				.delete(d1Schema.tenantUsage)
				.where(eq(d1Schema.tenantUsage.tenant, id)),
			database
				.delete(d1Schema.tenantMaintenanceEligibility)
				.where(eq(d1Schema.tenantMaintenanceEligibility.tenant, id)),
			// An absent lifecycle row means generation one. Finalisation deletes these
			// rows only after the tenant drain has removed every reference edge, so
			// the deletion cannot reauthorise a first-generation edge.
			database.delete(table).where(eq(table.tenant, id))
		]);
	});
}
