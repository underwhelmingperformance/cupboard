import { type CacheScope, type TenantId } from '@cupboard/nix-store/scalars';
import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema
} from '@cupboard/protocol/oidc';
import { legacyNormalisedIssuer } from '@cupboard/protocol/oidc-issuer';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import type {
	TenantCreateBody,
	TenantReadCredential,
	TenantSummary
} from '@cupboard/protocol/tenants';
import type { ReadUser } from '@cupboard/shared/http';
import {
	and,
	eq,
	exists,
	isNull,
	ne,
	notInArray,
	type SQL,
	sql
} from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core';

import { cacheIdentityColumns, cacheIdentityCondition } from '../db/cache.ts';
import {
	firstCacheGeneration,
	firstCacheReadRevision
} from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { deploymentManifest } from '../deployment-manifest.generated.ts';
import {
	CacheNotFoundError,
	TenantAlreadyExistsError,
	TenantDataMigrationDescriptorMissingError,
	TenantNotFoundError,
	TenantNotSuspendedError,
	TenantRetiredError
} from '../errors.ts';
import { cacheCatalogueVersion } from '../migration/cache-access.ts';
import {
	generateReadPasswordSalt,
	hashReadPassword,
	isReadPasswordMatching,
	type ReadPasswordHash,
	type ReadPasswordSalt
} from '../read/read-auth.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

type TenantRow = typeof d1Schema.tenant.$inferSelect;

interface ReadVerifierColumns {
	readonly readUser: ReadUser | undefined;
	readonly readPasswordHash: ReadPasswordHash | undefined;
	readonly readPasswordSalt: ReadPasswordSalt | undefined;
}

async function readVerifierColumnsForInsert(
	read: TenantCreateBody['read']
): Promise<ReadVerifierColumns> {
	if (read === undefined) {
		return {
			readUser: undefined,
			readPasswordHash: undefined,
			readPasswordSalt: undefined
		};
	}

	const readPasswordSalt = generateReadPasswordSalt();

	return {
		readUser: read.user,
		readPasswordHash: await hashReadPassword(read.password, readPasswordSalt),
		readPasswordSalt
	};
}

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

async function hasSameConfigExceptIssuer(
	database: Database,
	row: TenantRow,
	body: TenantCreateBody
): Promise<boolean> {
	const isReadMatching = await hasSameReadVerifier(row, body.read);
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

	return (
		defaultCache?.access === body.defaultCacheAccess &&
		row.ownerSubject === body.ownerSubject &&
		row.ownerAudience === body.ownerAudience &&
		isReadMatching
	);
}

async function repairLegacyOwnerIssuer(
	database: Database,
	row: TenantRow,
	body: TenantCreateBody
): Promise<TenantRow | undefined> {
	const legacyIssuer = legacyNormalisedIssuer(body.ownerIssuer);

	if (
		legacyIssuer === undefined ||
		row.ownerIssuer !== legacyIssuer ||
		!(await hasSameConfigExceptIssuer(database, row, body))
	) {
		return undefined;
	}

	const repaired = await database
		.update(d1Schema.tenant)
		.set({
			ownerIssuer: body.ownerIssuer,
			configVersion: sql`${d1Schema.tenant.configVersion} + 1`
		})
		.where(
			and(
				eq(d1Schema.tenant.id, row.id),
				eq(d1Schema.tenant.ownerIssuer, legacyIssuer),
				eq(d1Schema.tenant.configVersion, row.configVersion)
			)
		)
		.returning();

	return repaired[0];
}

