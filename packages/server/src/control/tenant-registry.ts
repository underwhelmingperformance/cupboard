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

import { publishTenantManifest } from './tenant-manifest.ts';

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

// Provisions a tenant: writes the authoritative `tenant` row first, then publishes
// the admission manifest. A slug already in use is refused. The new tenant starts
// `active` at config version 1; the cache it backs does not serve until step 5
// wires routing and the Durable Object identity, a deliberate API-only interval.
export async function createTenant(
	database: Database,
	kv: KVNamespace,
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

	if (row === undefined) {
		throw new TenantAlreadyExistsError(body.id);
	}

	await publishTenantManifest(database, kv);

	return toSummary(row);
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

// Suspends a tenant: new writes stop at once (the Worker reads status from D1
// before dispatching a write), and reads stop after the manifest's edge TTL once
// the republished manifest propagates.
export async function suspendTenant(
	database: Database,
	kv: KVNamespace,
	id: string
): Promise<ParsedTenantSummary> {
	return setTenantStatus(database, kv, id, 'suspended');
}

// Begins offboarding a tenant: admission rejects new work for it. The bounded drain
// of its reference rows and objects is the step 7 state machine; this marks the
// registry so nothing new is admitted in the meantime.
export async function offboardTenant(
	database: Database,
	kv: KVNamespace,
	id: string
): Promise<ParsedTenantSummary> {
	return setTenantStatus(database, kv, id, 'offboarding');
}

async function setTenantStatus(
	database: Database,
	kv: KVNamespace,
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

	await publishTenantManifest(database, kv);

	return toSummary(row);
}
