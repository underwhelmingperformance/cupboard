import { type Logger, rootLogger } from '@cupboard/logger';
import { type TenantId, tenantIdSchema } from '@cupboard/nix-store/scalars';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import {
	type NarVerification,
	verifyDecompressedNar
} from '../blob/nar-verify.ts';
import { promoteVerifiedBlob } from '../blob/promote-blob.ts';
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
	type CasReferenceDemotion,
	type DemoteCursor,
	type NarInfoDemoter,
	type NarInfoDemotion
} from '../do/blob-reaper-service.ts';
import { mapWithConcurrency, maxOutgoingConnections } from '../do/bulk.ts';
import {
	type PendingVerification,
	type VerificationResult
} from '../do/verification-service.ts';
import { UploadedObjectNotFoundError } from '../errors.ts';
import {
	blobReaperBatchSize,
	verifyClaimBatchSize,
	verifyClaimMaxNarBytes
} from '../http/http.ts';

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
// large tenant reclaims many batches per tick. Provisional, pending
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
type MaintainTenant = (logger: Logger, env: Env, id: TenantId) => Promise<void>;
type DrainTenant = (
	logger: Logger,
	env: Env,
	id: TenantId,
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
	readonly runBlobReaper?: (logger: Logger, env: Env) => Promise<unknown>;
	readonly runCasReaper?: (logger: Logger, env: Env) => Promise<unknown>;
	readonly runReaperDemote?: (logger: Logger, env: Env) => Promise<unknown>;
	readonly runCasReaperDemote?: (logger: Logger, env: Env) => Promise<unknown>;
	readonly runControlKeyRetirement?: (
		logger: Logger,
		env: Env
	) => Promise<unknown>;
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
	| { readonly kind: 'tenant-maintenance'; readonly tenant: TenantId }
	| { readonly kind: 'tenant-verify'; readonly tenant: TenantId }
	| { readonly kind: 'offboard'; readonly tenant: TenantId }
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
export async function runCronTick(logger: Logger, env: Env): Promise<void> {
	const failures: unknown[] = [];

	// Sequential, not concurrent: the reaper runs on its reserved budget after the
	// fan-out so a long fan-out cannot starve it, and each pass is isolated so one
	// stalling does not hold back the next.
	for (const pass of [
		() => runCronSweep(logger, env),
		() => runOffboardSweep(logger, env),
		() => runBlobReaper(logger, env),
		() => runCasReaper(logger, env),
		() => runReaperDemote(logger, env),
		() => runCasReaperDemote(logger, env),
		() => runControlKeyRetirement(logger, env)
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
		...maintenanceTenants.map(({ id }): MaintenanceQueueMessage => ({
			kind: 'tenant-maintenance',
			tenant: id
		})),
		...offboardTenants.map(({ id }): MaintenanceQueueMessage => ({
			kind: 'offboard',
			tenant: id
		})),
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
	const logger = rootLogger().with({ worker: 'scheduled', queue: batch.queue });

	for (const message of batch.messages) {
		const messageLogger = logger.with({
			messageId: message.id,
			attempts: message.attempts
		});
		const parsed = maintenanceQueueMessageSchema.safeParse(message.body);

		if (!parsed.success) {
			logInvalidMaintenanceQueueMessage(messageLogger, parsed.error);
			message.ack();
			continue;
		}

		const decision = await executeMaintenanceQueueMessage(
			messageLogger,
			env,
			parsed.data
		);

		if (decision.action === 'ack') {
			message.ack();
			continue;
		}

		logMaintenanceQueueRetry(messageLogger, parsed.data, decision);
		message.retry({ delaySeconds: decision.delaySeconds });
	}
}

export async function executeMaintenanceQueueMessage(
	logger: Logger,
	env: Env,
	message: MaintenanceQueueMessage,
	options: ExecuteMaintenanceQueueOptions = {}
): Promise<MaintenanceQueueDecision> {
	try {
		switch (message.kind) {
			case 'tenant-maintenance': {
				return await executeTenantMaintenanceMessage(
					logger,
					env,
					message.tenant,
					options.maintainTenant ?? maintainTenant
				);
			}
			case 'tenant-verify': {
				// A commit asked for this pass because it stored a blob pending
				// verification, so it runs regardless of the maintenance cadence.
				await (options.verifyTenant ?? verifyTenant)(
					logger,
					env,
					message.tenant
				);
				return { action: 'ack' };
			}
			case 'offboard': {
				return await executeOffboardMessage(
					logger,
					env,
					message.tenant,
					options.drainTenant ?? drainTenant
				);
			}
			case 'blob-reaper': {
				await (options.runBlobReaper ?? runBlobReaper)(logger, env);
				return { action: 'ack' };
			}
			case 'cas-reaper': {
				await (options.runCasReaper ?? runCasReaper)(logger, env);
				return { action: 'ack' };
			}
			case 'blob-demote': {
				await (options.runReaperDemote ?? runReaperDemote)(logger, env);
				return { action: 'ack' };
			}
			case 'cas-demote': {
				await (options.runCasReaperDemote ?? runCasReaperDemote)(logger, env);
				return { action: 'ack' };
			}
			case 'control-key-retirement': {
				await (options.runControlKeyRetirement ?? runControlKeyRetirement)(
					logger,
					env
				);
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
	logger: Logger,
	error: z.ZodError
): void {
	logger.warn('maintenance queue message rejected', { issues: error.issues });
}

function logMaintenanceQueueRetry(
	logger: Logger,
	body: MaintenanceQueueMessage,
	decision: Extract<MaintenanceQueueDecision, { readonly action: 'retry' }>
): void {
	logger.error('maintenance queue message retrying', {
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
 * in the Worker, so the only actor that sees every
 * tenant's reference edges does the collecting. Returns how many shared blobs it
 * collected.
 */
export function runBlobReaper(
	logger: Logger,
	env: Env,
	batchSize: number = blobReaperBatchSize
): Promise<number> {
	return blobReaper(env).reapBlobs(new Date(), batchSize);
}

export function runCasReaper(
	logger: Logger,
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
	logger: Logger,
	env: Env,
	batchSize: number = blobReaperBatchSize
): Promise<number> {
	return blobReaper(env).demoteMissingBlobs(
		logger,
		batchSize,
		demoteCursor(env)
	);
}

export function runCasReaperDemote(
	logger: Logger,
	env: Env,
	batchSize: number = blobReaperBatchSize
): Promise<number> {
	return blobReaper(env).demoteMissingCasObjects(
		logger,
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
		tenant: TenantId,
		demotions: readonly NarInfoDemotion[]
	): Promise<void> {
		return tenantServer(this.env, tenant).demoteNarInfoObjects(demotions);
	}
}

class TenantCasReferenceDemoter implements CasReferenceDemoter {
	constructor(private readonly env: Env) {}

	demote(
		tenant: TenantId,
		demotions: readonly CasReferenceDemotion[]
	): Promise<void> {
		return tenantServer(this.env, tenant).demoteAttestationReferences(
			demotions
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
 * one tenant. Per-tenant failures are all surfaced.
 */
export async function runOffboardSweep(
	logger: Logger,
	env: Env,
	tenantLimit: number = offboardTenantsPerTick,
	drainLimit: number = offboardDrainChunk,
	rounds: number = offboardRoundsPerTick,
	drain: DrainTenant = drainTenant
): Promise<void> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const tenants = await selectOffboardTenants(database, tenantLimit);

	const results = await Promise.allSettled(
		tenants.map(({ id }) => drain(logger, env, id, drainLimit, rounds))
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
): Promise<{ readonly id: TenantId }[]> {
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
	logger: Logger,
	env: Env,
	id: TenantId,
	drainLimit: number,
	rounds: number
): Promise<void> {
	for (let round = 0; round < rounds; round += 1) {
		const { drained: isDrained } = await tenantServer(env, id).runOffboard(
			drainLimit
		);
		const hasRemainingObjects = await deleteTenantObjects(env, id, drainLimit);

		if (isDrained && !hasRemainingObjects) {
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
	id: TenantId,
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
async function finaliseTenant(env: Env, id: TenantId): Promise<void> {
	await tenantServer(env, id).purgeStorage();

	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	await finaliseOffboardedTenant(database, id);
	await deleteTenantMember(env.TENANT_CACHE, id);
}

/**
 * Drives one hourly cron tick: maintains the most-overdue active tenants and stamps
 * them, so the table's own `last_maintained_at` carries the round-robin position and
 * the whole fleet is covered over successive ticks. Per-tenant failures are collected
 * and all surfaced, so a fleet-wide stall is observable;
 * the batch is stamped regardless of per-tenant outcome, so one failing tenant does
 * not wedge the sweep.
 */
export async function runCronSweep(
	logger: Logger,
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
		({ id }) => maintain(logger, env, id)
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

function maintainTenant(logger: Logger, env: Env, id: TenantId): Promise<void> {
	const server = tenantServer(env, id);

	return runScheduledMaintenance(
		() => server.runGarbageCollection(),
		() => server.runVerification(),
		() => server.runAuthKeyRetirement()
	);
}

// How many staging objects the queue consumer decodes at once for one tenant.
// Bounded so a single tenant's verify pass does not monopolise the consumer's
// isolate; the heavy decode is off the DO thread regardless.
const verifyDecodeConcurrency = 4;

// How a recorder reaches the DO through a fault: a couple of in-place retries
// keep a pass's decodes from being wasted on a transient blip, short enough
// that a genuinely down DO fails the message while its claims' leases still
// hold.
const recordAttempts = 3;
const recordRetryDelayMs = 500;

/**
 * Buffers verdicts as they are reached and records them incrementally: one
 * `recordVerifications` RPC in flight at a time, verdicts completing meanwhile
 * coalescing into the next. Progress is monotonic: an invocation that dies
 * mid-pass loses at most the batch in flight plus the buffer, and every
 * verdict recorded before that stays settled. A flush the retries cannot land
 * stops the recorder and surfaces from `settle`, failing the queue message so
 * the platform redelivers it; the applies are idempotent, so the redelivered
 * pass re-records safely.
 */
export class VerdictRecorder {
	private buffer: VerificationResult[] = [];
	private flushing: Promise<void> | undefined;
	private applied = 0;
	private failure: { readonly error: unknown } | undefined;

	constructor(
		private readonly logger: Logger,
		private readonly record: (
			results: readonly VerificationResult[]
		) => Promise<number>,
		private readonly attempts = recordAttempts,
		private readonly retryDelayMs = recordRetryDelayMs
	) {}

	private async flush(): Promise<void> {
		while (this.buffer.length > 0) {
			const batch = this.buffer;
			this.buffer = [];

			try {
				this.applied += await this.recordWithRetry(batch);
			} catch (error) {
				// The batch could not record: keep it buffered (ahead of anything
				// added meanwhile, preserving order) and stop to avoid spinning
				// against a DO that is down. `settle` surfaces the failure.
				this.buffer = [...batch, ...this.buffer];
				this.failure = { error };
				break;
			}
		}

		this.flushing = undefined;
	}

	private async recordWithRetry(
		batch: readonly VerificationResult[]
	): Promise<number> {
		let lastError: unknown;

		for (let attempt = 0; attempt < this.attempts; attempt += 1) {
			if (attempt > 0) {
				await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
			}

			try {
				return await this.record(batch);
			} catch (error) {
				lastError = error;
				this.logger.warn('verification verdicts not recorded', {
					count: batch.length,
					attempt: attempt + 1,
					error
				});
			}
		}

		throw lastError;
	}

	add(result: VerificationResult): void {
		this.buffer.push(result);

		if (this.failure === undefined) {
			this.flushing ??= this.flush();
		}
	}

	/**
	 * Waits for every buffered verdict to record and returns how many actually
	 * applied. Rethrows a recording failure the in-flush retries could not
	 * clear, so the pass's queue message fails and redelivers.
	 */
	async settle(): Promise<number> {
		// A verdict added while a flush is in flight starts a fresh one when it
		// ends, so quiescence means waiting out each successor in turn.
		while (this.flushing !== undefined) {
			await this.flushing;
		}

		if (this.failure !== undefined) {
			throw this.failure.error;
		}

		return this.applied;
	}
}

// Promotes one fresh claim's verified bytes and reports the verdict. A promote
// the consumer completed spares the settle its own; one that fails falls back
// to the plain verified verdict, so the decode is never wasted and the settle
// promotes as before.
async function promoteAndReport(
	database: DrizzleD1Database<typeof d1Schema>,
	blobs: R2Bucket,
	claim: PendingVerification,
	verification: NarVerification
): Promise<VerificationResult> {
	const fallback: VerificationResult = {
		uploadId: claim.uploadId,
		verdict: { kind: 'verified', verification }
	};

	if (
		!verification.ok ||
		verification.fileHash === undefined ||
		verification.fileSize === undefined
	) {
		return fallback;
	}

	try {
		await promoteVerifiedBlob(
			database,
			blobs,
			claim.r2Key,
			{ narHash: claim.narHash, narSize: claim.narSize },
			{ fileHash: verification.fileHash, fileSize: verification.fileSize }
		);

		return { uploadId: claim.uploadId, verdict: { kind: 'promoted' } };
	} catch {
		return fallback;
	}
}

// The prompt verify path. The CPU-bound NAR decode is the work that saturated
// the single DO thread, so it runs here in the queue consumer instead: claim a
// batch of deferred uploads (a read on the DO), fetch, decode and promote each
// staging object off the DO thread, then report the verdicts back so only the
// state transitions run on the single writer. A transient fetch/decode fault
// leaves the row for the next pass (the consumer simply does not report it); a
// definitively missing staging object fails it terminally.
export async function verifyTenant(
	logger: Logger,
	env: Env,
	id: TenantId,
	batchSize: number = verifyClaimBatchSize,
	maxNarBytes: number = verifyClaimMaxNarBytes
): Promise<void> {
	const server = tenantServer(env, id);
	const { claims, truncated } = await server.claimVerificationBatch(
		batchSize,
		maxNarBytes
	);
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	// Verdicts record as they are reached: a waiter unparks as soon as its own
	// upload settles, and an invocation dying mid-pass keeps everything already
	// recorded.
	const recorder = new VerdictRecorder(
		logger.with({ job: 'verify-verdicts' }),
		(results) => server.recordVerifications(results)
	);

	// Reuse rows need no decode: their bytes are the shared canonical object,
	// verified when it was first promoted. Promote each (a canonical head plus
	// the blob_state upsert) ahead of the decodes, so the cheap rows are never
	// hostage to the expensive ones.
	await mapWithConcurrency(
		claims.filter((claim) => claim.reuse),
		maxOutgoingConnections,
		async (claim) => {
			try {
				await promoteVerifiedBlob(
					database,
					env.BLOBS,
					claim.r2Key,
					{ narHash: claim.narHash, narSize: claim.narSize },
					undefined
				);
				recorder.add({
					uploadId: claim.uploadId,
					verdict: { kind: 'promoted' }
				});
			} catch (error) {
				// A vanished canonical object cannot reappear: the row can never
				// settle, so report it gone and let the settle answer the waiter
				// so the settle answers the waiter without waiting for the commit timeout. Anything
				// else is transient; hand the claim back for a prompt retry.
				recorder.add({
					uploadId: claim.uploadId,
					verdict:
						error instanceof UploadedObjectNotFoundError
							? { kind: 'missing' }
							: { kind: 'abandoned' }
				});
			}
		}
	);

	await mapWithConcurrency(
		claims.filter((claim) => !claim.reuse),
		verifyDecodeConcurrency,
		async (claim) => {
			try {
				const object = await env.BLOBS.get(claim.r2Key);

				if (object === null) {
					recorder.add({
						uploadId: claim.uploadId,
						verdict: { kind: 'missing' }
					});
					return;
				}

				// R2 object bodies are byte streams, but `R2ObjectBody.body` is typed
				// only as `ReadableStream`; narrow it to the byte stream the verifier
				// expects.
				const verification = await verifyDecompressedNar(
					object.body as ReadableStream<Uint8Array>,
					{ narHash: claim.narHash, narSize: claim.narSize }
				);

				recorder.add(
					await promoteAndReport(database, env.BLOBS, claim, verification)
				);
			} catch {
				// A transient fetch or decode fault: hand the claim back so the next
				// pass retries promptly on the next cycle.
				recorder.add({
					uploadId: claim.uploadId,
					verdict: { kind: 'abandoned' }
				});
			}
		}
	);

	const applied = await recorder.settle();

	// One verify message can coalesce a whole push's deferrals, and a pass
	// claims a bounded chunk, so a larger backlog is left behind by design. A
	// truncated claim means rows remain; chain another pass to drain them now,
	// through the object's single-flight so this continuation and a concurrent
	// deferral collapse onto one message that claims each row once. Continue only
	// after a verdict actually applied: a batch whose reads or applies all fail (a
	// transient fault leaving every row pending) backs off to the cron,
	// avoiding a continuation that re-claims and re-fails the same rows.
	const isProgressed = applied > 0;

	if (truncated && isProgressed) {
		await server.requestVerificationPass();
	}
}

async function executeTenantMaintenanceMessage(
	logger: Logger,
	env: Env,
	tenant: TenantId,
	maintain: MaintainTenant
): Promise<MaintenanceQueueDecision> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	if (!(await tenantMaintenanceIsDue(database, tenant))) {
		return { action: 'ack' };
	}

	let result:
		| { readonly status: 'fulfilled'; readonly value: undefined }
		| { readonly status: 'rejected'; readonly reason: unknown };
	try {
		await maintain(logger, env, tenant);
		result = { status: 'fulfilled', value: undefined };
	} catch (error: unknown) {
		result = { status: 'rejected', reason: error };
	}

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
	logger: Logger,
	env: Env,
	tenant: TenantId,
	drain: DrainTenant
): Promise<MaintenanceQueueDecision> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const status = await tenantStatus(database, tenant);

	if (status === 'offboarding') {
		let result:
			| { readonly status: 'fulfilled'; readonly value: undefined }
			| { readonly status: 'rejected'; readonly reason: unknown };
		try {
			await drain(
				logger,
				env,
				tenant,
				offboardDrainChunk,
				offboardRoundsPerTick
			);
			result = { status: 'fulfilled', value: undefined };
		} catch (error: unknown) {
			result = { status: 'rejected', reason: error };
		}

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

async function tenantStatus(
	database: CronDatabase,
	tenant: TenantId
): Promise<typeof d1Schema.tenant.$inferSelect.status | undefined> {
	const row = await database
		.select({ status: d1Schema.tenant.status })
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, tenant))
		.get();

	return row?.status;
}

// The most-overdue active tenants. NULL `last_maintained_at` (never maintained) sorts
// first in SQLite ascending order, so a new tenant is picked up promptly; the id is
// the tiebreaker for a stable batch among equal timestamps.
function overdueActiveTenants(
	database: CronDatabase,
	batchSize: number
): Promise<{ readonly id: TenantId }[]> {
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

async function tenantMaintenanceIsDue(
	database: CronDatabase,
	tenant: TenantId
): Promise<boolean> {
	const row = await database
		.select({ id: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.leftJoin(
			d1Schema.tenantMaintenanceEligibility,
			eq(d1Schema.tenantMaintenanceEligibility.tenant, d1Schema.tenant.id)
		)
		.where(and(tenantMaintenanceDueCondition(), eq(d1Schema.tenant.id, tenant)))
		.limit(1)
		.get();

	return row !== undefined;
}

function tenantMaintenanceDueCondition() {
	const now = new Date();
	const nowIso = now.toISOString();
	const staleDate = new Date(now.getTime() - maintenanceEligibilityStaleMs);
	const staleBefore = staleDate.toISOString();

	return and(
		eq(d1Schema.tenant.status, 'active'),
		or(
			isNull(d1Schema.tenantMaintenanceEligibility.tenant),
			lte(d1Schema.tenantMaintenanceEligibility.reconciledAt, staleBefore),
			lte(d1Schema.tenantMaintenanceEligibility.nextWakeAt, nowIso)
		)
	);
}

// Stamps the maintained batch so the next tick advances to the next-oldest tenants.
// Stamped after the passes run and regardless of their outcome, so a failing tenant
// is not retried until the cycle comes round again, while a whole-tick crash before
// this leaves the batch unstamped and reprocesses it.
async function stampMaintained(
	database: CronDatabase,
	batch: readonly { readonly id: TenantId }[]
): Promise<void> {
	if (batch.length === 0) {
		return;
	}

	const maintainedDate = new Date();
	const maintainedAt = maintainedDate.toISOString();

	await database
		.update(d1Schema.tenant)
		.set({ lastMaintainedAt: maintainedAt })
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
	const authKeyRetirement = await settleAuthKeyRetirement(runAuthKeyRetirement);

	// Surface a garbage-collection failure first (its cleanup is the more
	// time-sensitive pass), then verification, then key retirement.
	for (const result of [gc, verify, authKeyRetirement]) {
		if (result.status === 'rejected') {
			throw result.reason;
		}
	}
}

// Runs the optional key-retirement pass after collection and verification have
// settled, capturing its outcome as a settled result so the caller can surface
// it alongside the other passes without short-circuiting them. An
// absent pass settles as a fulfilled no-op.
async function settleAuthKeyRetirement(
	runAuthKeyRetirement: (() => Promise<void>) | undefined
): Promise<PromiseSettledResult<void>> {
	if (runAuthKeyRetirement === undefined) {
		return { status: 'fulfilled', value: undefined };
	}

	try {
		await runAuthKeyRetirement();
		return { status: 'fulfilled', value: undefined };
	} catch (error) {
		return { status: 'rejected', reason: error };
	}
}

function runControlKeyRetirement(logger: Logger, env: Env): Promise<number> {
	const retireDate = new Date();
	const now = retireDate.toISOString();

	return retireScheduledControlKeys(
		drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
		now
	);
}

async function recordTenantPassOutcomes(
	database: CronDatabase,
	pass: TenantCronPass,
	tenants: readonly { readonly id: TenantId }[],
	results: readonly PromiseSettledResult<unknown>[]
): Promise<void> {
	const timestamp = new Date();
	const now = timestamp.toISOString();

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
	tenant: TenantId,
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
	tenant: TenantId,
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
