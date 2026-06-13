import {
	type ParsedTenantCreateBody,
	tenantCreateBodySchema
} from '@cupboard/protocol/tenants';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import {
	TenantAlreadyExistsError,
	TenantNotFoundError,
	TenantRetiredError
} from '../errors.ts';

import {
	ensureTenant,
	finaliseOffboardedTenant,
	listTenants,
	setTenantStatus
} from './tenant-registry.ts';

const now = '2026-01-01T00:00:00.000Z';

function database(): ReturnType<typeof drizzleD1<typeof d1Schema>> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

function usageRow(
	id: string
): Promise<{ quotaBytes: number | null } | undefined> {
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
			password: 'correct-horse-battery-staple'
		},
		ownerIssuer: 'https://idp.test',
		ownerSubject: 'owner',
		ownerAudience: 'aud'
	});
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

describe('tenant registry', () => {
	it('creates a tenant and returns its summary', async () => {
		const summary = await ensureTenant(database(), createBody('acme'), now);

		expect(summary).toStrictEqual({
			id: 'acme',
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
		await ensureTenant(database(), createBody('acme'), now);
		const again = await ensureTenant(database(), createBody('acme'), now);

		expect(again.id).toBe('acme');
	});

	it('refuses a conflicting re-create of the same slug', async () => {
		await ensureTenant(database(), createBody('acme', 'private'), now);

		await expect(
			ensureTenant(database(), createBody('acme', 'public'), now)
		).rejects.toThrow(TenantAlreadyExistsError);
	});

	it('stores only the hashed private-read verifier', async () => {
		await provision(privateBodyWithRead('acme'));

		const row = await database()
			.select({
				readUser: d1Schema.tenant.readUser,
				readPasswordHash: d1Schema.tenant.readPasswordHash,
				readPasswordSalt: d1Schema.tenant.readPasswordSalt
			})
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, 'acme'))
			.get();

		expect({
			user: row?.readUser,
			passwordHash: typeof row?.readPasswordHash,
			passwordSalt: typeof row?.readPasswordSalt,
			hashIsPlaintext: row?.readPasswordHash === 'correct-horse-battery-staple'
		}).toStrictEqual({
			user: 'cupboard',
			passwordHash: 'string',
			passwordSalt: 'string',
			hashIsPlaintext: false
		});
	});

	it('is idempotent for a re-create with the same quota', async () => {
		await ensureTenant(database(), quotaBody('acme', 1000), now);
		const again = await ensureTenant(database(), quotaBody('acme', 1000), now);

		expect(again.id).toBe('acme');
	});

	it('refuses a re-create that changes the quota', async () => {
		await ensureTenant(database(), quotaBody('acme', 1000), now);

		await expect(
			ensureTenant(database(), quotaBody('acme', 2000), now)
		).rejects.toThrow(TenantAlreadyExistsError);
	});

	it('rejects a conflicting re-create of a crash residue without writing a usage row', async () => {
		// Crash residue: the tenant row exists (private) with no usage row.
		await database()
			.insert(d1Schema.tenant)
			.values({
				id: 'acme',
				status: 'active',
				readMode: 'private',
				ownerIssuer: 'https://idp.test',
				ownerSubject: 'owner',
				ownerAudience: 'aud',
				configVersion: 1,
				createdAt: now
			})
			.run();

		// A conflicting re-create (public) is rejected without writing a usage row, so
		// it cannot poison a later legitimate retry with a wrong-quota row.
		await expect(
			ensureTenant(database(), createBody('acme', 'public'), now)
		).rejects.toThrow(TenantAlreadyExistsError);
		const poisoned = await usageRow('acme');

		await ensureTenant(database(), createBody('acme', 'private'), now);
		const recovered = await usageRow('acme');

		expect({
			poisoned: poisoned !== undefined,
			recovered: recovered !== undefined
		}).toStrictEqual({ poisoned: false, recovered: true });
	});

	it('creates the usage row on a retry after a crash left only the tenant row', async () => {
		const body = quotaBody('acme', 1000);

		// The residue of a crash between the tenant insert and the usage insert: the
		// tenant row exists with no usage row.
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

		// The retry succeeds idempotently and creates the missing usage row, so quota
		// accounting is not silently absent.
		expect({ id: summary.id, quotaBytes: usage?.quotaBytes }).toStrictEqual({
			id: 'acme',
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
			await provision(createBody('acme'));

			const summary = await setTenantStatus(database(), 'acme', status);
			const stored = await database()
				.select({ status: d1Schema.tenant.status })
				.from(d1Schema.tenant)
				.where(eq(d1Schema.tenant.id, 'acme'))
				.get();

			expect({
				returned: summary.status,
				stored: stored?.status
			}).toStrictEqual({ returned: status, stored: status });
		}
	);

	it('throws not found when mutating an unknown tenant', async () => {
		await expect(
			setTenantStatus(database(), 'ghost', 'suspended')
		).rejects.toThrow(TenantNotFoundError);
	});

	it('treats a repeated offboard as terminal while refusing other status moves', async () => {
		await provision(createBody('acme'));
		await setTenantStatus(database(), 'acme', 'offboarding');
		await finaliseOffboardedTenant(database(), 'acme');

		// A repeated delete after finalisation must not flip the tombstone back to
		// offboarding.
		const repeated = await setTenantStatus(database(), 'acme', 'offboarding');

		await expect(
			setTenantStatus(database(), 'acme', 'suspended')
		).rejects.toThrow(TenantRetiredError);

		const stored = await database()
			.select({ status: d1Schema.tenant.status })
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, 'acme'))
			.get();

		expect({
			repeatedStatus: repeated.status,
			storedStatus: stored?.status
		}).toStrictEqual({
			repeatedStatus: 'offboarded',
			storedStatus: 'offboarded'
		});
	});

	it('refuses to re-provision a slug that has begun offboarding', async () => {
		await provision(createBody('acme', 'private'));
		await setTenantStatus(database(), 'acme', 'offboarding');

		await expect(
			ensureTenant(database(), createBody('acme', 'private'), now)
		).rejects.toThrow(TenantAlreadyExistsError);
	});

	it('finalises a drained tenant into a scrubbed tombstone that re-provisioning refuses', async () => {
		await provision(
			createBody('acme', 'private')
			// A private cache, so the row carries a read verifier to scrub.
		);
		await database()
			.update(d1Schema.tenant)
			.set({ readUser: 'reader', readPasswordHash: 'hash' })
			.where(eq(d1Schema.tenant.id, 'acme'))
			.run();
		await setTenantStatus(database(), 'acme', 'offboarding');

		await finaliseOffboardedTenant(database(), 'acme');

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
			.where(eq(d1Schema.tenant.id, 'acme'))
			.get();
		// A cleared credential reads back as undefined and the owner identity as empty,
		// so the scrub is asserted without a null literal.
		const row = {
			status: stored?.status,
			readUser: stored?.readUser ?? undefined,
			readPasswordHash: stored?.readPasswordHash ?? undefined,
			ownerIssuer: stored?.ownerIssuer,
			ownerSubject: stored?.ownerSubject,
			ownerAudience: stored?.ownerAudience
		};
		const reProvision = await ensureTenant(
			database(),
			createBody('acme', 'private'),
			now
		).then(
			() => 'accepted',
			(error: unknown) =>
				error instanceof TenantAlreadyExistsError ? 'refused' : 'other'
		);

		expect({
			row,
			usage: await usageRow('acme'),
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
