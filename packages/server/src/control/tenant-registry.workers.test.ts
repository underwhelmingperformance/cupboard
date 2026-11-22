import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import {
	type TenantCreateBody,
	tenantCreateBodySchema,
	type TenantQuota,
	type TenantStatus
} from '@cupboard/protocol/tenants';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import {
	TenantAlreadyExistsError,
	TenantNotFoundError,
	TenantNotSuspendedError,
	TenantOffboardingError,
	TenantRetiredError
} from '../errors.ts';

import {
	ensureTenant,
	finaliseOffboardedTenant,
	getTenantQuota,
	listTenants,
	resumeTenant,
	setTenantQuota,
	setTenantStatus
} from './tenant-registry.ts';

interface RetryClock {
	set(milliseconds: number): Promise<void>;
}

interface RetryClockTrigger {
	readonly name: string;
	readonly sql: string;
}

async function withRetryClock(
	run: (clock: RetryClock) => Promise<void>
): Promise<void> {
	const nativeClock =
		"CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)";
	const query = env.CUPBOARD_DB.prepare(
		"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('tenant_retry_clock_insert', 'tenant_retry_clock_status') ORDER BY name"
	);
	const { results: triggers } = await query.all<RetryClockTrigger>();
	expect(
		triggers.map((trigger) => ({
			name: trigger.name,
			clockReads: trigger.sql.split(nativeClock).length - 1
		}))
	).toStrictEqual([
		{ name: 'tenant_retry_clock_insert', clockReads: 1 },
		{ name: 'tenant_retry_clock_status', clockReads: 2 }
	]);

	await env.CUPBOARD_DB.batch([
		env.CUPBOARD_DB.prepare(
			'CREATE TABLE __test_retry_clock (id INTEGER PRIMARY KEY CHECK(id = 1), milliseconds INTEGER NOT NULL)'
		),
		env.CUPBOARD_DB.prepare(
			'INSERT INTO __test_retry_clock (id, milliseconds) VALUES (1, 0)'
		),
		...triggers.flatMap((trigger) => [
			env.CUPBOARD_DB.prepare(`DROP TRIGGER ${trigger.name}`),
			env.CUPBOARD_DB.prepare(
				trigger.sql.replaceAll(
					nativeClock,
					'(SELECT milliseconds FROM __test_retry_clock WHERE id = 1)'
				)
			)
		])
	]);

	try {
		await run({
			async set(milliseconds) {
				vi.setSystemTime(milliseconds);
				await env.CUPBOARD_DB.prepare(
					'UPDATE __test_retry_clock SET milliseconds = ? WHERE id = 1'
				)
					.bind(milliseconds)
					.run();
			}
		});
	} finally {
		await env.CUPBOARD_DB.batch([
			...triggers.flatMap((trigger) => [
				env.CUPBOARD_DB.prepare(`DROP TRIGGER ${trigger.name}`),
				env.CUPBOARD_DB.prepare(trigger.sql)
			]),
			env.CUPBOARD_DB.prepare('DROP TABLE __test_retry_clock')
		]);
	}

	const { results: restored } = await query.all<RetryClockTrigger>();
	const { results: clocks } = await env.CUPBOARD_DB.prepare(
		"SELECT name FROM sqlite_master WHERE name = '__test_retry_clock'"
	).all<{ name: string }>();
	expect({ triggers: restored, clocks }).toStrictEqual({
		triggers,
		clocks: []
	});
}

