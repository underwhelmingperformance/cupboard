import { type Logger, rootLogger } from '@cupboard/logger';
import {
	type NixSha256HashString,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import {
	type NarVerification,
	verifyDecompressedNar
} from '../blob/nar-verify.ts';
import {
	type BlobStateUpsert,
	stagePromotedBlob
} from '../blob/promote-blob.ts';
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
import {
	batchNonEmpty,
	chunk,
	maxInClauseValues,
	maxOutgoingConnections
} from '../do/bulk.ts';
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

// One cron tick maintains at most this many tenants. The batch picks the
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
 * One hourly cron tick: the bounded tenant maintenance batch, then the global blob
 * reaper on its reserved budget after the fan-out, in its three passes (arm and
 * collect unreferenced blobs, then demote those whose object has gone missing). Each
 * pass runs independently of the others' outcome, and their failures are surfaced
 * together so neither a stalled batch nor a stalled reaper is silently swallowed.
 */
export async function runCronTick(logger: Logger, env: Env): Promise<void> {
	const failures: unknown[] = [];

	// Sequential, not concurrent: the reaper runs on its reserved budget after the
	// fan-out so a long fan-out cannot starve it, and each pass is isolated so one
	// stalling does not hold back the next.
	for (const pass of [
		() => runMaintenanceBatch(logger, env),
		() => runOffboardBatch(logger, env),
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

// Raised when one or more maintenance queue batches fail to send. The aggregate
// contains the underlying send errors, distinct from the tenant maintenance
// failures that cron also collects.
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

// Stores the demotion scan cursor in KV because it is cron state, not shared-blob
// data. A missing or empty value restarts the scan from the beginning.
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
 * Drains a bounded batch of offboarding tenants. Each tenant removes a bounded
 * batch of reference and presence rows through its Durable Object, which is the
 * only writer for those rows. The Worker removes a bounded batch of R2 objects.
 * After both stores are empty, the tenant is finalised as a scrubbed tombstone.
 * Maintenance selects only active tenants, so it cannot process the same tenant.
 * The function reports every tenant failure.
 */
export async function runOffboardBatch(
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
		const hasRemainingObjects = await hasRemainingTenantObjects(
			env,
			id,
			drainLimit
		);

		if (isDrained && !hasRemainingObjects) {
			await finaliseTenant(env, id);
			return;
		}
	}
}

// Deletes a bounded batch of a tenant's namespaced R2 objects, returning whether
// more remain so the drain runs again next tick. Listing from the prefix each tick
// (the deleted keys gone) makes progress without a persisted cursor.
async function hasRemainingTenantObjects(
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

// Finalises a tenant after all data has been drained. First purge its Durable
// Object storage. Then write the terminal `offboarded` registry tombstone,
// remove its usage row, and delete its membership marker. Repeating these steps
// after an interruption is safe.
async function finaliseTenant(env: Env, id: TenantId): Promise<void> {
	await tenantServer(env, id).purgeStorage();

	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	await finaliseOffboardedTenant(database, id);
	await deleteTenantMember(env.TENANT_CACHE, id);
}

/**
 * Maintains the active tenants with the oldest `last_maintained_at` values, then
 * updates that timestamp for the selected batch. Successive ticks therefore
 * rotate through the fleet. The function reports every tenant failure and still
 * advances the selected timestamps so one failing tenant does not prevent later
 * tenants from running.
 */
export async function runMaintenanceBatch(
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

// How many times the promotion batch retries a D1 fault before falling back to
// per-statement execution. The shape mirrors the recorder's retry loop.
const promotionBatchAttempts = 3;
const promotionBatchRetryDelayMs = 500;

/**
 * Buffers completed verdicts and records them incrementally. Only one
 * `recordVerifications` RPC runs at a time, and verdicts completed during that
 * call form the next batch. If the invocation stops, it loses at most the active
 * batch and the buffer. A failed RPC preserves its batch and makes
 * `finishRecording` reject. The queue can then retry the idempotent writes.
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
				// against a Durable Object that is down. `finishRecording` reports
				// the failure to the caller.
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
	async finishRecording(): Promise<number> {
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

// A claim whose R2 promotion has succeeded. The pass applies its `blob_state`
// upsert as part of one batch, then records `onSuccess`. If the batch fails, it
// records `onFailure` instead.
interface PendingPromotion {
	readonly upsert: BlobStateUpsert;
	readonly onSuccess: VerificationResult;
	readonly onFailure: VerificationResult;
}

// Either a verdict to record now, or a promotion whose upsert the pass batches.
type PromotionOutcome =
	| { readonly kind: 'verdict'; readonly result: VerificationResult }
	| { readonly kind: 'promotion'; readonly promotion: PendingPromotion };

// Verifies and promotes one claimed upload. If R2 promotion succeeds, return the
// D1 upsert for the caller's batch. If R2 promotion fails, return the verified
// result without an upsert; the Durable Object will perform promotion while
// applying that result.
async function stagePromotionForClaim(
	database: CronDatabase,
	blobs: R2Bucket,
	claim: PendingVerification,
	verification: NarVerification
): Promise<PromotionOutcome> {
	const fallback: VerificationResult = {
		uploadId: claim.uploadId,
		verdict: { kind: 'verified', verification }
	};

	if (
		!verification.ok ||
		verification.fileHash === undefined ||
		verification.fileSize === undefined
	) {
		return { kind: 'verdict', result: fallback };
	}

	try {
		const { upsert } = await stagePromotedBlob(
			database,
			blobs,
			claim.r2Key,
			{ narHash: claim.narHash, narSize: claim.narSize },
			{ fileHash: verification.fileHash, fileSize: verification.fileSize }
		);

		return {
			kind: 'promotion',
			promotion: {
				upsert,
				onSuccess: { uploadId: claim.uploadId, verdict: { kind: 'promoted' } },
				onFailure: fallback
			}
		};
	} catch {
		return { kind: 'verdict', result: fallback };
	}
}

// Applies the collected `blob_state` upserts in one D1 batch, with retries for
// transient failures and a per-statement fallback after the retries. Each claim
// receives a success verdict if its upsert succeeds and a failure verdict if it
// fails. The upserts are idempotent `onConflictDoUpdate` statements, so both
// retry paths are safe.
async function recordPromotionBatch(
	logger: Logger,
	database: CronDatabase,
	recorder: VerdictRecorder,
	promotions: readonly PendingPromotion[]
): Promise<void> {
	if (promotions.length === 0) {
		return;
	}

	const upserts = promotions.map((promotion) => promotion.upsert);

	// Attempt the batch with retries, mirroring the recorder's retry shape.
	let wasBatchApplied = false;

	for (let attempt = 0; attempt < promotionBatchAttempts; attempt += 1) {
		if (attempt > 0) {
			await new Promise((resolve) =>
				setTimeout(resolve, promotionBatchRetryDelayMs)
			);
		}

		try {
			await batchNonEmpty(database, upserts);
			wasBatchApplied = true;
			break;
		} catch (error) {
			logger.warn('promotion batch not applied', {
				count: upserts.length,
				attempt: attempt + 1,
				error
			});
		}
	}

	if (wasBatchApplied) {
		for (const promotion of promotions) {
			recorder.add(promotion.onSuccess);
		}

		return;
	}

	// Retries exhausted: fall back per-statement so one poisoned upsert cannot
	// sink its batch-mates. Each is individually idempotent, and the concurrency
	// stays bounded so the fallback does not fan a whole pass's statements at a
	// database that just refused the batch.
	const applied = await mapWithConcurrency(
		upserts,
		maxOutgoingConnections,
		async (upsert) => {
			try {
				await upsert.run();
				return true;
			} catch {
				return false;
			}
		}
	);

	for (const [index, promotion] of promotions.entries()) {
		recorder.add(
			applied[index] === true ? promotion.onSuccess : promotion.onFailure
		);
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

	// Pin all claimed hashes immediately: clear any reaper grace timer so the
	// reaper cannot delete an armed row (and its canonical R2 object) before the
	// pass-end upsert re-arms it via `delete_after = NULL`. The pin only affects
	// rows that already exist; missing rows are fine (their upsert inserts later).
	await pinClaimedNarHashes(
		database,
		claims.map((claim) => claim.narHash)
	);

	const reuseClaims = claims.filter((claim) => claim.reuse);
	const freshClaims = claims.filter((claim) => !claim.reuse);

	// Reuse rows need no decode: their bytes are the shared canonical object,
	// verified when it was first promoted. Promote each (a canonical head) ahead
	// of the decodes, so the cheap rows are never hostage to the expensive ones,
	// and collect their `blob_state` upserts to settle in one D1 batch.
	const reusePromotions: PendingPromotion[] = [];

	await mapWithConcurrency(
		reuseClaims,
		maxOutgoingConnections,
		async (claim) => {
			try {
				const { upsert } = await stagePromotedBlob(
					database,
					env.BLOBS,
					claim.r2Key,
					{ narHash: claim.narHash, narSize: claim.narSize },
					undefined
				);
				reusePromotions.push({
					upsert,
					onSuccess: {
						uploadId: claim.uploadId,
						verdict: { kind: 'promoted' }
					},
					// The canonical head succeeded, so a claim whose upsert ultimately
					// fails still settles: the verified verdict has the settle run its
					// own promote on the DO thread.
					onFailure: {
						uploadId: claim.uploadId,
						verdict: { kind: 'verified', verification: { ok: true } }
					}
				});
			} catch (error) {
				// A vanished canonical object cannot reappear, so report it gone and
				// let the settle answer the waiter without waiting for the commit
				// timeout. Anything else is transient; hand the claim back for a
				// prompt retry.
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

	await recordPromotionBatch(logger, database, recorder, reusePromotions);

	const freshPromotions: PendingPromotion[] = [];

	await mapWithConcurrency(
		freshClaims,
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

				const outcome = await stagePromotionForClaim(
					database,
					env.BLOBS,
					claim,
					verification
				);

				if (outcome.kind === 'promotion') {
					freshPromotions.push(outcome.promotion);
					return;
				}

				recorder.add(outcome.result);
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

	await recordPromotionBatch(logger, database, recorder, freshPromotions);

	const applied = await recorder.finishRecording();

	// One verification message can combine all deferrals from a push, while each
	// pass claims only a bounded chunk. Request another pass only when rows remain
	// and at least one verdict was applied. If no verdict was applied, leave the
	// retry to cron so a continuation does not repeatedly claim the same rows.
	const isProgressed = applied > 0;

	if (truncated && isProgressed) {
		await server.requestVerificationPass();
	}
}

// Clears the reaper grace timer on any claimed hashes that already have a
// `blob_state` row, so the reaper cannot evict a row between the claim and the
// pass-end upsert that would re-arm it. Missing rows are unaffected.
async function pinClaimedNarHashes(
	database: CronDatabase,
	narHashes: readonly NixSha256HashString[]
): Promise<void> {
	if (narHashes.length === 0) {
		return;
	}

	const chunks = chunk(narHashes, maxInClauseValues);

	await batchNonEmpty(
		database,
		chunks.map((batch) =>
			database
				.update(d1Schema.blobState)
				.set({ deleteAfter: sql`null` })
				.where(inArray(d1Schema.blobState.narHash, batch))
		)
	);
}

async function executeTenantMaintenanceMessage(
	logger: Logger,
	env: Env,
	tenant: TenantId,
	maintain: MaintainTenant
): Promise<MaintenanceQueueDecision> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	if (!(await isTenantMaintenanceDue(database, tenant))) {
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

async function isTenantMaintenanceDue(
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
	const nowIso = isoTimestamp(now);
	const staleBefore = isoTimestamp(
		new Date(now.getTime() - maintenanceEligibilityStaleMs)
	);

	return and(
		eq(d1Schema.tenant.status, 'active'),
		or(
			isNull(d1Schema.tenantMaintenanceEligibility.tenant),
			lte(d1Schema.tenantMaintenanceEligibility.reconciledAt, staleBefore),
			lte(d1Schema.tenantMaintenanceEligibility.nextWakeAt, nowIso)
		)
	);
}

/**
 * Builds the UPDATE stamping one chunk of tenants' `last_maintained_at`.
 * Exported for the D1 parameter guard test.
 */
export function buildStampMaintainedStatement(
	database: CronDatabase,
	tenantIds: readonly TenantId[],
	maintainedAt: IsoTimestamp
) {
	return database
		.update(d1Schema.tenant)
		.set({ lastMaintainedAt: maintainedAt })
		.where(inArray(d1Schema.tenant.id, tenantIds));
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

	const maintainedAt = isoTimestamp(new Date());

	const tenantIds = batch.map((entry) => entry.id);
	const chunks = chunk(tenantIds, maxInClauseValues);
	const queries = chunks.map((ids) =>
		buildStampMaintainedStatement(database, ids, maintainedAt)
	);

	await batchNonEmpty(database, queries);
}

/**
 * Runs the maintenance passes for one tenant. Each pass runs independently, so
 * a verification failure does not prevent collection or key retirement. If
 * several passes fail, the function reports the garbage-collection failure
 * first because that cleanup is more time-sensitive.
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

// Runs the optional key-retirement pass after collection and verification
// finish. Returning a settled result lets the caller report its failure with the
// other pass failures. An omitted callback produces a fulfilled result.
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
	return retireScheduledControlKeys(
		drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
		isoTimestamp(new Date())
	);
}

async function recordTenantPassOutcomes(
	database: CronDatabase,
	pass: TenantCronPass,
	tenants: readonly { readonly id: TenantId }[],
	results: readonly PromiseSettledResult<unknown>[]
): Promise<void> {
	const now = isoTimestamp(new Date());

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
	now: IsoTimestamp
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
	now: IsoTimestamp
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
