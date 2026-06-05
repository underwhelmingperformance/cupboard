import { sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

const manifestSingletonId = 'singleton';
const manifestCurrentKey = 'manifest:current';
const manifestKeyPrefix = 'manifest:';
// Older manifest versions kept after a publish, so a reader that resolved a
// pointer just before pruning can still read the body it named. The current
// pointer's body is never pruned.
const manifestVersionsKept = 5;

// A private cache's read verifier as the manifest carries it: the Basic-auth user
// and the hash of its password, never the plaintext. Absent for a public cache, or
// for a private one with no credential set (which then fails closed).
const manifestReadVerifierSchema = z.object({
	user: z.string(),
	passwordHash: z.string(),
	passwordSalt: z.string()
});

const manifestEntrySchema = z.object({
	status: z.enum(['active', 'suspended', 'offboarding']),
	readMode: z.enum(['public', 'private']),
	configVersion: z.number().int(),
	readVerifier: manifestReadVerifierSchema.optional()
});

const tenantManifestSchema = z.object({
	version: z.number().int(),
	tenants: z.record(z.string(), manifestEntrySchema)
});

export type ManifestEntry = z.infer<typeof manifestEntrySchema>;
export type TenantManifest = z.infer<typeof tenantManifestSchema>;

// Republishes the admission manifest after a registry change, returning the new
// version. The version is bumped in D1, so it is monotonic and two concurrent
// publishes never share one; the full body is then written under its immutable
// `manifest:<version>` key before the stable current pointer advances to that
// version. The caller writes the authoritative D1 `tenant` row before bumping, so
// any tenant with a lower version committed before this version's row read and is
// included.
export async function publishTenantManifest(
	database: Database,
	kv: KVNamespace
): Promise<number> {
	const bumped = await database
		.insert(d1Schema.manifestState)
		.values({ id: manifestSingletonId, version: 1 })
		.onConflictDoUpdate({
			target: d1Schema.manifestState.id,
			set: { version: sql`${d1Schema.manifestState.version} + 1` }
		})
		.returning({ version: d1Schema.manifestState.version })
		.get();
	const { version } = bumped;

	const rows = await database
		.select({
			id: d1Schema.tenant.id,
			status: d1Schema.tenant.status,
			readMode: d1Schema.tenant.readMode,
			configVersion: d1Schema.tenant.configVersion,
			readUser: d1Schema.tenant.readUser,
			readPasswordHash: d1Schema.tenant.readPasswordHash,
			readPasswordSalt: d1Schema.tenant.readPasswordSalt
		})
		.from(d1Schema.tenant)
		.all();

	const tenants: Record<string, ManifestEntry> = {};

	for (const row of rows) {
		const entry: ManifestEntry = {
			status: row.status,
			readMode: row.readMode,
			configVersion: row.configVersion
		};

		if (
			row.readUser !== null &&
			row.readPasswordHash !== null &&
			row.readPasswordSalt !== null
		) {
			entry.readVerifier = {
				user: row.readUser,
				passwordHash: row.readPasswordHash,
				passwordSalt: row.readPasswordSalt
			};
		}

		tenants[row.id] = entry;
	}

	const body: TenantManifest = { version, tenants };

	await kv.put(`${manifestKeyPrefix}${String(version)}`, JSON.stringify(body));
	await kv.put(manifestCurrentKey, String(version));
	await pruneOldManifests(kv, version);

	return version;
}

// Reads the current admission manifest: the body named by the stable current
// pointer. Returns undefined when nothing is published, when the resolved body
// has not propagated, or when it fails to parse, so a caller fails closed
// (admitting no tenant) rather than acting on a partial manifest.
export async function readTenantManifest(
	kv: KVNamespace
): Promise<TenantManifest | undefined> {
	const pointer = await kv.get(manifestCurrentKey);

	if (pointer === null) {
		return undefined;
	}

	if (!/^\d+$/.test(pointer)) {
		return undefined;
	}

	const body = await kv.get(`${manifestKeyPrefix}${pointer}`);

	if (body === null) {
		return undefined;
	}

	const parsed = tenantManifestSchema.safeParse(JSON.parse(body));

	return parsed.success ? parsed.data : undefined;
}

async function pruneOldManifests(
	kv: KVNamespace,
	version: number
): Promise<void> {
	const threshold = version - manifestVersionsKept;

	if (threshold <= 0) {
		return;
	}

	const { keys } = await kv.list({ prefix: manifestKeyPrefix });
	const stale = keys.filter((key) => {
		const keyVersion = Number(key.name.slice(manifestKeyPrefix.length));

		return Number.isInteger(keyVersion) && keyVersion < threshold;
	});

	await Promise.all(stale.map((key) => kv.delete(key.name)));
}