describe('tenant retry eligibility clock', () => {
	it.each(['suspended', 'offboarding'] as const)(
		'pauses active time on a predecessor-compatible %s status write',
		async (status) => {
			await withRetryClock(async (clock) => {
				const started = Date.parse(now);
				await clock.set(started);
				await ensureTenant(database(), createBody(acme), now);
				const row = env.CUPBOARD_DB.prepare(
					'SELECT status, retry_active_elapsed_ms AS elapsed, retry_active_since_ms AS started FROM tenant WHERE id = ?'
				).bind(acme);
				const read = async () => {
					const stored = await row.first<{
						status: TenantStatus;
						elapsed: number;
						started: number | null;
					}>();
					if (stored == undefined) {
						return;
					}
					return { ...stored, started: stored.started ?? undefined };
				};
				const initial = await read();
				await env.CUPBOARD_DB.prepare(
					'UPDATE tenant SET retry_active_elapsed_ms = 5000 WHERE id = ?'
				)
					.bind(acme)
					.run();

				await clock.set(started + 1000);
				await env.CUPBOARD_DB.prepare(
					'UPDATE tenant SET status = ? WHERE id = ?'
				)
					.bind(status, acme)
					.run();
				const paused = await read();

				await clock.set(started + 6000);
				await env.CUPBOARD_DB.prepare(
					'UPDATE tenant SET status = ? WHERE id = ?'
				)
					.bind(status, acme)
					.run();
				const repeated = await read();
				expect({ initial, paused, repeated }).toStrictEqual({
					initial: { status: 'active', elapsed: 0, started },
					paused: { status, elapsed: 6000, started: undefined },
					repeated: { status, elapsed: 6000, started: undefined }
				});
				if (status !== 'suspended') {
					return;
				}

				await resumeTenant(database(), acme);
				const resumed = await read();
				await clock.set(started + 6500);
				await env.CUPBOARD_DB.prepare(
					'UPDATE tenant SET status = ? WHERE id = ?'
				)
					.bind('suspended', acme)
					.run();
				const pausedAgain = await read();
				expect({ resumed, pausedAgain }).toStrictEqual({
					resumed: { status: 'active', elapsed: 6000, started: started + 6000 },
					pausedAgain: {
						status: 'suspended',
						elapsed: 6500,
						started: undefined
					}
				});
			});
		}
	);
});

const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
const acme = tenantIdSchema.parse('acme');
const ghost = tenantIdSchema.parse('ghost');

function database(): ReturnType<typeof drizzleD1<typeof d1Schema>> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

async function usageRow(): Promise<
	undefined | { quotaBytes: number | undefined }
> {
	const row = await database()
		.select({ quotaBytes: d1Schema.tenantUsage.quotaBytes })
		.from(d1Schema.tenantUsage)
		.where(eq(d1Schema.tenantUsage.tenant, acme))
		.get();

	return row === undefined
		? undefined
		: { quotaBytes: row.quotaBytes ?? undefined };
}

function createBody(
	id: string,
	defaultCacheAccess: 'public' | 'private' = 'private'
): TenantCreateBody {
	return tenantCreateBodySchema.parse({
		id,
		defaultCacheAccess,
		ownerIssuer: 'https://idp.test',
		ownerSubject: 'owner',
		ownerAudience: 'aud'
	});
}

function quotaBody(quotaBytes: number): TenantCreateBody {
	return tenantCreateBodySchema.parse({
		id: acme,
		defaultCacheAccess: 'private',
		ownerIssuer: 'https://idp.test',
		ownerSubject: 'owner',
		ownerAudience: 'aud',
		quotaBytes
	});
}

async function provision(body: TenantCreateBody): Promise<void> {
	await ensureTenant(database(), body, now);
}

