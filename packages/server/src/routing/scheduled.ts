import {
	type NixSha256HashString,
	tenantIdSchema
} from '@cupboard/nix/scalars';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import { retireScheduledControlKeys } from '../control/control-key-store.ts';
import {
	deleteTenantMember,
	refreshTenantMembership
} from '../control/tenant-membership.ts';
import { finaliseOffboardedTenant } from '../control/tenant-registry.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	BlobReaperService,
	type CasReferenceDemoter,
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
const maintenanceEligibilityStaleMs = 6 * 60 * 60 * 1000;

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
const casDemoteCursorKey = 'reaper:cas-demote-cursor';

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
type MaintenanceQueue = Pick<Queue<MaintenanceQueueMessage>, 'sendBatch'>;
type MaintenanceQueueDecision =
	| { readonly action: 'ack' }
	| {
			readonly action: 'retry';
			readonly delaySeconds: number;
			readonly reason: string;
	  };
interface ExecuteMaintenanceQueueOptions {
	readonly maintainTenant?: MaintainTenant;
	readonly verifyTenant?: MaintainTenant;
	readonly drainTenant?: DrainTenant;
	readonly runBlobReaper?: (env: Env) => Promise<unknown>;
	readonly runCasReaper?: (env: Env) => Promise<unknown>;
	readonly runReaperDemote?: (env: Env) => Promise<unknown>;
	readonly runCasReaperDemote?: (env: Env) => Promise<unknown>;
	readonly runControlKeyRetirement?: (env: Env) => Promise<unknown>;
}

const maxStoredErrorLength = 4096;
const queueRetryDelaySeconds = 60;
const queueSendBatchSize = 100;

const maintenanceQueueMessageSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('tenant-maintenance'), tenant: tenantIdSchema }),
	z.object({ kind: z.literal('tenant-verify'), tenant: tenantIdSchema }),
	z.object({ kind: z.literal('offboard'), tenant: tenantIdSchema }),
	z.object({ kind: z.literal('blob-reaper') }),
	z.object({ kind: z.literal('cas-reaper') }),
	z.object({ kind: z.literal('blob-demote') }),
	z.object({ kind: z.literal('cas-demote') }),
	z.object({ kind: z.literal('control-key-retirement') })
]);

export type MaintenanceQueueMessage =
	| { readonly kind: 'tenant-maintenance'; readonly tenant: string }
	| { readonly kind: 'tenant-verify'; readonly tenant: string }
	| { readonly kind: 'offboard'; readonly tenant: string }
	| { readonly kind: 'blob-reaper' }
	| { readonly kind: 'cas-reaper' }
	| { readonly kind: 'blob-demote' }
	| { readonly kind: 'cas-demote' }
	| { readonly kind: 'control-key-retirement' };

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
		() => runCasReaper(env),
		() => runReaperDemote(env),
		() => runCasReaperDemote(env),
		() => runControlKeyRetirement(env)
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

export async function enqueueMaintenanceJobs(
	env: Env,
	queue: MaintenanceQueue = env.MAINTENANCE_QUEUE
): Promise<MaintenanceQueueMessage[]> {
	// Rebuild the membership filter and reassert per-tenant markers inline each
	// tick, before fanning work out: new-tenant liveness and dropped-marker healing
	// must not depend on a queue send that can be dropped.
	await refreshTenantMembership(env);

	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const maintenanceTenants = await overdueActiveTenants(
		database,
		maintenanceBatchSize
	);
	const offboardTenants = await selectOffboardTenants(
		database,
		offboardTenantsPerTick
	);
	const messages: MaintenanceQueueMessage[] = [
		...maintenanceTenants.map(
			({ id }): MaintenanceQueueMessage => ({
				kind: 'tenant-maintenance',
				tenant: id
			})
		),
		...offboardTenants.map(
			({ id }): MaintenanceQueueMessage => ({ kind: 'offboard', tenant: id })
		),
		{ kind: 'blob-reaper' },
		{ kind: 'cas-reaper' },
		{ kind: 'blob-demote' },
		{ kind: 'cas-demote' },
		{ kind: 'control-key-retirement' }
	];

	await sendQueueMessages(queue, messages);

	return messages;
}

