import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	publishTenantManifest,
	readTenantManifest
} from '../control/tenant-manifest.ts';
import { finaliseOffboardedTenant } from '../control/tenant-registry.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	BlobReaperService,
	type DemoteCursor,
	type DemoteTarget,
	type NarInfoDemoter
} from '../do/blob-reaper-service.ts';
import { blobReaperBatchSize } from '../http/http.ts';

import { tenantServer } from './durable-object.ts';

// One cron tick maintains at most this many tenants. The sweep picks the
// most-overdue active tenants by `last_maintained_at`, so the whole fleet is
// covered over successive ticks. Provisional, pending a fleet-scale measurement.
const maintenanceBatchSize = 100;
const maintenanceConcurrency = 4;

// Per cron tick, the offboard drain works at most this many tenants, each for at
// most this many bounded rounds of this many rows/objects. The product bounds the
// tick's subrequest fan-out; the per-round chunk matches R2's 1000-key delete so a
// large tenant reclaims many batches per tick rather than one. Provisional, pending
// a fleet-scale measurement.
const offboardTenantsPerTick = 10;
const offboardRoundsPerTick = 10;
const offboardDrainChunk = 1000;

// The KV key holding the demote scan's resume position (see DemoteCursor).
const demoteCursorKey = 'reaper:demote-cursor';

type CronDatabase = DrizzleD1Database<typeof d1Schema>;
type TenantCronPass =
	typeof d1Schema.tenantMaintenanceFailure.$inferSelect.pass;
type MaintainTenant = (env: Env, id: string) => Promise<void>;
type DrainTenant = (
	env: Env,
	id: string,
	drainLimit: number,
	rounds: number
) => Promise<void>;

const maxStoredErrorLength = 4096;

/**
 * One hourly cron tick: the bounded tenant maintenance sweep, then the global blob
 * reaper on its reserved budget after the fan-out, in its three passes (arm and
 * collect unreferenced blobs, then demote those whose object has gone missing). Each
 * pass runs independently of the others' outcome, and their failures are surfaced
 * together so neither a stalled sweep nor a stalled reaper is silently swallowed.
 */
export async function runCronTick(env: Env): Promise<void> {
	const failures: unknown[] = [];

	// Sequential, not concurrent: the reaper runs on its reserved budget after the
	// fan-out so a long fan-out cannot starve it, and each pass is isolated so one
	// stalling does not hold back the next.
	for (const pass of [
		() => runCronSweep(env),
		() => runOffboardSweep(env),
		() => runBlobReaper(env),
		() => runReaperDemote(env)
	]) {
		try {
			await pass();
		} catch (error) {
			failures.push(error);
		}
	}

	if (failures.length > 0) {
		throw new AggregateError(
			failures,
			`cron tick had ${String(failures.length)} failing pass(es)`
		);
	}
}

/**
 * The global blob reaper, run Worker-side over the shared D1 facts and R2 objects
 * rather than inside any tenant's Durable Object, so the only actor that sees every
 * tenant's reference edges does the collecting. Returns how many shared blobs it
 * collected.
 */
export function runBlobReaper(
	env: Env,
	batchSize: number = blobReaperBatchSize
): Promise<number> {
	return blobReaper(env).reapBlobs(new Date(), batchSize);
}

/**
 * The reaper's demote pass: a bounded, cursored scan of `blob_state` for shared
 * objects that have gone missing, removing the fact and de-materialising the
 * referencing narinfos through their owning tenant Durable Objects. Run Worker-side
 * for the same reason as the collect pass: only the Worker can scan every tenant's
 * facts. Returns how many shared facts it demoted.
 */
export function runReaperDemote(
	env: Env,
	batchSize: number = blobReaperBatchSize
): Promise<number> {
	return blobReaper(env).demoteMissingBlobs(batchSize, demoteCursor(env));
}

