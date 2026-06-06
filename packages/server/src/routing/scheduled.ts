import { asc, eq, inArray } from 'drizzle-orm';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';

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

// The KV key holding the demote scan's resume position (see DemoteCursor).
const demoteCursorKey = 'reaper:demote-cursor';

type CronDatabase = DrizzleD1Database<typeof d1Schema>;
type MaintainTenant = (env: Env, id: string) => Promise<void>;

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
