import {
	type CacheName,
	cacheNameSchema,
	privateStoredCache,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import {
	type ParsedTenantCreateBody,
	type ParsedTenantReadCredential,
	tenantCreateBodySchema,
	tenantReadCredentialSchema
} from '@cupboard/protocol/tenants';
import { type ReadUser, readUserSchema } from '@cupboard/shared/http';
import { env } from 'cloudflare:workers';
import { and, asc, eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import {
	TenantAlreadyExistsError,
	TenantNotFoundError,
	TenantNotSuspendedError,
	TenantRetiredError
} from '../errors.ts';
import {
	hashReadPassword,
	isReadPasswordMatching,
	type ReadPasswordHash,
	readPasswordHashSchema,
	type ReadPasswordSalt,
	readPasswordSaltSchema
} from '../read/read-auth.ts';

import {
	clearCacheReadCredential,
	clearTenantReadCredential,
	ensureTenant,
	finaliseOffboardedTenant,
	listTenants,
	resumeTenant,
	setCacheReadCredential,
	setTenantReadCredential,
	setTenantReadMode,
	setTenantStatus
} from './tenant-registry.ts';

const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
const acme = tenantIdSchema.parse('acme');
const ghost = tenantIdSchema.parse('ghost');
const builds = cacheNameSchema.parse('builds');
const guides = cacheNameSchema.parse('guides');

function database(): ReturnType<typeof drizzleD1<typeof d1Schema>> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

function usageRow(
	id: TenantId
): Promise<undefined | { quotaBytes: number | null }> {
	return database()
		.select({ quotaBytes: d1Schema.tenantUsage.quotaBytes })
		.from(d1Schema.tenantUsage)
		.where(eq(d1Schema.tenantUsage.tenant, id))
		.get();
}

function createBody(
	id: string,
	readMode: 'public' | 'private' = 'private'
): ParsedTenantCreateBody {
	return tenantCreateBodySchema.parse({
		id,
		readMode,
		ownerIssuer: 'https://idp.test',
		ownerSubject: 'owner',
		ownerAudience: 'aud'
	});
}

function privateBodyWithRead(id: string): ParsedTenantCreateBody {
	return tenantCreateBodySchema.parse({
		id,
		readMode: 'private',
		read: {
			user: 'cupboard',
			password: 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23'
		},
		ownerIssuer: 'https://idp.test',
		ownerSubject: 'owner',
		ownerAudience: 'aud'
	});
}

const readPassword = 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23';
const rotatedReadPassword = 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu45';

function readCredential(
	user: string,
	password: string = readPassword
): ParsedTenantReadCredential {
	return tenantReadCredentialSchema.parse({ user, password });
}

function quotaBody(id: string, quotaBytes: number): ParsedTenantCreateBody {
	return tenantCreateBodySchema.parse({
		id,
		readMode: 'private',
		ownerIssuer: 'https://idp.test',
		ownerSubject: 'owner',
		ownerAudience: 'aud',
		quotaBytes
	});
}

async function provision(body: ParsedTenantCreateBody): Promise<void> {
	await ensureTenant(database(), body, now);
}

async function rejectedBy(run: () => Promise<unknown>): Promise<unknown> {
	let rejected: unknown;

	try {
		await run();
	} catch (error) {
		rejected = error;
	}

	return rejected;
}

// Returns the rejected error's fields, or undefined if the call resolves. Race
// tests assert this result alongside the stored rows.
async function rejectionFields(
	run: () => Promise<unknown>
): Promise<ReturnType<typeof errorFields> | undefined> {
	const rejected = await rejectedBy(run);

	return rejected === undefined ? undefined : errorFields(rejected);
}

function errorFields(error: unknown): {
	readonly name: string;
	readonly status: number;
	readonly id?: string;
	readonly tenant?: string;
} {
	return z
		.object({
			name: z.string(),
			status: z.number(),
			id: z.string().optional(),
			tenant: z.string().optional()
		})
		.parse(error);
}

async function storedReadVerifier(id: TenantId): Promise<{
	readonly readUser: ReadUser;
	readonly readPasswordHash: ReadPasswordHash;
	readonly readPasswordSalt: ReadPasswordSalt;
}> {
	return z
		.object({
			readUser: readUserSchema,
			readPasswordHash: readPasswordHashSchema,
			readPasswordSalt: readPasswordSaltSchema
		})
		.parse(
			await database()
				.select({
					readUser: d1Schema.tenant.readUser,
					readPasswordHash: d1Schema.tenant.readPasswordHash,
					readPasswordSalt: d1Schema.tenant.readPasswordSalt
				})
				.from(d1Schema.tenant)
				.where(eq(d1Schema.tenant.id, id))
				.get()
		);
}

interface StoredCacheCredential {
	readonly cache: string;
	readonly readUser: string;
	readonly createdAt: string;
	readonly acceptsPassword: boolean;
	readonly storesPlaintext: boolean;
}

// Every private-cache credential row the tenant holds, in stored-name order,
// with the verifier checked against the password it was set from.
async function storedCacheCredentials(
	id: TenantId,
	password: string = readPassword
): Promise<StoredCacheCredential[]> {
	const rows = await database()
		.select()
		.from(d1Schema.tenantCacheReadCredential)
		.where(eq(d1Schema.tenantCacheReadCredential.tenant, id))
		.orderBy(asc(d1Schema.tenantCacheReadCredential.cache))
		.all();

	return Promise.all(
		rows.map(async (row) => ({
			cache: row.cache,
			readUser: row.readUser,
			createdAt: row.createdAt,
			acceptsPassword: await isReadPasswordMatching(
				password,
				row.readPasswordHash,
				row.readPasswordSalt
			),
			storesPlaintext: row.readPasswordHash === password
		}))
	);
}

// Deletes the tenant row directly. No application path does this: finalising an
// offboarded tenant keeps a tombstone, so only an operator removing that row
// leaves a guarded write with no tenant to match.
async function deleteTenantRow(id: TenantId): Promise<void> {
	await database()
		.delete(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, id))
		.run();
}

async function isPasswordAccepted(
	id: TenantId,
	cacheName: CacheName,
	password: string
): Promise<boolean> {
	const cache = privateStoredCache(cacheName);
	const row = await database()
		.select()
		.from(d1Schema.tenantCacheReadCredential)
		.where(
			and(
				eq(d1Schema.tenantCacheReadCredential.tenant, id),
				eq(d1Schema.tenantCacheReadCredential.cache, cache)
			)
		)
		.get();

	if (row === undefined) {
		return false;
	}

	return isReadPasswordMatching(
		password,
		row.readPasswordHash,
		row.readPasswordSalt
	);
}

describe('tenant registry', () => {
	it('creates a tenant and returns its summary', async () => {
		const summary = await ensureTenant(database(), createBody(acme), now);

		expect(summary).toStrictEqual({
			id: acme,
			status: 'active',
			readMode: 'private',
			ownerIssuer: 'https://idp.test',
			ownerSubject: 'owner',
			ownerAudience: 'aud',
			configVersion: 1,
			createdAt: now
		});
	});

	it('is idempotent for a matching re-create', async () => {
		await ensureTenant(database(), createBody(acme), now);
		const again = await ensureTenant(database(), createBody(acme), now);

		expect(again.id).toBe(acme);
	});

	it('repairs a legacy-normalised owner issuer and makes the repair idempotent', async () => {
		await ensureTenant(database(), createBody(acme), now);
		const exactBody = tenantCreateBodySchema.parse({
			...createBody(acme),
			ownerIssuer: 'https://idp.test/'
		});

		const repaired = await ensureTenant(database(), exactBody, now);
		const repeated = await ensureTenant(database(), exactBody, now);
		const oldIdentity = await rejectedBy(() =>
			ensureTenant(database(), createBody(acme), now)
		);

		expect({ repaired, repeated }).toStrictEqual({
			repaired: {
				id: acme,
				status: 'active',
				readMode: 'private',
				ownerIssuer: 'https://idp.test/',
				ownerSubject: 'owner',
				ownerAudience: 'aud',
				configVersion: 2,
				createdAt: now
			},
			repeated: {
				id: acme,
				status: 'active',
				readMode: 'private',
				ownerIssuer: 'https://idp.test/',
				ownerSubject: 'owner',
				ownerAudience: 'aud',
				configVersion: 2,
				createdAt: now
			}
		});
		expect(errorFields(oldIdentity)).toStrictEqual({
			name: 'TenantAlreadyExistsError',
			status: StatusCodes.CONFLICT,
			id: acme
		});
	});

	it('does not repair the owner issuer when another setting conflicts', async () => {
		await ensureTenant(database(), quotaBody(acme, 1000), now);
		const conflicting = tenantCreateBodySchema.parse({
			...quotaBody(acme, 2000),
			ownerIssuer: 'https://idp.test/'
		});

		const rejected = await rejectedBy(() =>
			ensureTenant(database(), conflicting, now)
		);
		const stored = await database()
			.select({
				ownerIssuer: d1Schema.tenant.ownerIssuer,
				configVersion: d1Schema.tenant.configVersion
			})
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, acme))
			.get();

		expect({ error: errorFields(rejected), stored }).toStrictEqual({
			error: {
				name: 'TenantAlreadyExistsError',
				status: StatusCodes.CONFLICT,
				id: acme
			},
			stored: { ownerIssuer: 'https://idp.test', configVersion: 1 }
		});
	});

	it('refuses a conflicting re-create of the same slug', async () => {
		await ensureTenant(database(), createBody(acme, 'private'), now);

		const rejected = await rejectedBy(() =>
			ensureTenant(database(), createBody(acme, 'public'), now)
		);

		expect(errorFields(rejected)).toStrictEqual({
			name: 'TenantAlreadyExistsError',
			status: StatusCodes.CONFLICT,
			id: acme
		});
	});

	it('stores only the hashed private-read verifier', async () => {
		await provision(privateBodyWithRead(acme));

		const row = await storedReadVerifier(acme);

		expect({
			user: row.readUser,
			passwordHash: row.readPasswordHash,
			hashIsPlaintext:
				row.readPasswordHash === 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23'
		}).toStrictEqual({
			user: 'cupboard',
			passwordHash: await hashReadPassword(
				'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23',
				row.readPasswordSalt
			),
			hashIsPlaintext: false
		});
	});

	it('is idempotent for a re-create with the same quota', async () => {
		await ensureTenant(database(), quotaBody(acme, 1000), now);
		const again = await ensureTenant(database(), quotaBody(acme, 1000), now);

		expect(again.id).toBe(acme);
	});

	it('refuses a re-create that changes the quota', async () => {
		await ensureTenant(database(), quotaBody(acme, 1000), now);

		const rejected = await rejectedBy(() =>
			ensureTenant(database(), quotaBody(acme, 2000), now)
		);

		expect(errorFields(rejected)).toStrictEqual({
			name: 'TenantAlreadyExistsError',
			status: StatusCodes.CONFLICT,
			id: acme
		});
	});

	it('rejects a conflicting re-create of a crash residue without writing a usage row', async () => {
		await database()
			.insert(d1Schema.tenant)
			.values({
				id: acme,
				status: 'active',
				readMode: 'private',
				ownerIssuer: 'https://idp.test',
				ownerSubject: 'owner',
				ownerAudience: 'aud',
				configVersion: 1,
				createdAt: now
			})
			.run();

		const rejected = await rejectedBy(() =>
			ensureTenant(database(), createBody(acme, 'public'), now)
		);
		const poisoned = await usageRow(acme);

		await ensureTenant(database(), createBody(acme, 'private'), now);
		const recovered = await usageRow(acme);

		expect({
			poisoned: poisoned !== undefined,
			recovered: recovered !== undefined
		}).toStrictEqual({ poisoned: false, recovered: true });
		expect(errorFields(rejected)).toStrictEqual({
			name: 'TenantAlreadyExistsError',
			status: StatusCodes.CONFLICT,
			id: acme
		});
	});

	it('creates the usage row on a retry after a crash left only the tenant row', async () => {
		const body = quotaBody(acme, 1000);

		await database()
			.insert(d1Schema.tenant)
			.values({
				id: body.id,
				status: 'active',
				readMode: body.readMode,
				ownerIssuer: body.ownerIssuer,
				ownerSubject: body.ownerSubject,
				ownerAudience: body.ownerAudience,
				configVersion: 1,
				createdAt: now
			})
			.run();

		const summary = await ensureTenant(database(), body, now);
		const usage = await database()
			.select({ quotaBytes: d1Schema.tenantUsage.quotaBytes })
			.from(d1Schema.tenantUsage)
			.where(eq(d1Schema.tenantUsage.tenant, body.id))
			.get();

		expect({ id: summary.id, quotaBytes: usage?.quotaBytes }).toStrictEqual({
			id: acme,
			quotaBytes: 1000
		});
	});

	it('lists tenants in id order', async () => {
		await ensureTenant(database(), createBody('beta'), now);
		await ensureTenant(database(), createBody('alpha'), now);

		const tenants = await listTenants(database());
		const ids = tenants.map((summary) => summary.id);

		expect(ids).toStrictEqual(['alpha', 'beta']);
	});

	it.each([
		{ name: 'suspends', status: 'suspended' as const },
		{ name: 'offboards', status: 'offboarding' as const }
	])(
		'$name a tenant and reflects it in the registry row',
		async ({ status }) => {
			await provision(createBody(acme));

			const summary = await setTenantStatus(database(), acme, status);
			const stored = await database()
				.select({ status: d1Schema.tenant.status })
				.from(d1Schema.tenant)
				.where(eq(d1Schema.tenant.id, acme))
				.get();

			expect({
				returned: summary.status,
				stored: stored?.status
			}).toStrictEqual({ returned: status, stored: status });
		}
	);

	it('throws not found when mutating an unknown tenant', async () => {
		const rejected = await rejectedBy(() =>
			setTenantStatus(database(), ghost, 'suspended')
		);

		expect(errorFields(rejected)).toStrictEqual({
			name: 'TenantNotFoundError',
			status: StatusCodes.NOT_FOUND,
			id: ghost
		});
	});

	it('treats a repeated offboard as terminal while refusing other status moves', async () => {
		await provision(createBody(acme));
		await setTenantStatus(database(), acme, 'offboarding');
		await finaliseOffboardedTenant(database(), acme);

		const repeated = await setTenantStatus(database(), acme, 'offboarding');

		const rejected = await rejectedBy(() =>
			setTenantStatus(database(), acme, 'suspended')
		);

		const stored = await database()
			.select({ status: d1Schema.tenant.status })
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, acme))
			.get();

		expect({
			repeatedStatus: repeated.status,
			storedStatus: stored?.status
		}).toStrictEqual({
			repeatedStatus: 'offboarded',
			storedStatus: 'offboarded'
		});
		expect(errorFields(rejected)).toStrictEqual({
			name: 'TenantRetiredError',
			status: StatusCodes.GONE,
			tenant: acme
		});
	});

	it('refuses to re-provision a slug that has begun offboarding', async () => {
		await provision(createBody(acme, 'private'));
		await setTenantStatus(database(), acme, 'offboarding');

		const rejected = await rejectedBy(() =>
			ensureTenant(database(), createBody(acme, 'private'), now)
		);

		expect(errorFields(rejected)).toStrictEqual({
			name: 'TenantAlreadyExistsError',
			status: StatusCodes.CONFLICT,
			id: acme
		});
	});

	it('finalises a drained tenant into a scrubbed tombstone that re-provisioning refuses', async () => {
		await provision(createBody(acme, 'private'));
		await database()
			.update(d1Schema.tenant)
			.set({
				readUser: readUserSchema.parse('reader'),
				readPasswordHash: readPasswordHashSchema.parse('0'.repeat(64))
			})
			.where(eq(d1Schema.tenant.id, acme))
			.run();
		await setTenantStatus(database(), acme, 'offboarding');

		await finaliseOffboardedTenant(database(), acme);

		const stored = await database()
			.select({
				status: d1Schema.tenant.status,
				readUser: d1Schema.tenant.readUser,
				readPasswordHash: d1Schema.tenant.readPasswordHash,
				ownerIssuer: d1Schema.tenant.ownerIssuer,
				ownerSubject: d1Schema.tenant.ownerSubject,
				ownerAudience: d1Schema.tenant.ownerAudience
			})
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, acme))
			.get();
		const row = {
			status: stored?.status,
			readUser: stored?.readUser ?? undefined,
			readPasswordHash: stored?.readPasswordHash ?? undefined,
			ownerIssuer: stored?.ownerIssuer,
			ownerSubject: stored?.ownerSubject,
			ownerAudience: stored?.ownerAudience
		};
		let reProvision: string;
		try {
			await ensureTenant(database(), createBody(acme, 'private'), now);
			reProvision = 'accepted';
		} catch (error: unknown) {
			reProvision =
				error instanceof TenantAlreadyExistsError ? 'refused' : 'other';
		}

		expect({
			row,
			usage: await usageRow(acme),
			reProvision
		}).toStrictEqual({
			row: {
				status: 'offboarded',
				readUser: undefined,
				readPasswordHash: undefined,
				ownerIssuer: '',
				ownerSubject: '',
				ownerAudience: ''
			},
			usage: undefined,
			reProvision: 'refused'
		});
	});
});