// The demote scan's resume position, held as one KV value: it is cron bookkeeping,
// not shared-blob data, so it lives outside the relational schema. Absent or empty
// means start from the beginning.
function demoteCursor(env: Env): DemoteCursor {
	return {
		read: async () => (await env.CRON_STATE.get(demoteCursorKey)) ?? '',
		advance: (position) => env.CRON_STATE.put(demoteCursorKey, position)
	};
}

function blobReaper(env: Env): BlobReaperService {
	return new BlobReaperService(
		drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
		env.BLOBS,
		new TenantNarInfoDemoter(env)
	);
}

// Routes a demote to the owning tenant's Durable Object, the single writer of that
// tenant's narinfo objects. The service binding authorises the direct RPC, so the
// reaper never touches a tenant's objects itself.
class TenantNarInfoDemoter implements NarInfoDemoter {
	constructor(private readonly env: Env) {}

	demote(
		tenant: string,
		narHash: string,
		targets: readonly DemoteTarget[]
	): Promise<void> {
		return tenantServer(this.env, tenant).demoteNarInfoObjects(
			narHash,
			targets
		);
	}
}

/**
 * Drives the offboarding drain for a bounded batch of tenants. Each draining tenant
 * sheds a bounded batch of its reference and presence rows through its own Durable
 * Object (the single writer of those rows) and a bounded batch of its R2 objects
 * through the Worker; a tenant whose rows and objects are both gone is finalised into
 * its terminal scrubbed tombstone. Offboarding tenants are disjoint from the
 * maintenance sweep (which serves only active tenants), so the two never contend for
 * one tenant. Per-tenant failures are surfaced together rather than swallowed.
 */
export async function runOffboardSweep(
	env: Env,
	tenantLimit: number = offboardTenantsPerTick,
	drainLimit: number = offboardDrainChunk,
	rounds: number = offboardRoundsPerTick,
	drain: DrainTenant = drainTenant
): Promise<void> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const tenants = await database
		.select({ id: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.status, 'offboarding'))
		.orderBy(asc(d1Schema.tenant.id))
		.limit(tenantLimit)
		.all();

	const results = await Promise.allSettled(
		tenants.map(({ id }) => drain(env, id, drainLimit, rounds))
	);

	await recordTenantPassOutcomes(database, 'offboard', tenants, results);

	// Republish the manifest if a finalised tenant still lingers in it: finalisation
	// flips the registry status to `offboarded` (excluded from the manifest) but a
	// crash before the republish would otherwise strand the slug in it forever, since
	// the drain selects only `offboarding`. One republish drops every stale tombstone.
	await reconcileOffboardedManifest(env, database);

	const failures = results.flatMap((result): unknown[] =>
		result.status === 'rejected' ? [result.reason] : []
	);

	if (failures.length > 0) {
		throw new AggregateError(
			failures,
			`offboard drain failed for ${String(failures.length)} of ${String(tenants.length)} tenant(s)`
		);
	}
}