// One or more maintenance queue batches failed to send. It carries the
// underlying send failures so a partial send is observable, distinct from the
// per-tenant pass failures the cron also aggregates.
export class QueueBatchSendError extends AggregateError {
	constructor(failures: readonly unknown[]) {
		super(failures);
		this.name = 'QueueBatchSendError';
	}
}

export async function sendQueueMessages(
	queue: MaintenanceQueue,
	messages: readonly MaintenanceQueueMessage[]
): Promise<void> {
	// Attempt every chunk even if one fails, so a failed send of an earlier chunk
	// does not skip the global passes (reaper, demote, control-key retirement) that
	// trail the per-tenant messages. Failures are aggregated and rethrown so the
	// tick still records that the send was incomplete.
	const failures: unknown[] = [];

	for (let offset = 0; offset < messages.length; offset += queueSendBatchSize) {
		const batch = messages.slice(offset, offset + queueSendBatchSize);

		try {
			await queue.sendBatch(batch.map((body) => ({ body })));
		} catch (error) {
			failures.push(error);
		}
	}

	if (failures.length > 0) {
		throw new QueueBatchSendError(failures);
	}
}

export async function handleMaintenanceQueue(
	batch: MessageBatch,
	env: Env
): Promise<void> {
	for (const message of batch.messages) {
		const parsed = maintenanceQueueMessageSchema.safeParse(message.body);

		if (!parsed.success) {
			logInvalidMaintenanceQueueMessage(batch, message, parsed.error);
			message.ack();
			continue;
		}

		const decision = await executeMaintenanceQueueMessage(env, parsed.data);

		if (decision.action === 'ack') {
			message.ack();
			continue;
		}

		logMaintenanceQueueRetry(batch, message, parsed.data, decision);
		message.retry({ delaySeconds: decision.delaySeconds });
	}
}

export async function executeMaintenanceQueueMessage(
	env: Env,
	message: MaintenanceQueueMessage,
	options: ExecuteMaintenanceQueueOptions = {}
): Promise<MaintenanceQueueDecision> {
	try {
		switch (message.kind) {
			case 'tenant-maintenance': {
				return await executeTenantMaintenanceMessage(
					env,
					message.tenant,
					options.maintainTenant ?? maintainTenant
				);
			}
			case 'tenant-verify': {
				// A commit asked for this pass because it stored a blob pending
				// verification, so it runs regardless of the maintenance cadence.
				await (options.verifyTenant ?? verifyTenant)(env, message.tenant);
				return { action: 'ack' };
			}
			case 'offboard': {
				return await executeOffboardMessage(
					env,
					message.tenant,
					options.drainTenant ?? drainTenant
				);
			}
			case 'blob-reaper': {
				await (options.runBlobReaper ?? runBlobReaper)(env);
				return { action: 'ack' };
			}
			case 'cas-reaper': {
				await (options.runCasReaper ?? runCasReaper)(env);
				return { action: 'ack' };
			}
			case 'blob-demote': {
				await (options.runReaperDemote ?? runReaperDemote)(env);
				return { action: 'ack' };
			}
			case 'cas-demote': {
				await (options.runCasReaperDemote ?? runCasReaperDemote)(env);
				return { action: 'ack' };
			}
			case 'control-key-retirement': {
				await (options.runControlKeyRetirement ?? runControlKeyRetirement)(env);
				return { action: 'ack' };
			}
		}
	} catch (error) {
		return {
			action: 'retry',
			delaySeconds: queueRetryDelaySeconds,
			reason: errorSummary(error)
		};
	}
}

function logInvalidMaintenanceQueueMessage(
	batch: MessageBatch,
	message: Message,
	error: z.ZodError
): void {
	console.warn('maintenance queue message rejected', {
		queue: batch.queue,
		messageId: message.id,
		attempts: message.attempts,
		issues: error.issues
	});
}