describe('tenant lifecycle operations', () => {
	it('resumes a suspended tenant back to active', async () => {
		await ensureTenant(database(), createBody(acme), now);
		await setTenantStatus(database(), acme, 'suspended');

		const resumed = await resumeTenant(database(), acme);

		expect({
			returned: resumed,
			stored: await listTenants(database())
		}).toStrictEqual({
			returned: {
				id: acme,
				status: 'active',
				readMode: 'private',
				ownerIssuer: 'https://idp.test',
				ownerSubject: 'owner',
				ownerAudience: 'aud',
				configVersion: 1,
				createdAt: now
			},
			stored: [
				{
					id: acme,
					status: 'active',
					readMode: 'private',
					ownerIssuer: 'https://idp.test',
					ownerSubject: 'owner',
					ownerAudience: 'aud',
					configVersion: 1,
					createdAt: now
				}
			]
		});
	});

	it.each([
		{
			name: 'active',
			setup: async () => {
				await ensureTenant(database(), createBody(acme), now);
			},
			error: TenantNotSuspendedError,
			fields: {
				name: 'TenantNotSuspendedError',
				status: StatusCodes.CONFLICT,
				tenant: acme
			}
		},
		{
			name: 'offboarding',
			setup: async () => {
				await ensureTenant(database(), createBody(acme), now);
				await setTenantStatus(database(), acme, 'offboarding');
			},
			error: TenantRetiredError,
			fields: {
				name: 'TenantRetiredError',
				status: StatusCodes.GONE,
				tenant: acme
			}
		},
		{
			name: 'missing',
			setup: () => Promise.resolve(),
			error: TenantNotFoundError,
			fields: {
				name: 'TenantNotFoundError',
				status: StatusCodes.NOT_FOUND,
				id: acme
			}
		}
	])('refuses to resume a $name tenant', async ({ setup, fields }) => {
		await setup();

		const rejected = await rejectedBy(() => resumeTenant(database(), acme));

		expect(errorFields(rejected)).toStrictEqual(fields);
	});

	it('sets the read mode of a live tenant', async () => {
		await ensureTenant(database(), createBody(acme, 'private'), now);

		const updated = await setTenantReadMode(database(), acme, 'public');

		expect({
			returned: updated,
			stored: await listTenants(database())
		}).toStrictEqual({
			returned: {
				id: acme,
				status: 'active',
				readMode: 'public',
				ownerIssuer: 'https://idp.test',
				ownerSubject: 'owner',
				ownerAudience: 'aud',
				configVersion: 1,
				createdAt: now
			},
			stored: [
				{
					id: acme,
					status: 'active',
					readMode: 'public',
					ownerIssuer: 'https://idp.test',
					ownerSubject: 'owner',
					ownerAudience: 'aud',
					configVersion: 1,
					createdAt: now
				}
			]
		});
	});

	it('stores a rotated read credential hashed, not in plaintext', async () => {
		await ensureTenant(database(), createBody(acme), now);

		await setTenantReadCredential(database(), acme, readCredential('reader'));
		const row = await storedReadVerifier(acme);

		expect({
			user: row.readUser,
			hash: row.readPasswordHash,
			hashIsPlaintext:
				row.readPasswordHash === 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23'
		}).toStrictEqual({
			user: 'reader',
			hash: await hashReadPassword(
				'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23',
				row.readPasswordSalt
			),
			hashIsPlaintext: false
		});
	});

	it('clears a read credential to empty columns', async () => {
		await ensureTenant(database(), privateBodyWithRead(acme), now);

		await clearTenantReadCredential(database(), acme);
		const row = await database()
			.select({
				readUser: d1Schema.tenant.readUser,
				readPasswordHash: d1Schema.tenant.readPasswordHash,
				readPasswordSalt: d1Schema.tenant.readPasswordSalt
			})
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, acme))
			.get();

		expect({
			user: row?.readUser ?? undefined,
			hash: row?.readPasswordHash ?? undefined,
			salt: row?.readPasswordSalt ?? undefined
		}).toStrictEqual({ user: undefined, hash: undefined, salt: undefined });
	});

	it.each([
		{
			name: 'read mode',
			run: (id: TenantId) => setTenantReadMode(database(), id, 'public')
		},
		{
			name: 'read credential',
			run: (id: TenantId) =>
				setTenantReadCredential(database(), id, readCredential('reader'))
		},
		{
			name: 'cleared credential',
			run: (id: TenantId) => clearTenantReadCredential(database(), id)
		}
	])('refuses to set the $name of an offboarding tenant', async ({ run }) => {
		await ensureTenant(database(), createBody(acme), now);
		await setTenantStatus(database(), acme, 'offboarding');

		const rejected = await rejectedBy(() => run(acme));

		expect(errorFields(rejected)).toStrictEqual({
			name: 'TenantRetiredError',
			status: StatusCodes.GONE,
			tenant: acme
		});
	});
});

