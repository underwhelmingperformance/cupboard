import type {
	ParsedTenantCreateBody,
	ParsedTenantSummary
} from '@cupboard/protocol/tenants';
import { eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { TenantAlreadyExistsError, TenantNotFoundError } from '../errors.ts';
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
		return toSummary(row);
	}

	const existing = await database
		.select()
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, body.id))
		.get();

	if (existing === undefined || !(await sameConfig(existing, body))) {
		throw new TenantAlreadyExistsError(body.id);
	}

	return toSummary(existing);
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
	const updated = await database
		.update(d1Schema.tenant)
		.set({ status })
		.where(eq(d1Schema.tenant.id, id))
		.returning();
	const row = updated[0];

	if (row === undefined) {
		throw new TenantNotFoundError(id);
	}

	return toSummary(row);
}