function logMaintenanceQueueRetry(
	batch: MessageBatch,
	message: Message,
	body: MaintenanceQueueMessage,
	decision: Extract<MaintenanceQueueDecision, { readonly action: 'retry' }>
): void {
	console.error('maintenance queue message retrying', {
		queue: batch.queue,
		messageId: message.id,
		attempts: message.attempts,
		delaySeconds: decision.delaySeconds,
		reason: decision.reason,
		...maintenanceQueueMessageLogFields(body)
	});
}

function maintenanceQueueMessageLogFields(message: MaintenanceQueueMessage): {
	readonly kind: string;
	readonly tenant?: string;
} {
	if ('tenant' in message) {
		return { kind: message.kind, tenant: message.tenant };
	}

	return { kind: message.kind };
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

export function runCasReaper(
	env: Env,
	batchSize: number = blobReaperBatchSize
): Promise<number> {
	return blobReaper(env).reapCasObjects(new Date(), batchSize);
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

export function runCasReaperDemote(
	env: Env,
	batchSize: number = blobReaperBatchSize
): Promise<number> {
	return blobReaper(env).demoteMissingCasObjects(
		batchSize,
		casDemoteCursor(env)
	);
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

function casDemoteCursor(env: Env): DemoteCursor {
	return {
		read: async () => (await env.CRON_STATE.get(casDemoteCursorKey)) ?? '',
		advance: (position) => env.CRON_STATE.put(casDemoteCursorKey, position)
	};
}

function blobReaper(env: Env): BlobReaperService {
	return new BlobReaperService(
		drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
		env.BLOBS,
		new TenantNarInfoDemoter(env),
		new TenantCasReferenceDemoter(env)
	);
}

// Routes a demote to the owning tenant's Durable Object, the single writer of that
// tenant's narinfo objects. The service binding authorises the direct RPC, so the
// reaper never touches a tenant's objects itself.
class TenantNarInfoDemoter implements NarInfoDemoter {
	constructor(private readonly env: Env) {}

	demote(
		tenant: string,
		narHash: NixSha256HashString,
		targets: readonly DemoteTarget[]
	): Promise<void> {
		return tenantServer(this.env, tenant).demoteNarInfoObjects(
			narHash,
			targets
		);
	}
}

class TenantCasReferenceDemoter implements CasReferenceDemoter {
	constructor(private readonly env: Env) {}

	demote(tenant: string, digest: string, fenceStoredAt: string): Promise<void> {
		return tenantServer(this.env, tenant).demoteAttestationReferences(
			digest,
			fenceStoredAt
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
	const tenants = await selectOffboardTenants(database, tenantLimit);

	const results = await Promise.allSettled(
		tenants.map(({ id }) => drain(env, id, drainLimit, rounds))
	);

	await recordTenantPassOutcomes(database, 'offboard', tenants, results);

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

function selectOffboardTenants(
	database: CronDatabase,
	tenantLimit: number
): Promise<{ readonly id: string }[]> {
	return database
		.select({ id: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.status, 'offboarding'))
		.orderBy(asc(d1Schema.tenant.id))
		.limit(tenantLimit)
		.all();
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
// drain makes an interrupted finalisation converge on the next tick. The membership
// marker is deleted here, since it tracks `status != 'offboarded'`; the next filter
// rebuild then drops the slug, and an interrupted finalisation leaves only a
// harmless tombstone the rebuild reconciles.
async function finaliseTenant(env: Env, id: string): Promise<void> {
	await tenantServer(env, id).purgeStorage();

	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	await finaliseOffboardedTenant(database, id);
	await deleteTenantMember(env.TENANT_CACHE, id);
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
		() => server.runVerification(),
		() => server.runAuthKeyRetirement()
	);
}

function verifyTenant(env: Env, id: string): Promise<void> {
	return tenantServer(env, id).runVerification();
}

async function executeTenantMaintenanceMessage(
	env: Env,
	tenant: string,
	maintain: MaintainTenant
): Promise<MaintenanceQueueDecision> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	if (!(await tenantMaintenanceIsDue(database, tenant))) {
		return { action: 'ack' };
	}

	const result = await Promise.resolve()
		.then(() => maintain(env, tenant))
		.then(
			() => ({ status: 'fulfilled', value: undefined }) as const,
			(error: unknown) => ({ status: 'rejected', reason: error }) as const
		);

	await recordTenantPassOutcomes(
		database,
		'maintenance',
		[{ id: tenant }],
		[result]
	);
	await stampMaintained(database, [{ id: tenant }]);

	return { action: 'ack' };
}

async function executeOffboardMessage(
	env: Env,
	tenant: string,
	drain: DrainTenant
): Promise<MaintenanceQueueDecision> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const status = await tenantStatus(database, tenant);

	if (status === 'offboarding') {
		const result = await Promise.resolve()
			.then(() => drain(env, tenant, offboardDrainChunk, offboardRoundsPerTick))
			.then(
				() => ({ status: 'fulfilled', value: undefined }) as const,
				(error: unknown) => ({ status: 'rejected', reason: error }) as const
			);

		await recordTenantPassOutcomes(
			database,
			'offboard',
			[{ id: tenant }],
			[result]
		);

		return { action: 'ack' };
	}

	return { action: 'ack' };
}

function tenantStatus(
	database: CronDatabase,
	tenant: string
): Promise<typeof d1Schema.tenant.$inferSelect.status | undefined> {
	return database
		.select({ status: d1Schema.tenant.status })
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, tenant))
		.get()
		.then((row) => row?.status);
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
		.leftJoin(
			d1Schema.tenantMaintenanceEligibility,
			eq(d1Schema.tenantMaintenanceEligibility.tenant, d1Schema.tenant.id)
		)
		.where(tenantMaintenanceDueCondition())
		.orderBy(asc(d1Schema.tenant.lastMaintainedAt), asc(d1Schema.tenant.id))
		.limit(batchSize)
		.all();
}

function tenantMaintenanceIsDue(
	database: CronDatabase,
	tenant: string
): Promise<boolean> {
	return database
		.select({ id: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.leftJoin(
			d1Schema.tenantMaintenanceEligibility,
			eq(d1Schema.tenantMaintenanceEligibility.tenant, d1Schema.tenant.id)
		)
		.where(and(tenantMaintenanceDueCondition(), eq(d1Schema.tenant.id, tenant)))
		.limit(1)
		.get()
		.then((row) => row !== undefined);
}

function tenantMaintenanceDueCondition() {
	const now = new Date();
	const nowIso = now.toISOString();
	const staleBefore = new Date(
		now.getTime() - maintenanceEligibilityStaleMs
	).toISOString();

	return and(
		eq(d1Schema.tenant.status, 'active'),
		or(
			isNull(d1Schema.tenantMaintenanceEligibility.tenant),
			lte(d1Schema.tenantMaintenanceEligibility.reconciledAt, staleBefore),
			lte(d1Schema.tenantMaintenanceEligibility.nextMaintenanceAt, nowIso)
		)
	);
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
 * Drives the maintenance passes for one tenant from the cron tick. Each runs
 * every tick, independent of the others' outcomes: a failing verification pass
 * never holds back collection or key retirement. A garbage-collection failure
 * is surfaced first, its cleanup being the more time-sensitive pass.
 */
export async function runScheduledMaintenance(
	runGarbageCollection: () => Promise<void>,
	runVerification: () => Promise<void>,
	runAuthKeyRetirement?: () => Promise<void>
): Promise<void> {
	const [gc, verify] = await Promise.allSettled([
		runGarbageCollection(),
		runVerification()
	]);
	const authKeyRetirement =
		runAuthKeyRetirement === undefined
			? ({ status: 'fulfilled', value: undefined } as const)
			: await Promise.resolve()
					.then(runAuthKeyRetirement)
					.then(
						() => ({ status: 'fulfilled', value: undefined }) as const,
						(error: unknown) => ({ status: 'rejected', reason: error }) as const
					);

	if (gc.status === 'rejected') {
		throw gc.reason;
	}

	if (verify.status === 'rejected') {
		throw verify.reason;
	}

	if (authKeyRetirement.status === 'rejected') {
		throw authKeyRetirement.reason;
	}
}

function runControlKeyRetirement(env: Env): Promise<number> {
	return retireScheduledControlKeys(
		drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
		new Date().toISOString()
	);
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
