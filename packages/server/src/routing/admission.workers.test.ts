import {
	cacheNameSchema,
	type CacheScope,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import {
	type TenantCreateBody,
	tenantCreateBodySchema,
	type TenantReadCredential,
	tenantReadCredentialSchema
} from '@cupboard/protocol/tenants';
import { readUserSchema } from '@cupboard/shared/http';
import {
	createExecutionContext,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { controlTenantCreate } from '../control/control-plane.ts';
import {
	admitTenant,
	refreshTenantMembership,
	type TenantEntry,
	tenantMemberKey
} from '../control/tenant-membership.ts';
import {
	ensureTenant,
	setCacheReadCredential,
	setTenantStatus
} from '../control/tenant-registry.ts';
import { cacheIdentityColumns, cacheIdentityCondition } from '../db/cache.ts';
import { secondCacheGeneration } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { TenantAdmissionUnavailableError } from '../errors.ts';
import { serverErrorHandler } from '../http/error-response.ts';
import {
	isReadPasswordMatching,
	readPasswordHashSchema,
	readPasswordSaltSchema
} from '../read/read-auth.ts';
import {
	adminGrants,
	defaultCache,
	flakyD1,
	issueTokenForTenant,
	provisionNamedTenant,
	testServerFor
} from '../test-support.ts';

import worker from './handler.ts';

const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
const cachePassword = 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23';
const cacheCredential: TenantReadCredential = tenantReadCredentialSchema.parse({
	user: 'reader',
	password: cachePassword
});

async function admitWithFaults(
	slug: string,
	failures: number
): Promise<TenantEntry | undefined> {
	const ctx = createExecutionContext();
	const faultyEnv = {
		...env,
		CUPBOARD_DB: flakyD1(env.CUPBOARD_DB, { failures })
	};
	const entry = await admitTenant(faultyEnv, ctx, tenantIdSchema.parse(slug), {
		kind: 'default'
	});
	await waitOnExecutionContext(ctx);

	return entry?.entry;
}

function database(): ReturnType<typeof drizzleD1<typeof d1Schema>> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
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

async function admit(slug: string): Promise<TenantEntry | undefined> {
	const ctx = createExecutionContext();
	const entry = await admitTenant(env, ctx, tenantIdSchema.parse(slug), {
		kind: 'default'
	});
	await waitOnExecutionContext(ctx);

	return entry?.entry;
}

async function primeRowCache(slug: string): Promise<void> {
	const ctx = createExecutionContext();
	await worker.fetch(
		new Request(`https://cache.example/t/${slug}/prime`),
		env,
		ctx
	);
	await waitOnExecutionContext(ctx);
}

describe('layered admission gate', () => {
	it('rejects a slug that was never provisioned', async () => {
		expect(await admit('ghost')).toBeUndefined();
	});

	it('admits a provisioned tenant after the filter is rebuilt and returns its row state', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);

		expect(await admit('acme')).toStrictEqual({
			status: 'active'
		});
	});

	it('reports how many live tenants the rebuilt manifest contains, excluding offboarded', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await ensureTenant(database(), createBody('beta'), now);
		await database()
			.update(d1Schema.tenant)
			.set({ status: 'offboarded' })
			.where(eq(d1Schema.tenant.id, tenantIdSchema.parse('beta')))
			.run();

		expect(await refreshTenantMembership(env)).toBe(1);
	});

	it('passes a suspended tenant to the caller with its status', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);
		await setTenantStatus(
			database(),
			tenantIdSchema.parse('acme'),
			'suspended'
		);

		expect(await admit('acme')).toStrictEqual({
			status: 'suspended'
		});
	});

	it('rejects a filter-positive slug whose membership marker is gone without reading the row', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);
		await env.TENANT_CACHE.delete(
			tenantMemberKey(tenantIdSchema.parse('acme'))
		);

		expect(await admit('acme')).toBeUndefined();
	});

	it('admits a tenant created through the control plane without waiting on the cron', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);
		const seeded = await admit('acme');

		await controlTenantCreate(env, createBody('beta'), 'https://cupboard.test');
		const created = await admit('beta');

		expect({ seeded, created }).toStrictEqual({
			seeded: { status: 'active' },
			created: { status: 'active' }
		});
	});

	it('fails the create when the filter cannot be published, leaving the tenant recoverable', async () => {
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
		await env.TENANT_CACHE.delete(
			tenantMemberKey(tenantIdSchema.parse('acme'))
		);
		const dropped = await admit('acme');

		await refreshTenantMembership(env);
		const healed = await admit('acme');

		expect({ dropped, healed }).toStrictEqual({
			dropped: undefined,
			healed: { status: 'active' }
		});
	});

	it('rejects an offboarded tenant at the row read before the filter drops it', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);
		// Leave the stale filter and marker in place so admission must reject the
		// authoritative offboarded row.
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
			status: 'active'
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

	// The dispatch write gate reconfirms the status against D1 only when admission
	// served the entry from the row cache, so a suspend stays timely within the
	// cache TTL. A public tenant is cached, so priming the cache with a read drives
	// a later write through the gate query; these confine the faults to that query
	// so admission itself stays healthy.
	const statusGateQuery = 'select "status" from "tenant"';

	// A public slug distinct from the private `acme` the other cases use, so priming
	// its entry into the shared row cache never leaks a cached status onto them.
	const gateSlug = 'gate-public';

	async function writeWithGateFaults(
		failures: number,
		slug: string
	): Promise<Response> {
		const ctx = createExecutionContext();
		const faultyEnv = {
			...env,
			CUPBOARD_DB: flakyD1(env.CUPBOARD_DB, {
				failures,
				matches: (query) => query.startsWith(statusGateQuery)
			})
		};
		const response = await worker.fetch(
			new Request(`https://cache.example/t/${slug}/gate-probe`, {
				method: 'POST'
			}),
			faultyEnv,
			ctx
		);
		await waitOnExecutionContext(ctx);

		return response;
	}

	it('retries a transient fault on the write gate status read', async () => {
		await ensureTenant(database(), createBody(gateSlug, 'public'), now);
		await refreshTenantMembership(env);
		await primeRowCache(gateSlug);

		const response = await writeWithGateFaults(1, gateSlug);

		expect(response.headers.get('retry-after')).toBeNull();
	});

	it('uses the fresh admission row instead of a second write-gate read', async () => {
		await ensureTenant(database(), createBody(gateSlug, 'public'), now);
		await refreshTenantMembership(env);
		await primeRowCache(gateSlug);

		const response = await writeWithGateFaults(
			Number.MAX_SAFE_INTEGER,
			gateSlug
		);

		expect(response.headers.get('retry-after')).toBeNull();
	});

	it('trusts a fresh admission status, sparing the write gate read', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);

		// Private rows are never cached, so admission has already read this status
		// from D1 and the write gate does not repeat the query.
		const response = await writeWithGateFaults(Number.MAX_SAFE_INTEGER, 'acme');

		expect(response.headers.get('retry-after')).toBeNull();
	});

	it('reconfirms a cached status so a suspend still stops a write', async () => {
		await ensureTenant(database(), createBody(gateSlug, 'public'), now);
		await refreshTenantMembership(env);
		await primeRowCache(gateSlug);
		await setTenantStatus(
			database(),
			tenantIdSchema.parse(gateSlug),
			'suspended'
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request(`https://cache.example/t/${gateSlug}/gate-probe`, {
				method: 'POST'
			}),
			env,
			ctx
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(StatusCodes.FORBIDDEN);
	});

	it('keeps upload preview outside write admission while preserving the write gate', async () => {
		const slug = 'preview-public';

		await provisionNamedTenant(slug);
		await primeRowCache(slug);
		await setTenantStatus(database(), tenantIdSchema.parse(slug), 'suspended');

		const request = async (
			path: string,
			method = 'POST'
		): Promise<Response> => {
			const ctx = createExecutionContext();

			try {
				return await worker.fetch(
					new Request(`https://cache.example/t/${slug}${path}`, {
						body: '{}',
						headers: { 'content-type': 'application/json' },
						method
					}),
					env,
					ctx
				);
			} finally {
				await waitOnExecutionContext(ctx);
			}
		};

		const [preview, negotiate, previewPut, previewChild] = await Promise.all([
			request('/uploads/preview'),
			request('/uploads'),
			request('/uploads/preview', 'PUT'),
			request('/uploads/preview/child')
		]);

		expect({
			preview: preview.status,
			negotiate: negotiate.status,
			previewPut: previewPut.status,
			previewChild: previewChild.status
		}).toStrictEqual({
			preview: StatusCodes.NOT_FOUND,
			negotiate: StatusCodes.FORBIDDEN,
			previewPut: StatusCodes.FORBIDDEN,
			previewChild: StatusCodes.FORBIDDEN
		});
	});

	it.each([
		{ status: 'suspended' as const },
		{ status: 'offboarding' as const }
	])(
		'stops authenticated upload preview for a fresh $status tenant',
		async ({ status }) => {
			const slug = `preview-${status}`;
			const issuer = await provisionNamedTenant(slug, {
				defaultCacheAccess: 'private'
			});
			const token = await issueTokenForTenant(
				testServerFor(slug),
				issuer,
				adminGrants()
			);

			await setTenantStatus(database(), tenantIdSchema.parse(slug), status);

			const ctx = createExecutionContext();
			const response = await worker.fetch(
				new Request(`https://cache.example/t/${slug}/uploads/preview`, {
					body: JSON.stringify({ paths: [] }),
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json'
					},
					method: 'POST'
				}),
				env,
				ctx
			);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(StatusCodes.NOT_FOUND);
		}
	);

	it('returns the admission refusal as a 503 with Retry-After', async () => {
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

	it('reflects a tenant read credential change with no row caching', async () => {
		await ensureTenant(database(), createBody('acme'), now);
		await refreshTenantMembership(env);

		const before = await admit('acme');
		await database()
			.update(d1Schema.tenant)
			.set({
				readUser: readUserSchema.parse('reader'),
				readPasswordHash: readPasswordHashSchema.parse('0'.repeat(64)),
				readPasswordSalt: readPasswordSaltSchema.parse('salt')
			})
			.where(eq(d1Schema.tenant.id, tenantIdSchema.parse('acme')))
			.run();
		const after = await admit('acme');

		expect({ before, after }).toStrictEqual({
			before: { status: 'active' },
			after: {
				status: 'active',
				readVerifier: {
					user: 'reader',
					passwordHash: '0'.repeat(64),
					passwordSalt: 'salt'
				}
			}
		});
	});
});