async function tenantWithStatus(status: TenantStatus): Promise<void> {
	await provision(createBody(acme));

	if (status === 'active') {
		return;
	}

	if (status === 'suspended') {
		await setTenantStatus(database(), acme, 'suspended');
		return;
	}

	await setTenantStatus(database(), acme, 'offboarding');

	if (status === 'offboarded') {
		await finaliseOffboardedTenant(database(), acme);
	}
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

describe('tenant registry', () => {
	it('creates a tenant and returns its summary', async () => {
		const summary = await ensureTenant(database(), createBody(acme), now);
		const defaultCache = await database()
			.select({ access: d1Schema.cacheLifecycle.access })
			.from(d1Schema.cacheLifecycle)
			.where(eq(d1Schema.cacheLifecycle.tenant, acme))
			.get();

		expect({ summary, defaultCache }).toStrictEqual({
			summary: {
				id: acme,
				status: 'active',
				ownerIssuer: 'https://idp.test',
				ownerSubject: 'owner',
				ownerAudience: 'aud',
				configVersion: 1,
				createdAt: now
			},
			defaultCache: { access: 'private' }
		});
	});

	it('is idempotent for a matching re-create', async () => {
		await ensureTenant(database(), createBody(acme), now);
		const again = await ensureTenant(database(), createBody(acme), now);

		expect(again.id).toBe(acme);
	});

	it.each([
		['https://idp.test', 'https://idp.test/'],
		['https://idp.test/', 'https://idp.test'],
		['https://idp.test/realm', 'https://idp.test/realm/'],
		['https://idp.test/realm/', 'https://idp.test/realm']
	])(
		'refuses to re-create issuer %s as %s',
		async (storedIssuer, requestedIssuer) => {
			const storedBody = tenantCreateBodySchema.parse({
				...createBody(acme),
				ownerIssuer: storedIssuer
			});
			const requestedBody = tenantCreateBodySchema.parse({
				...createBody(acme),
				ownerIssuer: requestedIssuer
			});
			const created = await ensureTenant(database(), storedBody, now);
			const repeated = await ensureTenant(database(), storedBody, now);
			const rejected = await rejectedBy(() =>
				ensureTenant(database(), requestedBody, now)
			);
			const stored = await database()
				.select({
					ownerIssuer: d1Schema.tenant.ownerIssuer,
					configVersion: d1Schema.tenant.configVersion
				})
				.from(d1Schema.tenant)
				.where(eq(d1Schema.tenant.id, acme))
				.get();
			const summary = {
				id: acme,
				status: 'active',
				ownerIssuer: storedIssuer,
				ownerSubject: 'owner',
				ownerAudience: 'aud',
				configVersion: 1,
				createdAt: now
			};

			expect({
				created,
				repeated,
				rejected: errorFields(rejected),
				stored
			}).toStrictEqual({
				created: summary,
				repeated: summary,
				rejected: {
					name: 'TenantAlreadyExistsError',
					status: StatusCodes.CONFLICT,
					id: acme
				},
				stored: { ownerIssuer: storedIssuer, configVersion: 1 }
			});
		}
	);

	it('preserves the owner issuer when a conflicting retry also changes the quota', async () => {
		await ensureTenant(database(), quotaBody(1000), now);
		const conflicting = tenantCreateBodySchema.parse({
			...quotaBody(2000),
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

	it('is idempotent for a re-create with the same quota', async () => {
		await ensureTenant(database(), quotaBody(1000), now);
		const again = await ensureTenant(database(), quotaBody(1000), now);

		expect(again.id).toBe(acme);
	});

	it('refuses a re-create that changes the quota', async () => {
		await ensureTenant(database(), quotaBody(1000), now);

		const rejected = await rejectedBy(() =>
			ensureTenant(database(), quotaBody(2000), now)
		);

		expect(errorFields(rejected)).toStrictEqual({
			name: 'TenantAlreadyExistsError',
			status: StatusCodes.CONFLICT,
			id: acme
		});
	});

	it('writes no tenant row when the usage row cannot be stored', async () => {
		// The create schema rejects a negative quota, so the value bypasses it.
		// The usage insert then violates the quota CHECK, which fails a statement
		// of the batch after the tenant insert.
		const body = { ...quotaBody(0), quotaBytes: -1 };

		const rejected = await rejectedBy(() =>
			ensureTenant(database(), body, now)
		);
		const tenant = await database()
			.select({ id: d1Schema.tenant.id })
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, acme))
			.get();

		expect({
			failed: rejected !== undefined,
			tenantStored: tenant !== undefined,
			usageStored: (await usageRow()) !== undefined
		}).toStrictEqual({
			failed: true,
			tenantStored: false,
			usageStored: false
		});
	});

	it.each([
		{
			table: 'tenant_blob',
			insert:
				'INSERT INTO tenant_blob (tenant, nar_hash, file_size) VALUES (?, ?, 13)',
			digest: `sha256:${'0'.repeat(52)}`
		},
		{
			table: 'tenant_cas_blob',
			insert:
				'INSERT INTO tenant_cas_blob (tenant, digest, size) VALUES (?, ?, 13)',
			digest: 'a'.repeat(64)
		},
		{
			table: 'blob_ref_storage',
			insert:
				"INSERT INTO blob_ref_storage (tenant, nar_hash, cache_kind, store_path_hash, generation, cache_generation) VALUES (?, ?, 'default', '00000000000000000000000000000000', 0, 1)",
			digest: `sha256:${'0'.repeat(52)}`
		},
		{
			table: 'attestation_ref_storage',
			insert:
				"INSERT INTO attestation_ref_storage (tenant, digest, cache_kind, store_path_hash, generation, predicate_type) VALUES (?, ?, 'default', '00000000000000000000000000000000', 0, 'https://slsa.dev/provenance/v1')",
			digest: 'a'.repeat(64)
		}
	])(
		'refuses zero accounting repair when $table already has tenant data',
		async ({ table, insert, digest }) => {
			const body = quotaBody(1000);
			await ensureTenant(database(), body, now);
			await env.CUPBOARD_DB.prepare(insert).bind(acme, digest).run();
			await database()
				.delete(d1Schema.tenantUsage)
				.where(eq(d1Schema.tenantUsage.tenant, acme));
			const rowsBefore = await env.CUPBOARD_DB.prepare(
				`SELECT * FROM ${table} WHERE tenant = ?`
			)
				.bind(acme)
				.all();
			const rejected = await rejectedBy(() =>
				ensureTenant(database(), body, now)
			);
			const rowsAfter = await env.CUPBOARD_DB.prepare(
				`SELECT * FROM ${table} WHERE tenant = ?`
			)
				.bind(acme)
				.all();
			expect({
				error: rejected === undefined ? undefined : errorFields(rejected),
				usage: await usageRow(),
				rows: rowsAfter.results
			}).toStrictEqual({
				error: {
					name: 'TenantUsageRepairRequiredError',
					status: StatusCodes.INTERNAL_SERVER_ERROR,
					tenant: acme
				},
				usage: undefined,
				rows: rowsBefore.results
			});
		}
	);

	it('repairs a tenant row created before provisioning became atomic', async () => {
		await database()
			.insert(d1Schema.tenant)
			.values({
				id: acme,
				status: 'active',
				ownerIssuer: 'https://idp.test',
				ownerSubject: 'owner',
				ownerAudience: 'aud',
				configVersion: 1,
				createdAt: now
			})
			.run();

		await ensureTenant(database(), createBody(acme, 'public'), now);
		const access = await database()
			.select({ access: d1Schema.cacheLifecycle.access })
			.from(d1Schema.cacheLifecycle)
			.where(eq(d1Schema.cacheLifecycle.tenant, acme))
			.get();
		const rejected = await rejectedBy(() =>
			ensureTenant(database(), createBody(acme, 'private'), now)
		);

		expect({ access, usage: await usageRow() }).toStrictEqual({
			access: { access: 'public' },
			usage: { quotaBytes: undefined }
		});
		expect(errorFields(rejected)).toStrictEqual({
			name: 'TenantAlreadyExistsError',
			status: StatusCodes.CONFLICT,
			id: acme
		});
	});

	it('creates the usage row on a retry after a crash left only the tenant row', async () => {
		const body = quotaBody(1000);

		await database()
			.insert(d1Schema.tenant)
			.values({
				id: body.id,
				status: 'active',
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

		const { tenants } = await listTenants(database());
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

	it.each<{
		readonly from: TenantStatus;
		readonly to: 'suspended' | 'offboarding';
		readonly outcome: unknown;
		readonly stored: TenantStatus;
	}>([
		{
			from: 'active',
			to: 'suspended',
			outcome: 'suspended',
			stored: 'suspended'
		},
		{
			from: 'suspended',
			to: 'suspended',
			outcome: 'suspended',
			stored: 'suspended'
		},
		{
			from: 'offboarding',
			to: 'suspended',
			outcome: {
				name: 'TenantOffboardingError',
				status: StatusCodes.CONFLICT,
				tenant: acme
			},
			stored: 'offboarding'
		},
		{
			from: 'offboarded',
			to: 'suspended',
			outcome: {
				name: 'TenantRetiredError',
				status: StatusCodes.GONE,
				tenant: acme
			},
			stored: 'offboarded'
		},
		{
			from: 'active',
			to: 'offboarding',
			outcome: 'offboarding',
			stored: 'offboarding'
		},
		{
			from: 'suspended',
			to: 'offboarding',
			outcome: 'offboarding',
			stored: 'offboarding'
		},
		{
			from: 'offboarding',
			to: 'offboarding',
			outcome: 'offboarding',
			stored: 'offboarding'
		},
		{
			from: 'offboarded',
			to: 'offboarding',
			outcome: 'offboarded',
			stored: 'offboarded'
		}
	])(
		'changes the tenant from $from to $to or throws the expected error',
		async ({ from, to, outcome, stored }) => {
			await tenantWithStatus(from);

			let result: unknown;

			try {
				const summary = await setTenantStatus(database(), acme, to);
				result = summary.status;
			} catch (error) {
				result = errorFields(error);
			}

			const row = await database()
				.select({ status: d1Schema.tenant.status })
				.from(d1Schema.tenant)
				.where(eq(d1Schema.tenant.id, acme))
				.get();

			expect({ outcome: result, stored: row?.status }).toStrictEqual({
				outcome,
				stored
			});
		}
	);

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
		await setTenantStatus(database(), acme, 'offboarding');

		await finaliseOffboardedTenant(database(), acme);

		const stored = await database()
			.select({
				status: d1Schema.tenant.status,
				ownerIssuer: d1Schema.tenant.ownerIssuer,
				ownerSubject: d1Schema.tenant.ownerSubject,
				ownerAudience: d1Schema.tenant.ownerAudience
			})
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, acme))
			.get();
		const row = {
			status: stored?.status,
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
		const defaultCache = await database()
			.select({ access: d1Schema.cacheLifecycle.access })
			.from(d1Schema.cacheLifecycle)
			.where(eq(d1Schema.cacheLifecycle.tenant, acme))
			.get();

		expect({
			row,
			usage: await usageRow(),
			defaultCache,
			reProvision
		}).toStrictEqual({
			row: {
				status: 'offboarded',
				ownerIssuer: '',
				ownerSubject: '',
				ownerAudience: ''
			},
			usage: undefined,
			defaultCache: undefined,
			reProvision: 'refused'
		});
	});
});

describe('tenant lifecycle operations', () => {
	it('resumes a suspended tenant back to active', async () => {
		await ensureTenant(database(), createBody(acme), now);
		await setTenantStatus(database(), acme, 'suspended');

		const resumed = await resumeTenant(database(), acme);
		const { tenants: stored } = await listTenants(database());

		expect({
			returned: resumed,
			stored
		}).toStrictEqual({
			returned: {
				id: acme,
				status: 'active',
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
			error: TenantOffboardingError,
			fields: {
				name: 'TenantOffboardingError',
				status: StatusCodes.CONFLICT,
				tenant: acme
			}
		},
		{
			name: 'offboarded',
			setup: async () => {
				await ensureTenant(database(), createBody(acme), now);
				await setTenantStatus(database(), acme, 'offboarding');
				await finaliseOffboardedTenant(database(), acme);
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
});

async function chargeUsage(): Promise<void> {
	await database()
		.update(d1Schema.tenantUsage)
		.set({ bytes: 60, casBytes: 20 })
		.where(eq(d1Schema.tenantUsage.tenant, acme))
		.run();
}

function limitedTo(bytes: number): TenantQuota {
	return { kind: 'limited', bytes };
}

const unlimited: TenantQuota = { kind: 'unlimited' };

describe('getTenantQuota', () => {
	it('reads the limit and charged bytes while a tenant changes state', async () => {
		await provision(quotaBody(100));
		await chargeUsage();
		const active = await getTenantQuota(database(), acme);
		await setTenantStatus(database(), acme, 'suspended');
		const suspended = await getTenantQuota(database(), acme);
		await setTenantStatus(database(), acme, 'offboarding');
		const offboarding = await getTenantQuota(database(), acme);

		expect({
			active,
			suspended,
			offboarding,
			stored: await usageRow()
		}).toStrictEqual({
			active: { id: acme, quota: limitedTo(100), usedBytes: 80 },
			suspended: { id: acme, quota: limitedTo(100), usedBytes: 80 },
			offboarding: { id: acme, quota: limitedTo(100), usedBytes: 80 },
			stored: { quotaBytes: 100 }
		});
	});

	it('reports unlimited storage without changing the usage row', async () => {
		await provision(createBody(acme));
		await chargeUsage();

		expect({
			read: await getTenantQuota(database(), acme),
			stored: await usageRow()
		}).toStrictEqual({
			read: { id: acme, quota: unlimited, usedBytes: 80 },
			stored: { quotaBytes: undefined }
		});
	});

	it.each([
		{
			name: 'missing tenant',
			setup: () => Promise.resolve(),
			expected: {
				name: 'TenantNotFoundError',
				status: StatusCodes.NOT_FOUND,
				id: acme
			}
		},
		{
			name: 'offboarded tenant',
			setup: async () => {
				await provision(createBody(acme));
				await setTenantStatus(database(), acme, 'offboarding');
				await finaliseOffboardedTenant(database(), acme);
			},
			expected: {
				name: 'TenantRetiredError',
				status: StatusCodes.GONE,
				tenant: acme
			}
		},
		{
			name: 'missing usage row',
			setup: async () => {
				await provision(createBody(acme));
				await database()
					.delete(d1Schema.tenantUsage)
					.where(eq(d1Schema.tenantUsage.tenant, acme))
					.run();
			},
			expected: {
				name: 'TenantUsageMissingError',
				status: StatusCodes.INTERNAL_SERVER_ERROR,
				tenant: acme
			}
		}
	])('refuses a $name', async ({ setup, expected }) => {
		await setup();

		const rejected = await rejectedBy(() => getTenantQuota(database(), acme));

		expect(errorFields(rejected)).toStrictEqual(expected);
	});
});

describe('setTenantQuota', () => {
	it('raises, lowers to the charged bytes, and clears a quota', async () => {
		await provision(quotaBody(100));
		await chargeUsage();

		const raised = await setTenantQuota(database(), acme, limitedTo(500), now);
		const lowered = await setTenantQuota(database(), acme, limitedTo(80), now);
		const cleared = await setTenantQuota(database(), acme, unlimited, now);

		expect({
			raised,
			lowered,
			cleared,
			stored: await usageRow()
		}).toStrictEqual({
			raised: { id: acme, quota: limitedTo(500), usedBytes: 80 },
			lowered: { id: acme, quota: limitedTo(80), usedBytes: 80 },
			cleared: { id: acme, quota: unlimited, usedBytes: 80 },
			stored: { quotaBytes: undefined }
		});
	});

	it('limits a tenant created without a quota', async () => {
		await provision(createBody(acme));

		const limited = await setTenantQuota(
			database(),
			acme,
			limitedTo(1024),
			now
		);

		expect({ limited, stored: await usageRow() }).toStrictEqual({
			limited: { id: acme, quota: limitedTo(1024), usedBytes: 0 },
			stored: { quotaBytes: 1024 }
		});
	});

	it('refuses a quota below the charged bytes and keeps the old one', async () => {
		await provision(quotaBody(100));
		await chargeUsage();

		const rejected = await rejectedBy(() =>
			setTenantQuota(database(), acme, limitedTo(79), now)
		);

		expect({
			error: {
				...errorFields(rejected),
				usedBytes: z.object({ usedBytes: z.number() }).parse(rejected).usedBytes
			},
			stored: await usageRow()
		}).toStrictEqual({
			error: {
				name: 'TenantQuotaBelowUsageError',
				status: StatusCodes.CONFLICT,
				id: acme,
				usedBytes: 80
			},
			stored: { quotaBytes: 100 }
		});
	});

	it('sets the quota of a suspended tenant', async () => {
		await provision(createBody(acme));
		await setTenantStatus(database(), acme, 'suspended');

		expect(
			await setTenantQuota(database(), acme, limitedTo(10), now)
		).toStrictEqual({
			id: acme,
			quota: limitedTo(10),
			usedBytes: 0
		});
	});

	it.each([
		{
			name: 'being removed',
			setup: async () => {
				await provision(quotaBody(100));
				await setTenantStatus(database(), acme, 'offboarding');
			},
			fields: {
				name: 'TenantOffboardingError',
				status: StatusCodes.CONFLICT,
				tenant: acme
			}
		},
		{
			name: 'offboarded',
			setup: async () => {
				await provision(quotaBody(100));
				await setTenantStatus(database(), acme, 'offboarding');
				await finaliseOffboardedTenant(database(), acme);
			},
			fields: {
				name: 'TenantRetiredError',
				status: StatusCodes.GONE,
				tenant: acme
			}
		},
		{
			name: 'missing',
			setup: () => Promise.resolve(),
			fields: {
				name: 'TenantNotFoundError',
				status: StatusCodes.NOT_FOUND,
				id: acme
			}
		},
		{
			name: 'without a usage row',
			setup: async () => {
				await provision(createBody(acme));
				await database()
					.delete(d1Schema.tenantUsage)
					.where(eq(d1Schema.tenantUsage.tenant, acme))
					.run();
			},
			fields: {
				name: 'TenantUsageMissingError',
				status: StatusCodes.INTERNAL_SERVER_ERROR,
				tenant: acme
			}
		}
	])('refuses a tenant $name', async ({ setup, fields }) => {
		await setup();

		const rejected = await rejectedBy(() =>
			setTenantQuota(database(), acme, limitedTo(1000), now)
		);

		expect(errorFields(rejected)).toStrictEqual(fields);
	});
});
