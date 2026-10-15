import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import {
	currentListingGeneratorRevision,
	listingGeneratorRevisionSchema
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { SharedListingGenerationClaimResult } from '../blob/shared-listing-generation.ts';
import type {
	SharedListingTaskClaim,
	SharedListingTaskClaimResult
} from '../blob/shared-listing-tasks.ts';

import * as schema from './d1-schema.ts';
import { ListingGenerationStore } from './listing-generation.ts';
import { SharedListingGenerationStore } from './shared-listing-generation.ts';
import { SharedListingJobStore } from './shared-listing-jobs.ts';
import { SharedListingTaskStore } from './shared-listing-tasks.ts';
import { sharedNarDiscoveryFixture } from './shared-nar-discovery.test-support.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const later = isoTimestamp(new Date('2026-01-01T00:00:30.000Z'));
const deadline = isoTimestamp(new Date('2026-01-01T00:01:00.000Z'));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const otherOwner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000002'
);

function taskClaim(result: SharedListingTaskClaimResult) {
	if (result.kind !== 'claimed') {
		throw new Error(`Expected a task claim, received ${result.kind}`);
	}
	return result.claim;
}
function generationClaim(result: SharedListingGenerationClaimResult) {
	if (result.kind !== 'claimed') {
		throw new Error(`Expected a generation claim, received ${result.kind}`);
	}
	return result.claim;
}
async function fixture() {
	const { database } = await sharedNarDiscoveryFixture(2);
	await database.insert(schema.deploymentTransition).values({
		id: 'global-listing-generation',
		state: 'expanded',
		updatedAt: now
	});
	const jobs = new SharedListingJobStore(database);
	const tasks = new SharedListingTaskStore(database);
	async function create(revision = currentListingGeneratorRevision) {
		const job = await jobs.start(revision, now);
		const discovery = await jobs.claim(job, owner, now);
		if (discovery.kind !== 'claimed') {
			throw new Error('The global job did not acquire discovery ownership');
		}
		await jobs.discover(discovery.claim);
		const rows = await database
			.select()
			.from(schema.sharedListingTask)
			.where(eq(schema.sharedListingTask.jobId, job.id))
			.orderBy(schema.sharedListingTask.narHash);
		async function claim(index = 0, at = now) {
			const row = rows[index];
			if (row === undefined) {
				throw new Error('The discovered NAR task is missing');
			}
			return taskClaim(
				await tasks.claim(
					{
						job: { id: job.id, generation: job.generation },
						id: row.id,
						owner
					},
					at
				)
			);
		}
		return { job, claim };
	}
	const first = await create();
	const second = await create();
	const tenant = new ListingGenerationStore(database);
	return {
		database,
		jobs,
		tasks,
		first,
		second,
		create,
		tenant,
		store: new SharedListingGenerationStore(database)
	};
}
function tenantRequest(task: SharedListingTaskClaim) {
	return {
		narHash: task.narHash,
		generatorRevision: task.generatorRevision,
		sourceIncarnation: task.sourceIncarnation,
		tenant: tenantIdSchema.parse('discovery-first'),
		owner: otherOwner
	};
}