// Counts the D1 batches a call issues, so a test can show that admission reads
// the tenant row, the cache verifier and the cache lifecycle in one round trip.
function countingD1(inner: D1Database, batches: number[]): D1Database {
	return {
		prepare: (query) => inner.prepare(query),
		batch: (statements) => {
			batches.push(statements.length);

			return inner.batch(statements);
		},
		exec: (query) => inner.exec(query),
		withSession: (constraint) => inner.withSession(constraint),
		dump: () => Promise.reject(new Error('dump is not supported here'))
	};
}

interface CacheAdmission {
	readonly entry: TenantEntry | undefined;
	readonly cacheUser: string | undefined;
	readonly cacheAcceptsPassword: boolean;
	readonly cache:
		| { readonly access: 'public' | 'private'; readonly isDeleted: boolean }
		| undefined;
	readonly batches: number[];
}

async function admitCache(
	slug: string,
	cache: CacheScope = defaultCache()
): Promise<CacheAdmission> {
	const batches: number[] = [];
	const countedEnv = {
		...env,
		CUPBOARD_DB: countingD1(env.CUPBOARD_DB, batches)
	};
	const ctx = createExecutionContext();
	const admission = await admitTenant(
		countedEnv,
		ctx,
		tenantIdSchema.parse(slug),
		cache
	);
	await waitOnExecutionContext(ctx);
	const verifier = admission?.cacheVerifier;

	return {
		entry: admission?.entry,
		cacheUser: verifier?.user,
		cache: admission?.cache,
		cacheAcceptsPassword:
			verifier !== undefined &&
			(await isReadPasswordMatching(
				cachePassword,
				verifier.passwordHash,
				verifier.passwordSalt
			)),
		batches
	};
}

