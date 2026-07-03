import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	type ParsedTenantCreateBody,
	tenantCreateBodySchema
} from '@cupboard/protocol/tenants';
import {
	createExecutionContext,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { controlTenantCreate } from '../control/control-plane.ts';
import {
	admitTenant,
	refreshTenantMembership,
	type TenantEntry,
	tenantMemberKey
} from '../control/tenant-membership.ts';
import { ensureTenant, setTenantStatus } from '../control/tenant-registry.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { TenantAdmissionUnavailableError } from '../errors.ts';
import { serverErrorHandler } from '../http/error-response.ts';
import { flakyD1 } from '../test-support.ts';

import worker from './handler.ts';

const now = '2026-01-01T00:00:00.000Z';

async function admitWithFaults(
	slug: string,
	failures: number
): Promise<TenantEntry | undefined> {
	const ctx = createExecutionContext();
	const faultyEnv = {
		...env,
		CUPBOARD_DB: flakyD1(env.CUPBOARD_DB, { failures })
	};
	const entry = await admitTenant(faultyEnv, ctx, tenantIdSchema.parse(slug));
	await waitOnExecutionContext(ctx);

	return entry;
}

function database(): ReturnType<typeof drizzleD1<typeof d1Schema>> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

function createBody(id: string): ParsedTenantCreateBody {
	return tenantCreateBodySchema.parse({
		id,
		readMode: 'private',
		ownerIssuer: 'https://idp.test',
		ownerSubject: 'owner',
		ownerAudience: 'aud'
	});
}

async function admit(slug: string): Promise<TenantEntry | undefined> {
	const ctx = createExecutionContext();
	const entry = await admitTenant(env, ctx, tenantIdSchema.parse(slug));
	await waitOnExecutionContext(ctx);

	return entry;
}

describe('layered admission gate', () => {
	it('rejects a slug that was never provisioned', async () => {
		expect(await admit('ghost')).toBeUndefined();
	});

	it('admits a provisioned tenant once the filter is rebuilt, carrying its row state', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);

		expect(await admit('acme')).toStrictEqual({
			status: 'active',
			readMode: 'private'
		});
	});

	it('reports how many live tenants the rebuild now carries, excluding offboarded', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await ensureTenant(database(), createBody('beta'), now);
		await database()
			.update(d1Schema.tenant)
			.set({ status: 'offboarded' })
			.where(eq(d1Schema.tenant.id, tenantIdSchema.parse('beta')))
			.run();

		expect(await refreshTenantMembership(env)).toBe(1);
	});

	it('keeps a suspended tenant admittable, carrying its status for the caller to gate', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);
		await setTenantStatus(
			database(),
			tenantIdSchema.parse('acme'),
			'suspended'
		);

		expect(await admit('acme')).toStrictEqual({
			status: 'suspended',
			readMode: 'private'
		});
	});

	it('rejects a filter-positive slug whose membership marker is gone without reading the row', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);
		// The filter still reports the slug, but its marker is gone (a tier-2 miss).
		await env.TENANT_CACHE.delete(tenantMemberKey('acme'));

		expect(await admit('acme')).toBeUndefined();
	});

	it('admits a tenant created through the control plane without waiting on the cron', async () => {
		// An existing filter that predates the new tenant, cached by a read.
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);
		const seeded = await admit('acme');

		// Creating another tenant through the control path rebuilds the filter, so it
		// is admittable at once rather than only after the hourly cron rebuild.
		await controlTenantCreate(env, createBody('beta'), 'https://cupboard.test');
		const created = await admit('beta');

		expect({ seeded, created }).toStrictEqual({
			seeded: { status: 'active', readMode: 'private' },
			created: { status: 'active', readMode: 'private' }
		});
	});

	it('fails the create when the filter cannot be published, leaving the tenant recoverable', async () => {
		// A populated filter that excludes the tenant about to be created.
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);

		let outcome: 'created' | 'failed';
		try {
			await controlTenantCreate(
				env,
				createBody('beta'),
				'https://cupboard.test',
				() => Promise.reject(new Error('filter publish failed'))
			);
			outcome = 'created';
		} catch {
			outcome = 'failed';
		}

		// The create reports failure rather than success-but-inadmissible: the stale
		// filter still excludes beta, so it 404s until the cron rebuild includes it
		// (the row and marker persisted, so recovery needs no re-create).
		const beforeRecovery = await admit('beta');
		await refreshTenantMembership(env);
		const afterRecovery = await admit('beta');

		expect({
			outcome,
			beforeRecovery: beforeRecovery !== undefined,
			afterRecovery: afterRecovery !== undefined
		}).toStrictEqual({
			outcome: 'failed',
			beforeRecovery: false,
			afterRecovery: true
		});
	});

	it('re-asserts a dropped membership marker on the next refresh', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);
		// A create-write that was dropped: the marker is gone though the tenant is
		// live, so admission 404s until the cron reasserts it.
		await env.TENANT_CACHE.delete(tenantMemberKey('acme'));
		const dropped = await admit('acme');

		await refreshTenantMembership(env);
		const healed = await admit('acme');

		expect({ dropped, healed }).toStrictEqual({
			dropped: undefined,
			healed: { status: 'active', readMode: 'private' }
		});
	});

	it('rejects an offboarded tenant at the row read before the filter drops it', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);
		// The tenant is retired in D1 but the filter and marker still carry it (no
		// rebuild yet), so admission reaches the authoritative row: a retired
		// tombstone must read as a clean 404, indistinguishable from never-existed.
		await database()
			.update(d1Schema.tenant)
			.set({ status: 'offboarded' })
			.where(eq(d1Schema.tenant.id, tenantIdSchema.parse('acme')))
			.run();

		expect(await admit('acme')).toBeUndefined();
	});

	it('drops an offboarded tenant on the next filter rebuild', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);
		await database()
			.update(d1Schema.tenant)
			.set({ status: 'offboarded' })
			.where(eq(d1Schema.tenant.id, tenantIdSchema.parse('acme')))
			.run();
		await refreshTenantMembership(env);

		expect(await admit('acme')).toBeUndefined();
	});

	it('retries a transient fault on the admission row read', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);

		expect(await admitWithFaults('acme', 1)).toStrictEqual({
			status: 'active',
			readMode: 'private'
		});
	});

	it('maps a persistent admission read fault to a retryable refusal', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);

		let caught: unknown;

		try {
			await admitWithFaults('acme', Number.MAX_SAFE_INTEGER);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(TenantAdmissionUnavailableError);

		if (!(caught instanceof TenantAdmissionUnavailableError)) {
			return;
		}

		expect({
			status: caught.status,
			retryAfterSeconds: caught.retryAfterSeconds
		}).toStrictEqual({ status: 503, retryAfterSeconds: 5 });
	});

	// The dispatch write gate's status read shares the admission read's exposure:
	// it sits on every tenant write. These drive it through the real Worker, with
	// the faults confined to the gate's own query so admission itself stays
	// healthy.
	const statusGateQuery = 'select "status" from "tenant"';

	async function writeWithGateFaults(failures: number): Promise<Response> {
		const ctx = createExecutionContext();
		const faultyEnv = {
			...env,
			CUPBOARD_DB: flakyD1(env.CUPBOARD_DB, {
				failures,
				matches: (query) => query.startsWith(statusGateQuery)
			})
		};
		const response = await worker.fetch(
			new Request('https://cache.example/t/acme/gate-probe', {
				method: 'POST'
			}),
			faultyEnv,
			ctx
		);
		await waitOnExecutionContext(ctx);

		return response;
	}

	it('retries a transient fault on the write gate status read', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);

		const response = await writeWithGateFaults(1);

		// Past the gate, the unconfigured tenant object answers however it will;
		// what matters is the gate did not surface its blip as a retryable refusal.
		expect(response.headers.get('retry-after')).toBeNull();
	});

	it('maps a persistent write gate fault to a retryable refusal', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);

		const response = await writeWithGateFaults(Number.MAX_SAFE_INTEGER);

		expect({
			status: response.status,
			retryAfter: response.headers.get('retry-after')
		}).toStrictEqual({ status: 503, retryAfter: '5' });
	});

	it('answers the admission refusal as a 503 with Retry-After', async () => {
		const app = new Hono();

		app.onError(serverErrorHandler);
		app.get('/probe', () => {
			throw new TenantAdmissionUnavailableError(new Error('down'));
		});

		const response = await app.request('/probe');

		expect({
			status: response.status,
			retryAfter: response.headers.get('retry-after')
		}).toStrictEqual({ status: 503, retryAfter: '5' });
	});

	it('reflects a private tenant credential change with no row caching', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);

		const before = await admit('acme');
		await database()
			.update(d1Schema.tenant)
			.set({
				readUser: 'reader',
				readPasswordHash: 'hash',
				readPasswordSalt: 'salt'
			})
			.where(eq(d1Schema.tenant.id, tenantIdSchema.parse('acme')))
			.run();
		const after = await admit('acme');

		expect({ before, after }).toStrictEqual({
			before: { status: 'active', readMode: 'private' },
			after: {
				status: 'active',
				readMode: 'private',
				readVerifier: {
					user: 'reader',
					passwordHash: 'hash',
					passwordSalt: 'salt'
				}
			}
		});
	});
});