async function hasSameReadVerifier(
	row: TenantRow,
	read: TenantCreateBody['read']
): Promise<boolean> {
	if (read === undefined) {
		return (
			row.readUser === null &&
			row.readPasswordHash === null &&
			row.readPasswordSalt === null
		);
	}

	if (
		row.readUser !== read.user ||
		row.readPasswordHash === null ||
		row.readPasswordSalt === null
	) {
		return false;
	}

	return isReadPasswordMatching(
		read.password,
		row.readPasswordHash,
		row.readPasswordSalt
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
	const verifier = await readVerifierColumnsForInsert(body.read);
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
	const lifecycleState = sql<'active'>`'active'`.as('state');
	const creationExpiresAt = sql<null>`null`.as('creation_expires_at');
	const managementKind = sql<'durable'>`'durable'`.as('management_kind');
	const managedPolicyId = sql<null>`null`.as('managed_policy_id');
	const managedPolicyRevision = sql<null>`null`.as('managed_policy_revision');
	const managedGroupId = sql<null>`null`.as('managed_group_id');
	const leaseExpiresAt = sql<null>`null`.as('lease_expires_at');
	const selectionState = sql<null>`null`.as('selection_state');
	const updateHold = sql<boolean>`false`.as('update_hold');
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
			state: lifecycleState,
			creationExpiresAt,
			managementKind,
			managedPolicyId,
			managedPolicyRevision,
			managedGroupId,
			leaseExpiresAt,
			selectionState,
			updateHold,
			deletedAt,
			updatedAt
		})
		.from(d1Schema.tenant)
		.where(tenantFilter);
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
		.where(tenantFilter);
	const activeMigrations = await database
		.select({
			artifactId: d1Schema.globalDataMigration.artifactId,
			instanceId: d1Schema.globalDataMigration.instanceId,
			migrationId: d1Schema.globalDataMigration.migrationId
		})
		.from(d1Schema.globalDataMigration)
		.where(ne(d1Schema.globalDataMigration.status, 'complete'))
		.all();
	const nativeMigrationRows: (typeof d1Schema.tenantDataMigration.$inferInsert)[] =
		activeMigrations.map((migration) => {
			const descriptor = deploymentManifest.dataMigrations.find(
				(candidate) => candidate.id === migration.migrationId
			);

			if (descriptor === undefined) {
				throw new TenantDataMigrationDescriptorMissingError(
					migration.migrationId
				);
			}

			return {
				...migration,
				implementationRevision: descriptor.implementationRevision,
				tenant: body.id,
				status: 'complete',
				completedAt: now
			};
		});

	const [tenantInsert] = await database.batch([
		database
			.insert(d1Schema.tenant)
			.values({
				id: body.id,
				status: 'active',
				ownerIssuer: body.ownerIssuer,
				ownerSubject: body.ownerSubject,
				ownerAudience: body.ownerAudience,
				configVersion: 1,
				cacheCatalogueVersion,
				createdAt: now,
				readUser: verifier.readUser,
				readPasswordHash: verifier.readPasswordHash,
				readPasswordSalt: verifier.readPasswordSalt
			})
			.onConflictDoNothing(),
		database
			.insert(d1Schema.cacheLifecycle)
			.select(cacheRow)
			.onConflictDoNothing(),
		database.insert(d1Schema.tenantUsage).select(usageRow).onConflictDoNothing()
	]);

	const [firstMigration, ...remainingMigrations] = nativeMigrationRows;

	if (firstMigration !== undefined && tenantInsert.meta.changes === 1) {
		await database.batch([
			database
				.insert(d1Schema.tenantDataMigration)
				.values(firstMigration)
				.onConflictDoNothing(),
			...remainingMigrations.map((migration) =>
				database
					.insert(d1Schema.tenantDataMigration)
					.values(migration)
					.onConflictDoNothing()
			)
		]);
	}

	const existing = await loadTenant(database, body.id);

	// Never reuse a slug after offboarding has begun; doing so could restore the
	// removed tenant's identity.
	if (existing?.status === 'offboarding' || existing?.status === 'offboarded') {
		throw new TenantAlreadyExistsError(body.id);
	}

	if (existing === undefined) {
		throw new TenantAlreadyExistsError(body.id);
	}

	if (!(await hasSameConfigExceptIssuer(database, existing, body))) {
		throw new TenantAlreadyExistsError(body.id);
	}

	const requiresIssuerRepair = existing.ownerIssuer !== body.ownerIssuer;

	if (
		requiresIssuerRepair &&
		existing.ownerIssuer !== legacyNormalisedIssuer(body.ownerIssuer)
	) {
		throw new TenantAlreadyExistsError(body.id);
	}

	const existingQuota = await loadQuota(database, body.id);

	if (existingQuota !== body.quotaBytes) {
		throw new TenantAlreadyExistsError(body.id);
	}

	if (!requiresIssuerRepair) {
		return toSummary(existing);
	}

	const repaired = await repairLegacyOwnerIssuer(database, existing, body);

	if (repaired !== undefined) {
		return toSummary(repaired);
	}

	// A concurrent retry may have completed the compare-and-set first. Treat its
	// exact result as the same successful repair.
	const concurrent = await loadTenant(database, body.id);

	if (
		concurrent?.ownerIssuer !== body.ownerIssuer ||
		!(await hasSameConfigExceptIssuer(database, concurrent, body))
	) {
		throw new TenantAlreadyExistsError(body.id);
	}

	return toSummary(concurrent);
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

async function loadQuota(
	database: Database,
	id: TenantId
): Promise<number | undefined> {
	const usage = await database
		.select({ quotaBytes: d1Schema.tenantUsage.quotaBytes })
		.from(d1Schema.tenantUsage)
		.where(eq(d1Schema.tenantUsage.tenant, id))
		.get();

	return usage?.quotaBytes ?? undefined;
}

