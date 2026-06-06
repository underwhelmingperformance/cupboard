import type {
	ParsedTenantCreateBody,
	ParsedTenantSummary
} from '@cupboard/protocol/tenants';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import {
	TenantAlreadyExistsError,
	TenantNotFoundError,
	TenantRetiredError
} from '../errors.ts';
import {
	generateReadPasswordSalt,
	hashReadPassword
} from '../read/read-auth.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

type TenantRow = typeof d1Schema.tenant.$inferSelect;

interface ReadVerifierColumns {
	readonly readUser: string | undefined;
	readonly readPasswordHash: string | undefined;
	readonly readPasswordSalt: string | undefined;
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
		ownerIssuer: row.ownerIssuer,
		ownerSubject: row.ownerSubject,
		ownerAudience: row.ownerAudience,
		configVersion: row.configVersion,
		createdAt: row.createdAt
	};
}

async function sameConfig(
	row: TenantRow,
	body: ParsedTenantCreateBody
): Promise<boolean> {
	const readMatches = await sameReadVerifier(row, body.read);

	return (
		row.readMode === body.readMode &&
		row.ownerIssuer === body.ownerIssuer &&
		row.ownerSubject === body.ownerSubject &&
		row.ownerAudience === body.ownerAudience &&
		readMatches
	);
}

async function sameReadVerifier(
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

// Writes the authoritative `tenant` row, returning its summary. It is the first
// step of provisioning; the caller then configures the Durable Object and only
// then publishes the admission manifest, so a tenant is admitted only once its
// object is configured. This is idempotent: a retry after a mid-provision failure
// finds the existing row and, when the request matches it, returns it so the caller
// can replay the configure and publish. A different config for an existing slug is
// a genuine conflict.
export async function ensureTenant(
	database: Database,
	body: ParsedTenantCreateBody,
	now: string
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

	// A conflicting slug: validate the existing tenant config before touching the
	// usage row, so a request that does not match cannot write a wrong-quota usage row
	// on the way to rejecting and poison a later legitimate retry.
	const existing = await loadTenant(database, body.id);

	// A slug that has begun or finished offboarding is retired: never re-provisioned,
	// so a re-used slug can never resurrect a removed tenant's identity.
	if (existing?.status === 'offboarding' || existing?.status === 'offboarded') {
		throw new TenantAlreadyExistsError(body.id);
	}

	if (existing === undefined || !(await sameConfig(existing, body))) {
		throw new TenantAlreadyExistsError(body.id);
	}

	// The config matches: ensure the usage row idempotently (recovering a crash that
	// left only the tenant row), then accept the quota only if it matches the stored
	// one. `onConflictDoNothing` keeps an existing quota, so a different quota is a
	// genuine conflict rather than a silent overwrite.
	await ensureUsageRow(database, body, now);
	const existingQuota = await loadQuota(database, body.id);

	if (existingQuota !== body.quotaBytes) {
		throw new TenantAlreadyExistsError(body.id);
	}

	return toSummary(existing);
}

// The Durable Object needs a usage row to charge against before the tenant takes
// any write. Created idempotently, so a fresh provision and a crash-recovery retry
// both leave exactly one row, keeping any quota already stored.
async function ensureUsageRow(
	database: Database,
	body: ParsedTenantCreateBody,
	now: string
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
	id: string
): Promise<TenantRow | undefined> {
	return database
		.select()
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, id))
		.get();
}

async function loadQuota(
	database: Database,
	id: string
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

// Sets a tenant's status, returning its summary. The caller republishes the
// admission manifest after this so the change reaches the read path. Suspending
// stops new writes at once (the Worker reads status from D1 before dispatching a
// write) and reads after the manifest TTL; offboarding marks the tenant so nothing
// new is admitted while its bounded drain (the step 7 state machine) runs.
export async function setTenantStatus(
	database: Database,
	id: string,
	status: 'suspended' | 'offboarding'
): Promise<ParsedTenantSummary> {
	// `offboarded` is terminal: the conditional update never moves a tenant out of it,
	// so a repeated delete after finalisation cannot flip the slug back to offboarding
	// (and the caller's manifest republish never re-admits it). An update that matches
	// no row is either a missing tenant or a retired one; the follow-up read tells them
	// apart so each gets its own error.
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
		return existing;
	}

	throw new TenantRetiredError(id);
}

// Finalises a drained tenant into its terminal scrubbed tombstone in one atomic
// batch: the registry row stays (so the slug is never reused) with its status set to
// `offboarded`, its read credential cleared, and its owner OIDC identity blanked (the
// not-null columns cannot be dropped, so they are emptied), and the usage row is
// dropped. The Durable Object's own storage (signing keys, identity, narinfos) is
// wiped through its `purgeStorage` RPC by the caller; what remains here is an
// auditable record that the slug existed and is retired, holding no tenant identity or
// secret.
export async function finaliseOffboardedTenant(
	database: Database,
	id: string
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
			.where(eq(d1Schema.tenantUsage.tenant, id))
	]);
}
