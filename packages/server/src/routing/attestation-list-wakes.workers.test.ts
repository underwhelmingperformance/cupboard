import { rootLogger } from '@cupboard/logger';
import { type TenantId, tenantIdSchema } from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env as tenantEnv } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import * as localSchema from '../db/schema.ts';
import { boundedD1 } from '../do/bounded-io.ts';
import { withSubrequestSlice } from '../do/subrequest-slice.ts';
import {
	provisionNamedTenant,
	resetTestServer,
	testControlEnv,
	withoutAlarmArming
} from '../test-support.ts';

import {
	attestationListWakeCursorKey,
	wakePendingAttestationLists
} from './attestation-list-wakes.ts';
import { tenantServer } from './durable-object.ts';

const env = Object.assign({}, tenantEnv, testControlEnv);

async function seed(tenant: string, count = 1) {
	await provisionNamedTenant(tenant);
	await env.CUPBOARD_DB.prepare(
		`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < ?)
 INSERT INTO attestation_list_revision (tenant, cache_kind, store_path_hash, generation, updated_at)
 SELECT ?, 'default', '00000000000000000000000000000000', n, '2026-10-12T00:00:00.000Z' FROM rows`
	)
		.bind(count, tenant)
		.run();
}

async function activate() {
	await env.CUPBOARD_DB.prepare(
		"INSERT INTO deployment_transition (id, state, updated_at) VALUES ('attestation-list-revision', 'complete', '2026-10-12T00:00:00.000Z')"
	).run();
}

describe('pending attestation list wake discovery', () => {
	beforeEach(async () => {
		await resetTestServer();
		await env.CRON_STATE.delete(attestationListWakeCursorKey);
	});

	it('does not start generation before the transition completes', async () => {
		await seed('acme');
		const wakes: TenantId[] = [];
		await wakePendingAttestationLists(rootLogger(), env, (tenant) => {
			wakes.push(tenant);
			return Promise.resolve();
		});
		expect(wakes).toStrictEqual([]);
	});

	it('bounds each tenant jump even when one tenant has 25,000 pending revisions', async () => {
		await seed('acme', 25_000);
		await seed('beta');
		await activate();
		const reads: number[] = [];
		const statement = (
			inner: D1PreparedStatement,
			query: string
		): D1PreparedStatement =>
			new Proxy(inner, {
				get(target, property) {
					if (property === 'bind') {
						return (...values: unknown[]) =>
							statement(target.bind(...values), query);
					}
					if (property === 'all') {
						return async () => {
							const response = await target.all();
							if (
								query.includes(
									'INDEXED BY attestation_list_revision_pending_idx'
								)
							) {
								reads.push(response.meta.rows_read);
							}
							return response;
						};
					}
					const value: unknown = Reflect.get(target, property, target);
					if (typeof value !== 'function') {
						return value;
					}
					return (...values: unknown[]): unknown =>
						Reflect.apply(value, target, values);
				}
			});
		const binding = new Proxy(env.CUPBOARD_DB, {
			get(target, property) {
				if (property === 'prepare') {
					return (query: string) => statement(target.prepare(query), query);
				}
				const value: unknown = Reflect.get(target, property, target);
				if (typeof value !== 'function') {
					return value;
				}
				return (...values: unknown[]): unknown =>
					Reflect.apply(value, target, values);
			}
		});
		const wakes: TenantId[] = [];
		await withSubrequestSlice(
			() =>
				wakePendingAttestationLists(
					rootLogger(),
					{ ...env, CUPBOARD_DB: boundedD1(binding) },
					(tenant) => {
						wakes.push(tenant);
						return Promise.resolve();
					}
				),
			{ subrequests: 50, reserve: 8 }
		);
		expect(wakes).toStrictEqual([
			tenantIdSchema.parse('acme'),
			tenantIdSchema.parse('beta')
		]);
		expect({
			lookups: reads.length,
			largestRead: Math.max(...reads)
		}).toStrictEqual({ lookups: 3, largestRead: 1 });
	});

	it('continues to other tenants after a wake fails', async () => {
		await seed('acme');
		await seed('beta');
		await activate();
		const wakes: TenantId[] = [];
		const wake = (tenant: TenantId): Promise<void> => {
			wakes.push(tenant);
			if (tenant === tenantIdSchema.parse('acme')) {
				throw new Error('Wake failed');
			}
			return Promise.resolve();
		};
		await expect(
			wakePendingAttestationLists(rootLogger(), env, wake)
		).rejects.toBeInstanceOf(AggregateError);
		expect(wakes).toStrictEqual([
			tenantIdSchema.parse('acme'),
			tenantIdSchema.parse('beta')
		]);
	});
	it('continues an eight-tenant page and wraps after the final tenant', async () => {
		const tenants = Array.from({ length: 10 }, (_, index) =>
			tenantIdSchema.parse(`tenant${String(index).padStart(2, '0')}`)
		);
		for (const tenant of tenants) {
			await seed(tenant);
		}
		await activate();
		const first: TenantId[] = [];
		await wakePendingAttestationLists(rootLogger(), env, (tenant) => {
			first.push(tenant);
			return Promise.resolve();
		});
		const position = await env.CRON_STATE.get(attestationListWakeCursorKey);
		const second: TenantId[] = [];
		await wakePendingAttestationLists(rootLogger(), env, (tenant) => {
			second.push(tenant);
			return Promise.resolve();
		});
		expect({
			first,
			second,
			position,
			end: await env.CRON_STATE.get(attestationListWakeCursorKey)
		}).toStrictEqual({
			first: tenants.slice(0, 8),
			second: tenants.slice(8),
			position: 'tenant07',
			end: ''
		});
	});

	it('skips pending rows for offboarding tenants', async () => {
		await seed('acme');
		await seed('beta');
		await env.CUPBOARD_DB.prepare(
			"UPDATE tenant SET status = 'offboarding' WHERE id = ?"
		)
			.bind('acme')
			.run();
		await activate();
		const wakes: TenantId[] = [];
		await wakePendingAttestationLists(rootLogger(), env, (tenant) => {
			wakes.push(tenant);
			return Promise.resolve();
		});
		expect(wakes).toStrictEqual([tenantIdSchema.parse('beta')]);
	});
	it('persists a tenant wake through the real namespace RPC when the writer omitted its hint', async () => {
		await seed('acme');
		await activate();
		const stub = tenantServer(env, tenantIdSchema.parse('acme'));
		await withoutAlarmArming(async () => {
			const before = await runInDurableObject(stub, (instance) =>
				instance.context.db
					.select()
					.from(localSchema.attestationListRefreshWake)
					.get()
			);
			await wakePendingAttestationLists(rootLogger(), env);
			const after = await runInDurableObject(stub, (instance) =>
				instance.context.db
					.select()
					.from(localSchema.attestationListRefreshWake)
					.get()
			);
			expect({
				initiallyAbsent: before === undefined,
				tokenPresent: typeof after?.token === 'string'
			}).toStrictEqual({ initiallyAbsent: true, tokenPresent: true });
		}, stub);
	});
});