describe('private cache read credentials', () => {
	const cacheCredentialWrites = [
		{
			operation: 'set',
			run: (id: TenantId) =>
				setCacheReadCredential(
					database(),
					id,
					builds,
					readCredential('reader'),
					now
				)
		},
		{
			operation: 'clear',
			run: (id: TenantId) => clearCacheReadCredential(database(), id, builds)
		}
	];

	const retirements = [
		{
			status: 'offboarding',
			retire: async (id: TenantId) => {
				await setTenantStatus(database(), id, 'offboarding');
			}
		},
		{
			status: 'offboarded',
			retire: async (id: TenantId) => {
				await setTenantStatus(database(), id, 'offboarding');
				await finaliseOffboardedTenant(database(), id);
			}
		}
	];

	it('stores a hashed verifier for the named cache', async () => {
		await ensureTenant(database(), createBody(acme), now);

		await setCacheReadCredential(
			database(),
			acme,
			builds,
			readCredential('reader'),
			now
		);

		expect(await storedCacheCredentials(acme)).toStrictEqual([
			{
				cache: 'private/builds',
				readUser: 'reader',
				createdAt: now,
				acceptsPassword: true,
				storesPlaintext: false
			}
		]);
	});

	it('replaces the verifier so the previous password stops working', async () => {
		await ensureTenant(database(), createBody(acme), now);
		await setCacheReadCredential(
			database(),
			acme,
			builds,
			readCredential('reader'),
			now
		);

		await setCacheReadCredential(
			database(),
			acme,
			builds,
			readCredential('rotated', rotatedReadPassword),
			now
		);
		const [stored] = await storedCacheCredentials(acme, rotatedReadPassword);

		expect({
			stored,
			acceptsPreviousPassword: await isPasswordAccepted(
				acme,
				builds,
				readPassword
			)
		}).toStrictEqual({
			stored: {
				cache: 'private/builds',
				readUser: 'rotated',
				createdAt: now,
				acceptsPassword: true,
				storesPlaintext: false
			},
			acceptsPreviousPassword: false
		});
	});

	it('keeps one cache credential when a sibling cache is cleared', async () => {
		await ensureTenant(database(), createBody(acme), now);
		await setCacheReadCredential(
			database(),
			acme,
			builds,
			readCredential('reader'),
			now
		);
		await setCacheReadCredential(
			database(),
			acme,
			guides,
			readCredential('reader'),
			now
		);

		await clearCacheReadCredential(database(), acme, builds);

		expect(await storedCacheCredentials(acme)).toStrictEqual([
			{
				cache: 'private/guides',
				readUser: 'reader',
				createdAt: now,
				acceptsPassword: true,
				storesPlaintext: false
			}
		]);
	});

	it('clears a cache that has no credential of its own', async () => {
		await ensureTenant(database(), createBody(acme), now);

		await clearCacheReadCredential(database(), acme, builds);

		expect(await storedCacheCredentials(acme)).toStrictEqual([]);
	});

	it('deletes every cache credential when the tenant is finalised', async () => {
		await provision(createBody(acme, 'private'));
		await setCacheReadCredential(
			database(),
			acme,
			builds,
			readCredential('reader'),
			now
		);
		await setCacheReadCredential(
			database(),
			acme,
			guides,
			readCredential('reader'),
			now
		);
		await setTenantStatus(database(), acme, 'offboarding');

		await finaliseOffboardedTenant(database(), acme);

		expect(await storedCacheCredentials(acme)).toStrictEqual([]);
	});

	it.each(
		cacheCredentialWrites.flatMap((write) =>
			retirements.map((retirement) => ({ ...write, ...retirement }))
		)
	)(
		'refuses to $operation a cache credential for an $status tenant',
		async ({ retire, run }) => {
			await ensureTenant(database(), createBody(acme), now);
			await retire(acme);

			const rejected = await rejectedBy(() => run(acme));

			expect(errorFields(rejected)).toStrictEqual({
				name: 'TenantRetiredError',
				status: StatusCodes.GONE,
				tenant: acme
			});
		}
	);

	it('rotates a cache credential while the tenant is suspended', async () => {
		await ensureTenant(database(), createBody(acme), now);
		await setTenantStatus(database(), acme, 'suspended');

		await setCacheReadCredential(
			database(),
			acme,
			builds,
			readCredential('reader'),
			now
		);

		expect(await storedCacheCredentials(acme)).toStrictEqual([
			{
				cache: 'private/builds',
				readUser: 'reader',
				createdAt: now,
				acceptsPassword: true,
				storesPlaintext: false
			}
		]);
	});

	// Rotation reads the tenant status before hashing the password. Start
	// rotation without awaiting it, then finish offboarding while hashing delays
	// the insert. This exercises the live-tenant condition in the insert.
	it('writes no credential when offboarding completes after the status check', async () => {
		await ensureTenant(database(), createBody(acme), now);

		const rotation = setCacheReadCredential(
			database(),
			acme,
			builds,
			readCredential('reader'),
			now
		);

		await setTenantStatus(database(), acme, 'offboarding');
		await finaliseOffboardedTenant(database(), acme);

		expect({
			error: await rejectionFields(() => rotation),
			stored: await storedCacheCredentials(acme)
		}).toStrictEqual({
			error: {
				name: 'TenantRetiredError',
				status: StatusCodes.GONE,
				tenant: acme
			},
			stored: []
		});
	});

	it('writes no credential when the tenant row is deleted after the status check', async () => {
		await ensureTenant(database(), createBody(acme), now);

		const rotation = setCacheReadCredential(
			database(),
			acme,
			builds,
			readCredential('reader'),
			now
		);

		await deleteTenantRow(acme);

		expect({
			error: await rejectionFields(() => rotation),
			stored: await storedCacheCredentials(acme)
		}).toStrictEqual({
			error: {
				name: 'TenantNotFoundError',
				status: StatusCodes.NOT_FOUND,
				id: acme
			},
			stored: []
		});
	});

	it.each(cacheCredentialWrites)(
		'refuses to $operation a cache credential for an unknown tenant',
		async ({ run }) => {
			const rejected = await rejectedBy(() => run(ghost));

			expect(errorFields(rejected)).toStrictEqual({
				name: 'TenantNotFoundError',
				status: StatusCodes.NOT_FOUND,
				id: ghost
			});
		}
	);
});