describe('cache admission', () => {
	const builds: CacheScope = {
		kind: 'named',
		name: cacheNameSchema.parse('builds')
	};
	const guides: CacheScope = {
		kind: 'named',
		name: cacheNameSchema.parse('guides')
	};

	async function insertLiveCache(cache: CacheScope): Promise<void> {
		await database()
			.insert(d1Schema.cacheLifecycle)
			.values({
				tenant: tenantIdSchema.parse('acme'),
				...cacheIdentityColumns(cache),
				access: 'private',
				generation: secondCacheGeneration,
				updatedAt: now
			})
			.run();
	}

	it("returns the selected cache's verifier from one batch", async () => {
		await ensureTenant(database(), createBody('acme', 'public'), now);
		await insertLiveCache(builds);
		await setCacheReadCredential(
			database(),
			tenantIdSchema.parse('acme'),
			builds,
			cacheCredential,
			now
		);
		await refreshTenantMembership(env);

		expect(await admitCache('acme', builds)).toStrictEqual({
			entry: { status: 'active' },
			cacheUser: 'reader',
			cacheAcceptsPassword: true,
			cache: { access: 'private', isDeleted: false },
			batches: [3]
		});
	});

	it('admits the tenant without a cache verifier when the selected cache has none', async () => {
		await ensureTenant(database(), createBody('acme', 'public'), now);
		await refreshTenantMembership(env);

		expect(await admitCache('acme', builds)).toStrictEqual({
			entry: { status: 'active' },
			cacheUser: undefined,
			cacheAcceptsPassword: false,
			cache: undefined,
			batches: [3]
		});
	});

	it("does not return a sibling cache's verifier", async () => {
		await ensureTenant(database(), createBody('acme', 'public'), now);
		await insertLiveCache(guides);
		await setCacheReadCredential(
			database(),
			tenantIdSchema.parse('acme'),
			guides,
			cacheCredential,
			now
		);
		await refreshTenantMembership(env);

		expect(await admitCache('acme', builds)).toStrictEqual({
			entry: { status: 'active' },
			cacheUser: undefined,
			cacheAcceptsPassword: false,
			cache: undefined,
			batches: [3]
		});
	});

	it('reads only the tenant row when no private cache is named', async () => {
		await ensureTenant(database(), createBody('acme', 'public'), now);
		await insertLiveCache(builds);
		await setCacheReadCredential(
			database(),
			tenantIdSchema.parse('acme'),
			builds,
			cacheCredential,
			now
		);
		await refreshTenantMembership(env);

		expect(await admitCache('acme')).toStrictEqual({
			entry: { status: 'active' },
			cacheUser: undefined,
			cacheAcceptsPassword: false,
			cache: { access: 'public', isDeleted: false },
			batches: [3]
		});
	});

	it('reports a deleted cache without retaining its verifier', async () => {
		const tenant = tenantIdSchema.parse('acme');

		await ensureTenant(database(), createBody('acme', 'public'), now);
		await insertLiveCache(builds);
		await setCacheReadCredential(
			database(),
			tenant,
			builds,
			cacheCredential,
			now
		);
		await refreshTenantMembership(env);
		await database()
			.update(d1Schema.cacheLifecycle)
			.set({ deletedAt: now, updatedAt: now })
			.where(
				and(
					eq(d1Schema.cacheLifecycle.tenant, tenant),
					cacheIdentityCondition(
						d1Schema.cacheLifecycle.cacheKind,
						d1Schema.cacheLifecycle.cacheName,
						builds
					)
				)
			)
			.run();

		expect(await admitCache('acme', builds)).toStrictEqual({
			entry: { status: 'active' },
			cacheUser: undefined,
			cacheAcceptsPassword: false,
			cache: { access: 'private', isDeleted: true },
			batches: [3]
		});
	});

	it('refuses an offboarded tenant for a private cache', async () => {
		await ensureTenant(database(), createBody('acme', 'public'), now);
		await insertLiveCache(builds);
		await setCacheReadCredential(
			database(),
			tenantIdSchema.parse('acme'),
			builds,
			cacheCredential,
			now
		);
		await refreshTenantMembership(env);
		await database()
			.update(d1Schema.tenant)
			.set({ status: 'offboarded' })
			.where(eq(d1Schema.tenant.id, tenantIdSchema.parse('acme')))
			.run();

		expect(await admitCache('acme', builds)).toStrictEqual({
			entry: undefined,
			cacheUser: undefined,
			cacheAcceptsPassword: false,
			cache: undefined,
			batches: [3]
		});
	});
});