describe('global and tenant listing computation exclusion', () => {
	it('coalesces global jobs and replays ownership without creating tenant authority', async () => {
		const { database, first, second, store } = await fixture();
		const task = await first.claim();
		const claim = await store.claim(task, now);
		expect({
			claim,
			replay: await new SharedListingGenerationStore(database).claim(
				task,
				later
			),
			otherJob: await store.claim(await second.claim(), later),
			references: await database.select().from(schema.artifactReference),
			presence: await database.select().from(schema.tenantCasBlob),
			tenants: await database
				.select({ id: schema.tenant.id })
				.from(schema.tenant)
				.orderBy(schema.tenant.id)
		}).toStrictEqual({
			claim: {
				kind: 'claimed',
				claim: { task, generation: 1, leaseExpiresAt: deadline }
			},
			replay: claim,
			otherJob: { kind: 'busy', retryAt: deadline },
			references: [],
			presence: [],
			tenants: [{ id: 'discovery-first' }, { id: 'discovery-second' }]
		});
	});

	it.each(['global', 'tenant'] as const)(
		'refuses duplicate computation when %s acquired ownership first',
		async (firstOwner) => {
			const { first, store, tenant } = await fixture();
			const task = await first.claim();
			const acquireGlobal = () => store.claim(task, now);
			const acquireTenant = () => tenant.claim(tenantRequest(task), now);
			const [winner, contender] =
				firstOwner === 'global'
					? [await acquireGlobal(), await acquireTenant()]
					: [await acquireTenant(), await acquireGlobal()];
			expect({ winner: winner.kind, contender }).toStrictEqual({
				winner: 'claimed',
				contender: { kind: 'busy', retryAt: deadline }
			});
		}
	);

	it('admits only one owner in a concurrent global and tenant race', async () => {
		const { first, store, tenant } = await fixture();
		const task = await first.claim();
		const results = await Promise.all([
			store.claim(task, now),
			tenant.claim(tenantRequest(task), now)
		]);
		expect({
			kinds: results.map((result) => result.kind).toSorted(byCodeUnit),
			waits: results.flatMap((result) =>
				result.kind === 'busy' ? [result.retryAt] : []
			)
		}).toStrictEqual({ kinds: ['busy', 'claimed'], waits: [deadline] });
	});

	it('permits independent NARs and generator revisions to run in parallel', async () => {
		const { first, create, store } = await fixture();
		const revision = await create(
			listingGeneratorRevisionSchema.parse('nix-v1-r2')
		);
		const claims = await Promise.all([
			first.claim(),
			first.claim(1),
			revision.claim()
		]);
		expect(
			await Promise.all(claims.map((task) => store.claim(task, now)))
		).toStrictEqual(
			claims.map((task) => ({
				kind: 'claimed',
				claim: { task, generation: 1, leaseExpiresAt: deadline }
			}))
		);
	});

	it('bounds computation ownership by the task lease and fences an expired global owner after tenant takeover', async () => {
		const { first, store, tenant } = await fixture();
		const task = await first.claim();
		const claim = generationClaim(await store.claim(task, later));
		const replacement = await tenant.claim(tenantRequest(task), deadline);
		expect({
			claim,
			replacement,
			renewal: await store.renew(claim, deadline),
			release: await store.release(claim, deadline)
		}).toStrictEqual({
			claim: { task, generation: 1, leaseExpiresAt: deadline },
			replacement: {
				kind: 'claimed',
				claim: {
					...tenantRequest(task),
					generation: 1,
					leaseExpiresAt: isoTimestamp(new Date('2026-01-01T00:02:00.000Z'))
				}
			},
			renewal: undefined,
			release: true
		});
	});

	it('renews monotonically after the task lease extends and fences a released generation', async () => {
		const { first, second, tasks, store } = await fixture();
		const task = await first.claim();
		const claim = generationClaim(await store.claim(task, now));
		await tasks.renew(task, later);
		const extended = isoTimestamp(new Date('2026-01-01T00:01:30.000Z'));
		const renewals = [
			await store.renew(claim, later),
			await store.renew(claim, now)
		];
		const isReleased = await store.release(claim, later);
		const otherTask = await second.claim();
		const replacement = await store.claim(otherTask, later);
		expect({
			renewals,
			released: isReleased,
			replacement,
			staleRelease: await store.release(claim, later)
		}).toStrictEqual({
			renewals: [extended, extended],
			released: true,
			replacement: {
				kind: 'claimed',
				claim: { task: otherTask, generation: 2, leaseExpiresAt: deadline }
			},
			staleRelease: false
		});
	});

	it('recovers an expired tenant computation without permitting its old owner to renew', async () => {
		const { first, store, tenant } = await fixture();
		const source = await first.claim(0, later);
		const old = await tenant.claim(tenantRequest(source), now);
		if (old.kind !== 'claimed') {
			throw new Error('The tenant did not acquire computation ownership');
		}
		expect({
			replacement: await store.claim(source, deadline),
			renewal: await tenant.renew(old.claim, deadline)
		}).toStrictEqual({
			replacement: {
				kind: 'claimed',
				claim: {
					task: source,
					generation: 1,
					leaseExpiresAt: isoTimestamp(new Date('2026-01-01T00:01:30.000Z'))
				}
			},
			renewal: undefined
		});
	});

	it('revokes cancelled computation and permits a replacement task immediately after resume', async () => {
		const { first, tasks, jobs, store } = await fixture();
		const task = await first.claim();
		const old = generationClaim(await store.claim(task, now));
		await jobs.cancel(first.job, now);
		const invalid = {
			claim: await store.claim(task, now),
			renewal: await store.renew(old, now)
		};
		const resumed = await jobs.resume(first.job, now);
		if (resumed === undefined) {
			throw new Error('The cancelled job did not resume');
		}
		const nextTask = taskClaim(
			await tasks.claim(
				{
					job: { id: resumed.id, generation: resumed.generation },
					id: task.id,
					owner: otherOwner
				},
				now
			)
		);
		expect({
			invalid,
			replacement: await store.claim(nextTask, now),
			staleRelease: await store.release(old, now)
		}).toStrictEqual({
			invalid: { claim: { kind: 'unavailable' }, renewal: undefined },
			replacement: {
				kind: 'claimed',
				claim: { task: nextTask, generation: 2, leaseExpiresAt: deadline }
			},
			staleRelease: false
		});
	});

	it.each(['insert', 'update'] as const)(
		'protects global computation from a preceding tenant %s that does not query global leases',
		async (operation) => {
			const { database, first, store, tenant } = await fixture();
			const task = await first.claim();
			const legacy = tenantRequest(task);
			if (operation === 'update') {
				const previous = await tenant.claim(legacy, now);
				if (previous.kind !== 'claimed') {
					throw new Error('The preceding tenant claim did not start');
				}
				await tenant.release(previous.claim, now);
			}
			generationClaim(await store.claim(task, now));
			const insert = sql`INSERT INTO listing_generation (nar_hash, generator_revision, source_incarnation, generation, tenant, owner, lease_expires_at, updated_at)
			VALUES (${legacy.narHash}, ${legacy.generatorRevision}, ${legacy.sourceIncarnation}, 1, ${legacy.tenant}, ${legacy.owner}, ${deadline}, ${now})
			ON CONFLICT(nar_hash, generator_revision) DO UPDATE SET tenant = excluded.tenant, owner = excluded.owner,
			lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at, generation = listing_generation.generation + 1
			WHERE listing_generation.owner IS NULL OR listing_generation.lease_expires_at <= excluded.updated_at`;
			const update = sql`UPDATE listing_generation SET tenant = ${legacy.tenant}, owner = ${legacy.owner},
			lease_expires_at = ${deadline}, updated_at = ${now}, generation = generation + 1
			WHERE nar_hash = ${legacy.narHash} AND generator_revision = ${legacy.generatorRevision}`;
			await database.run(operation === 'insert' ? insert : update);
			expect({
				owner: await tenant.find(legacy),
				claim: await tenant.claim(legacy, later)
			}).toStrictEqual({
				owner: undefined,
				claim: { kind: 'busy', retryAt: deadline }
			});
		}
	);

	it('refuses unavailable physical sources even with a current task token', async () => {
		const { database, first, store } = await fixture();
		const task = await first.claim();
		await database
			.update(schema.objectIncarnation)
			.set({ state: 'pending' })
			.where(
				and(
					eq(schema.objectIncarnation.kind, 'nar'),
					eq(schema.objectIncarnation.objectId, task.narHash)
				)
			);
		expect(await store.claim(task, now)).toStrictEqual({ kind: 'unavailable' });
	});

	it('allows tenant claims and replay before global lease storage expands', async () => {
		const { database, first, tenant } = await fixture();
		const task = await first.claim();
		const request = tenantRequest(task);
		const migration = env.TEST_MIGRATIONS.find(
			(entry) => entry.name === '0059_shared_listing_generation.sql'
		);
		if (migration === undefined) {
			throw new Error('The global computation migration is missing');
		}
		await database
			.delete(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, 'global-listing-generation'));
		await env.CUPBOARD_DB.batch(
			[
				'DROP TRIGGER tenant_listing_generation_exclude_insert',
				'DROP TRIGGER tenant_listing_generation_exclude_update',
				'DROP TRIGGER global_listing_generation_exclude_insert',
				'DROP TRIGGER global_listing_generation_exclude_update',
				'DROP TABLE shared_listing_generation'
			].map((query) => env.CUPBOARD_DB.prepare(query))
		);
		try {
			const firstClaim = await tenant.claim(request, now);
			expect({
				firstClaim,
				replay: await tenant.claim(request, later)
			}).toStrictEqual({
				firstClaim: {
					kind: 'claimed',
					claim: { ...request, generation: 1, leaseExpiresAt: deadline }
				},
				replay: firstClaim
			});
		} finally {
			await env.CUPBOARD_DB.batch(
				migration.queries.map((query) => env.CUPBOARD_DB.prepare(query))
			);
		}
	});

	it('refuses a source after its last retention reference is removed', async () => {
		const { database, first, store } = await fixture();
		const task = await first.claim();
		await database
			.delete(schema.blobReference)
			.where(eq(schema.blobReference.narHash, task.narHash));
		expect(await store.claim(task, now)).toStrictEqual({ kind: 'unavailable' });
	});

	it('replaces a repaired source immediately and fences its previous computation', async () => {
		const { database, first, tasks, store } = await fixture();
		const task = await first.claim();
		const previous = generationClaim(await store.claim(task, now));
		const identity = and(
			eq(schema.objectIncarnation.kind, 'nar'),
			eq(schema.objectIncarnation.objectId, task.narHash)
		);
		await database
			.update(schema.objectIncarnation)
			.set({ state: 'pending', incarnation: 3 })
			.where(identity);
		await database
			.update(schema.blobState)
			.set({ incarnation: 3 })
			.where(eq(schema.blobState.narHash, task.narHash));
		await database
			.update(schema.objectIncarnation)
			.set({ state: 'live' })
			.where(identity);
		await database
			.update(schema.sharedListingTask)
			.set({
				sourceIncarnation: 3,
				state: 'pending',
				leaseExpiresAt: sql`null`
			})
			.where(eq(schema.sharedListingTask.id, task.id));
		const replacementTask = taskClaim(
			await tasks.claim({ job: task.job, id: task.id, owner: otherOwner }, now)
		);
		expect({
			replacement: await store.claim(replacementTask, now),
			renewal: await store.renew(previous, now),
			release: await store.release(previous, now)
		}).toStrictEqual({
			replacement: {
				kind: 'claimed',
				claim: {
					task: replacementTask,
					generation: 2,
					leaseExpiresAt: deadline
				}
			},
			renewal: undefined,
			release: false
		});
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		'rejects an invalid computation generation: %s',
		async (generation) => {
			const { database, first, store } = await fixture();
			const task = await first.claim();
			generationClaim(await store.claim(task, now));
			const before = await database
				.select()
				.from(schema.sharedListingGeneration);
			await expect(
				database.update(schema.sharedListingGeneration).set({ generation })
			).rejects.toThrow();
			expect(
				await database.select().from(schema.sharedListingGeneration)
			).toStrictEqual(before);
		}
	);
});