async function reconcileOffboardedManifest(
	env: Env,
	database: CronDatabase
): Promise<void> {
	const manifest = await readTenantManifest(env.TENANT_CACHE);
	const ids = manifest === undefined ? [] : Object.keys(manifest.tenants);

	if (ids.length === 0) {
		return;
	}

	const stale = await database
		.select({ id: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.where(
			and(
				eq(d1Schema.tenant.status, 'offboarded'),
				inArray(d1Schema.tenant.id, ids)
			)
		)
		.limit(1)
		.get();

	if (stale !== undefined) {
		await publishTenantManifest(database, env.TENANT_CACHE);
	}
}

// Drains a single tenant for up to a bounded number of rounds this tick, finalising
// it once its rows and objects are both exhausted. Each round sheds a chunk of edge
// rows through the Durable Object (the single writer of those rows) and a chunk of R2
// objects directly (content-addressed and idempotent, so the Worker may delete them);
// looping lets a large tenant reclaim many chunks per tick while the round cap keeps
// the tick within its subrequest budget.
async function drainTenant(
	env: Env,
	id: string,
	drainLimit: number,
	rounds: number
): Promise<void> {
	for (let round = 0; round < rounds; round += 1) {
		const { drained } = await tenantServer(env, id).runOffboard(drainLimit);
		const objectsRemain = await deleteTenantObjects(env, id, drainLimit);

		if (drained && !objectsRemain) {
			await finaliseTenant(env, id);
			return;
		}
	}
}

// Deletes a bounded batch of a tenant's namespaced R2 objects, returning whether
// more remain so the drain runs again next tick. Listing from the prefix each tick
// (the deleted keys gone) makes progress without a persisted cursor.
async function deleteTenantObjects(
	env: Env,
	id: string,
	limit: number
): Promise<boolean> {
	const listed = await env.BLOBS.list({ prefix: `t/${id}/`, limit });

	if (listed.objects.length > 0) {
		await env.BLOBS.delete(listed.objects.map((object) => object.key));
	}

	return listed.truncated;
}

// Finalises a fully drained tenant: wipe its Durable Object storage (keys, identity,
// narinfos), then scrub its registry row to the terminal `offboarded` tombstone with
// its usage row dropped. Purging first and tolerating an already-purged object in the
// drain makes an interrupted finalisation converge on the next tick. The manifest is
// republished by the sweep's reconciliation, not here, so a crash before it cannot
// strand the slug in the manifest.
async function finaliseTenant(env: Env, id: string): Promise<void> {
	await tenantServer(env, id).purgeStorage();

	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	await finaliseOffboardedTenant(database, id);
}

/**
 * Drives one hourly cron tick: maintains the most-overdue active tenants and stamps
 * them, so the table's own `last_maintained_at` carries the round-robin position and
 * the whole fleet is covered over successive ticks. Per-tenant failures are collected
 * and surfaced together rather than swallowed, so a fleet-wide stall is observable;
 * the batch is stamped regardless of per-tenant outcome, so one failing tenant does
 * not wedge the sweep.
 */
export async function runCronSweep(
	env: Env,
	batchSize: number = maintenanceBatchSize,
	maintain: MaintainTenant = maintainTenant
): Promise<void> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const batch = await overdueActiveTenants(database, batchSize);

	// Each tenant runs independently so one tenant's failure does not stall the
	// rest, but the fan-out is explicitly capped so the platform does not have to
	// provide the backpressure policy.
	const results = await settleWithConcurrency(
		batch,
		maintenanceConcurrency,
		({ id }) => maintain(env, id)
	);

	await recordTenantPassOutcomes(database, 'maintenance', batch, results);
	await stampMaintained(database, batch);

	const failures = results.flatMap((result): unknown[] =>
		result.status === 'rejected' ? [result.reason] : []
	);

	if (failures.length > 0) {
		throw new AggregateError(
			failures,
			`cron maintenance failed for ${String(failures.length)} of ${String(batch.length)} tenant(s)`
		);
	}
}

async function settleWithConcurrency<T>(
	items: readonly T[],
	concurrency: number,
	run: (item: T) => Promise<void>
): Promise<PromiseSettledResult<void>[]> {
	const results: PromiseSettledResult<void>[] = [];
	results.length = items.length;
	let next = 0;

	async function worker(): Promise<void> {
		for (;;) {
			const index = next;
			next += 1;
			const item = items[index];

			if (item === undefined) {
				return;
			}

			try {
				await run(item);
				results[index] = { status: 'fulfilled', value: undefined };
			} catch (error) {
				results[index] = { status: 'rejected', reason: error };
			}
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
	);

	return results;
}

function maintainTenant(env: Env, id: string): Promise<void> {
	const server = tenantServer(env, id);

	return runScheduledMaintenance(
		() => server.runGarbageCollection(),
		() => server.runVerification()
	);
}

// The most-overdue active tenants. NULL `last_maintained_at` (never maintained) sorts
// first in SQLite ascending order, so a new tenant is picked up promptly; the id is
// the tiebreaker for a stable batch among equal timestamps.
function overdueActiveTenants(
	database: CronDatabase,
	batchSize: number
): Promise<{ readonly id: string }[]> {
	return database
		.select({ id: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.status, 'active'))
		.orderBy(asc(d1Schema.tenant.lastMaintainedAt), asc(d1Schema.tenant.id))
		.limit(batchSize)
		.all();
}

// Stamps the maintained batch so the next tick advances to the next-oldest tenants.
// Stamped after the passes run and regardless of their outcome, so a failing tenant
// is not retried until the cycle comes round again, while a whole-tick crash before
// this leaves the batch unstamped and reprocesses it.
async function stampMaintained(
	database: CronDatabase,
	batch: readonly { readonly id: string }[]
): Promise<void> {
	if (batch.length === 0) {
		return;
	}

	await database
		.update(d1Schema.tenant)
		.set({ lastMaintainedAt: new Date().toISOString() })
		.where(
			inArray(
				d1Schema.tenant.id,
				batch.map((entry) => entry.id)
			)
		)
		.run();
}

/**
 * Drives the two maintenance passes for one tenant from the cron tick. Each runs
 * every tick, independent of the other's outcome: a failing verify never holds
 * back a sweep, nor a failing sweep a verify. A garbage-collection failure is
 * surfaced first, its cleanup being the more time-sensitive of the two.
 */
export async function runScheduledMaintenance(
	runGarbageCollection: () => Promise<void>,
	runVerification: () => Promise<void>
): Promise<void> {
	const [gc, verify] = await Promise.allSettled([
		runGarbageCollection(),
		runVerification()
	]);

	if (gc.status === 'rejected') {
		throw gc.reason;
	}

	if (verify.status === 'rejected') {
		throw verify.reason;
	}
}

async function recordTenantPassOutcomes(
	database: CronDatabase,
	pass: TenantCronPass,
	tenants: readonly { readonly id: string }[],
	results: readonly PromiseSettledResult<unknown>[]
): Promise<void> {
	const now = new Date().toISOString();

	await Promise.all(
		tenants.map(({ id }, index) => {
			const result = results[index];

			if (result?.status === 'rejected') {
				return recordTenantPassFailure(database, id, pass, result.reason, now);
			}

			return recordTenantPassSuccess(database, id, pass, now);
		})
	);
}

function recordTenantPassSuccess(
	database: CronDatabase,
	tenant: string,
	pass: TenantCronPass,
	now: string
): Promise<unknown> {
	return database
		.insert(d1Schema.tenantMaintenanceFailure)
		.values({
			tenant,
			pass,
			consecutiveFailures: 0,
			lastSuccessAt: now
		})
		.onConflictDoUpdate({
			target: [
				d1Schema.tenantMaintenanceFailure.tenant,
				d1Schema.tenantMaintenanceFailure.pass
			],
			set: {
				consecutiveFailures: 0,
				lastSuccessAt: now
			}
		})
		.run();
}

function recordTenantPassFailure(
	database: CronDatabase,
	tenant: string,
	pass: TenantCronPass,
	error: unknown,
	now: string
): Promise<unknown> {
	const lastError = errorSummary(error);

	return database
		.insert(d1Schema.tenantMaintenanceFailure)
		.values({
			tenant,
			pass,
			consecutiveFailures: 1,
			lastError,
			lastFailedAt: now
		})
		.onConflictDoUpdate({
			target: [
				d1Schema.tenantMaintenanceFailure.tenant,
				d1Schema.tenantMaintenanceFailure.pass
			],
			set: {
				consecutiveFailures: sql`${d1Schema.tenantMaintenanceFailure.consecutiveFailures} + 1`,
				lastError,
				lastFailedAt: now
			}
		})
		.run();
}

function errorSummary(error: unknown): string {
	const summary =
		error instanceof Error
			? error.message.length > 0
				? `${error.name}: ${error.message}`
				: error.name
			: String(error);

	return summary.slice(0, maxStoredErrorLength);
}