export async function listTenants(
	database: Database
): Promise<TenantSummary[]> {
	const rows = await database
		.select()
		.from(d1Schema.tenant)
		.orderBy(d1Schema.tenant.id)
		.all();

	return rows.map((row) => toSummary(row));
}

// Sets a tenant's status and returns its summary. Every request reads this D1 row
// before admission, so suspension stops reads and writes as soon as the update
// commits. Offboarding refuses new work while the bounded drain runs.
export async function setTenantStatus(
	database: Database,
	id: TenantId,
	status: 'suspended' | 'offboarding'
): Promise<TenantSummary> {
	// The conditional update cannot move an offboarded tenant back to offboarding.
	// If it matches no row, the following read distinguishes a missing tenant from
	// an offboarded one.
	const updated = await database
		.update(d1Schema.tenant)
		.set({ status })
		.where(
			and(eq(d1Schema.tenant.id, id), ne(d1Schema.tenant.status, 'offboarded'))
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

	if (status === 'offboarding' && existing.status === 'offboarded') {
		return toSummary(existing);
	}

	throw new TenantRetiredError(id);
}

// Only a suspended tenant can return to active. An active tenant is a conflict,
// while an offboarding or retired tenant remains terminal.
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

	if (existing.status === 'offboarding' || existing.status === 'offboarded') {
		throw new TenantRetiredError(id);
	}

	throw new TenantNotSuspendedError(id);
}

/**
Replaces the read credential only while the tenant is active or suspended.
*/
export async function setTenantReadCredential(
	database: Database,
	id: TenantId,
	read: TenantReadCredential
): Promise<TenantSummary> {
	const readPasswordSalt = generateReadPasswordSalt();

	return updateLiveTenant(database, id, {
		readUser: read.user,
		readPasswordHash: await hashReadPassword(read.password, readPasswordSalt),
		readPasswordSalt
	});
}

/**
 * Replaces one cache's read credential while the tenant is active or
 * suspended. While the row exists, it takes precedence over the tenant
 * fallback credential.
 */
export async function setCacheReadCredential(
	database: Database,
	id: TenantId,
	cache: CacheScope,
	read: TenantReadCredential,
	now: IsoTimestamp
): Promise<void> {
	await requireLiveTenant(database, id);

	const readPasswordSalt = generateReadPasswordSalt();
	const readPasswordHash = await hashReadPassword(
		read.password,
		readPasswordSalt
	);
	// Select from a live tenant in the same statement as the upsert. If
	// offboarding wins the race, the SELECT returns no row, so the upsert cannot
	// recreate the credential that cleanup deleted.
	const identity = cacheIdentityColumns(cache);
	const lifecycleIdentity = cacheIdentityCondition(
		d1Schema.cacheLifecycle.cacheKind,
		d1Schema.cacheLifecycle.cacheName,
		cache
	);
	const liveLifecycle = and(
		eq(d1Schema.cacheLifecycle.tenant, d1Schema.tenant.id),
		lifecycleIdentity,
		isNull(d1Schema.cacheLifecycle.deletedAt)
	);
	const insert = database.insert(d1Schema.tenantCacheReadCredential).select(
		database
			.select({
				tenant: d1Schema.tenant.id,
				cacheKind: sql<typeof identity.cacheKind>`${identity.cacheKind}`.as(
					'cache_kind'
				),
				cacheName: sql<typeof identity.cacheName>`${identity.cacheName}`.as(
					'cache_name'
				),
				readUser: sql<ReadUser>`${read.user}`.as('read_user'),
				readPasswordHash: sql<ReadPasswordHash>`${readPasswordHash}`.as(
					'read_password_hash'
				),
				readPasswordSalt: sql<ReadPasswordSalt>`${readPasswordSalt}`.as(
					'read_password_salt'
				),
				createdAt: sql<IsoTimestamp>`${now}`.as('created_at')
			})
			.from(d1Schema.tenant)
			.innerJoin(d1Schema.cacheLifecycle, liveLifecycle)
			.where(liveTenantFilter(id))
	);
	const set = {
		readUser: read.user,
		readPasswordHash,
		readPasswordSalt,
		createdAt: now
	};
	const written =
		cache.kind === 'default'
			? await insert
					.onConflictDoUpdate({
						target: [d1Schema.tenantCacheReadCredential.tenant],
						targetWhere: sql`${d1Schema.tenantCacheReadCredential.cacheKind} = 'default'`,
						set
					})
					.run()
			: await insert
					.onConflictDoUpdate({
						target: [
							d1Schema.tenantCacheReadCredential.tenant,
							d1Schema.tenantCacheReadCredential.cacheName
						],
						targetWhere: sql`${d1Schema.tenantCacheReadCredential.cacheKind} = 'named'`,
						set
					})
					.run();

	if (written.meta.changes === 0) {
		await requireLiveTenant(database, id);

		throw new CacheNotFoundError(cache);
	}
}

