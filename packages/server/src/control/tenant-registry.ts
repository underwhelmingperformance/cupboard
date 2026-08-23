import { type TenantId } from '@cupboard/nix-store/scalars';
import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema
} from '@cupboard/protocol/oidc';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import type {
	ParsedTenantCreateBody,
	ParsedTenantReadCredential,
	ParsedTenantSummary
} from '@cupboard/protocol/tenants';
import type { ReadUser } from '@cupboard/shared/http';
import { and, eq, ne, notInArray, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core';

import * as d1Schema from '../db/d1-schema.ts';
import {
	TenantAlreadyExistsError,
	TenantNotFoundError,
	TenantNotSuspendedError,
	TenantRetiredError
} from '../errors.ts';
import {
	generateReadPasswordSalt,
	hashReadPassword,
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
	read: ParsedTenantCreateBody['read']
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

function toSummary(row: TenantRow): ParsedTenantSummary {
	return {
		id: row.id,
		status: row.status,
		readMode: row.readMode,
		ownerIssuer: oidcIssuerSchema.parse(row.ownerIssuer),
		ownerSubject: oidcSubjectSchema.parse(row.ownerSubject),
		ownerAudience: oidcAudienceSchema.parse(row.ownerAudience),
		configVersion: row.configVersion,
		createdAt: row.createdAt
	};
}

async function hasSameConfig(
	row: TenantRow,
	body: ParsedTenantCreateBody
): Promise<boolean> {
	const isReadMatching = await hasSameReadVerifier(row, body.read);

	return (
		row.readMode === body.readMode &&
		row.ownerIssuer === body.ownerIssuer &&
		row.ownerSubject === body.ownerSubject &&
		row.ownerAudience === body.ownerAudience &&
		isReadMatching
	);
}

async function hasSameReadVerifier(
	row: TenantRow,
	read: ParsedTenantCreateBody['read']
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

	return (
		(await hashReadPassword(read.password, row.readPasswordSalt)) ===
		row.readPasswordHash
	);
}

// This is the first provisioning step. The caller configures the Durable Object
// before publishing its membership marker and filter, so requests cannot reach
// an unconfigured object. A matching retry returns the existing row and can
// safely repeat the later steps; a different configuration is a conflict.
export async function ensureTenant(
	database: Database,
	body: ParsedTenantCreateBody,
	now: IsoTimestamp
): Promise<ParsedTenantSummary> {
	const verifier = await readVerifierColumnsForInsert(body.read);
	const inserted = await database
		.insert(d1Schema.tenant)
		.values({
			id: body.id,
			status: 'active',
			readMode: body.readMode,
			ownerIssuer: body.ownerIssuer,
			ownerSubject: body.ownerSubject,
			ownerAudience: body.ownerAudience,
			configVersion: 1,
			createdAt: now,
			readUser: verifier.readUser,
			readPasswordHash: verifier.readPasswordHash,
			readPasswordSalt: verifier.readPasswordSalt
		})
		.onConflictDoNothing()
		.returning();
	const row = inserted[0];

	if (row !== undefined) {
		await ensureUsageRow(database, body, now);

		return toSummary(row);
	}

	// Validate the existing configuration before touching usage. Otherwise a
	// conflicting request could create a usage row with the wrong quota and make a
	// later matching retry fail.
	const existing = await loadTenant(database, body.id);

	// Never reuse a slug after offboarding has begun; doing so could restore the
	// removed tenant's identity.
	if (existing?.status === 'offboarding' || existing?.status === 'offboarded') {
		throw new TenantAlreadyExistsError(body.id);
	}

	if (existing === undefined || !(await hasSameConfig(existing, body))) {
		throw new TenantAlreadyExistsError(body.id);
	}

	// A crash can leave the tenant row without its usage row. Recreate the usage
	// row idempotently, but accept an existing row only when its quota matches.
	await ensureUsageRow(database, body, now);
	const existingQuota = await loadQuota(database, body.id);

	if (existingQuota !== body.quotaBytes) {
		throw new TenantAlreadyExistsError(body.id);
	}

	return toSummary(existing);
}

// The usage row must exist before the tenant accepts writes. Conflict handling
// preserves any quota already stored during a provisioning retry.
async function ensureUsageRow(
	database: Database,
	body: ParsedTenantCreateBody,
	now: IsoTimestamp
): Promise<void> {
	await database
		.insert(d1Schema.tenantUsage)
		.values({
			tenant: body.id,
			bytes: 0,
			narinfos: 0,
			blobs: 0,
			quotaBytes: body.quotaBytes,
			updatedAt: now
		})
		.onConflictDoNothing()
		.run();
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
): Promise<ParsedTenantSummary[]> {
	const rows = await database
		.select()
		.from(d1Schema.tenant)
		.orderBy(d1Schema.tenant.id)
		.all();

	return rows.map((row) => toSummary(row));
}

// The caller invalidates the admission cache after this update. Writes read D1
// before dispatch, so suspension stops them immediately; reads observe the new
// status after their short cache TTL. Offboarding keeps the tenant reachable only
// for its bounded drain.
export async function setTenantStatus(
	database: Database,
	id: TenantId,
	status: 'suspended' | 'offboarding'
): Promise<ParsedTenantSummary> {
	// `offboarded` is terminal. The conditional update prevents a repeated delete
	// from moving the slug back to offboarding. A follow-up read distinguishes a
	// missing tenant from a retired one when the update matches no row.
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
): Promise<ParsedTenantSummary> {
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
Changes the read mode only while the tenant is active or suspended.
*/
export async function setTenantReadMode(
	database: Database,
	id: TenantId,
	readMode: 'public' | 'private'
): Promise<ParsedTenantSummary> {
	return updateLiveTenant(database, id, { readMode });
}

/**
Replaces the read credential only while the tenant is active or suspended.
*/
export async function setTenantReadCredential(
	database: Database,
	id: TenantId,
	read: ParsedTenantReadCredential
): Promise<ParsedTenantSummary> {
	const readPasswordSalt = generateReadPasswordSalt();

	return updateLiveTenant(database, id, {
		readUser: read.user,
		readPasswordHash: await hashReadPassword(read.password, readPasswordSalt),
		readPasswordSalt
	});
}

// A private tenant without a complete read credential fails closed. Do not clear
// credentials after offboarding has begun.
export async function clearTenantReadCredential(
	database: Database,
	id: TenantId
): Promise<ParsedTenantSummary> {
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
): Promise<ParsedTenantSummary> {
	const updated = await database
		.update(d1Schema.tenant)
		.set(set)
		.where(
			and(
				eq(d1Schema.tenant.id, id),
				notInArray(d1Schema.tenant.status, ['offboarding', 'offboarded'])
			)
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

	throw new TenantRetiredError(id);
}

// Keep a tombstone so the slug cannot be reused, but clear the read credential,
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
			.where(eq(d1Schema.tenantMaintenanceEligibility.tenant, id))
	]);
}