/**
 * Removes one cache's read credential while the tenant is active or suspended.
 * Readers of a private cache then authenticate with the tenant credential. The
 * operation is idempotent.
 */
export async function clearCacheReadCredential(
	database: Database,
	id: TenantId,
	cache: CacheScope
): Promise<void> {
	await requireLiveTenant(database, id);

	const liveTenantRow = database
		.select({ id: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.where(liveTenantFilter(id));
	// Require a live tenant in the DELETE itself. If offboarding wins the race
	// after the precheck, the DELETE changes no rows and the caller checks the
	// tenant state instead of returning success.
	const deleted = await database
		.delete(d1Schema.tenantCacheReadCredential)
		.where(
			and(
				eq(d1Schema.tenantCacheReadCredential.tenant, id),
				cacheIdentityCondition(
					d1Schema.tenantCacheReadCredential.cacheKind,
					d1Schema.tenantCacheReadCredential.cacheName,
					cache
				),
				exists(liveTenantRow)
			)
		)
		.run();

	if (deleted.meta.changes > 0) {
		return;
	}

	// A zero-row delete succeeds for a live tenant. Re-read the tenant so a
	// missing or retired tenant still receives the corresponding error.
	await requireLiveTenant(database, id);
}

// Matches a tenant while its status permits writes. The `offboarding` and
// `offboarded` states are terminal.
function liveTenantFilter(id: TenantId): SQL | undefined {
	return and(
		eq(d1Schema.tenant.id, id),
		notInArray(d1Schema.tenant.status, ['offboarding', 'offboarded'])
	);
}

// Reports whether an unmatched live-tenant guard refers to a missing tenant or
// a retired tenant.
async function refuseRetiredTenant(
	database: Database,
	id: TenantId
): Promise<never> {
	const existing = await loadTenant(database, id);

	if (existing === undefined) {
		throw new TenantNotFoundError(id);
	}

	throw new TenantRetiredError(id);
}

// Rejects a missing or retired tenant before a credential mutation starts. The
// mutation repeats the status check in its guarded write because offboarding
// can begin after this function returns.
async function requireLiveTenant(
	database: Database,
	id: TenantId
): Promise<void> {
	const existing = await loadTenant(database, id);

	if (existing === undefined) {
		throw new TenantNotFoundError(id);
	}

	if (existing.status === 'offboarding' || existing.status === 'offboarded') {
		throw new TenantRetiredError(id);
	}
}

// A private cache without its own verifier needs the complete tenant fallback
// credential. Do not clear the fallback after offboarding has begun.
export async function clearTenantReadCredential(
	database: Database,
	id: TenantId
): Promise<TenantSummary> {
	return updateLiveTenant(database, id, {
		readUser: sql`null`,
		readPasswordHash: sql`null`,
		readPasswordSalt: sql`null`
	});
}

async function updateLiveTenant(
	database: Database,
	id: TenantId,
	set: SQLiteUpdateSetSource<typeof d1Schema.tenant>
): Promise<TenantSummary> {
	const updated = await database
		.update(d1Schema.tenant)
		.set(set)
		.where(liveTenantFilter(id))
		.returning();
	const row = updated[0];

	if (row !== undefined) {
		return toSummary(row);
	}

	return refuseRetiredTenant(database, id);
}

// Keep a tombstone so the slug cannot be reused, but clear the read credentials,
// owner identity, and usage in one batch. The caller separately purges the
// tenant's Durable Object. The owner columns are not nullable, so finalisation
// stores empty strings rather than deleting them.
export async function finaliseOffboardedTenant(
	database: Database,
	id: TenantId
): Promise<void> {
	await database.batch([
		database
			.update(d1Schema.tenant)
			.set({
				status: 'offboarded',
				readUser: sql`null`,
				readPasswordHash: sql`null`,
				readPasswordSalt: sql`null`,
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
		database
			.delete(d1Schema.tenantCacheReadCredential)
			.where(eq(d1Schema.tenantCacheReadCredential.tenant, id)),
		// An absent lifecycle row means generation one. Finalisation deletes these
		// rows only after the tenant drain has removed every reference edge, so
		// the deletion cannot reauthorise a first-generation edge.
		database
			.delete(d1Schema.cacheLifecycle)
			.where(eq(d1Schema.cacheLifecycle.tenant, id))
	]);
}
