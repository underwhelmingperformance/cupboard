import { type Logger, rootLogger } from '@cupboard/logger';
import { type TenantId, tenantIdSchema } from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import { narVerifyBudgetMs, verifyStoredNar } from '../blob/nar-verify.ts';
import { retireScheduledControlKeys } from '../control/control-key-store.ts';
import {
	deleteTenantMember,
	refreshTenantMembership
} from '../control/tenant-membership.ts';
import { finaliseOffboardedTenant } from '../control/tenant-registry.ts';
import { withAppMutationAdmission } from '../db/app-mutation-admission.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	BlobReaperService,
	type CasReferenceDemoter,
	type CasReferenceDemotion,
	type DemoteCursor,
	type NarInfoDemoter,
	type NarInfoDemotion,
	type ObjectReaperPhase
} from '../do/blob-reaper-service.ts';
import { batchNonEmpty, chunk, maxInClauseValues } from '../do/bulk.ts';
import type { VerificationRecordRpcResult } from '../do/server.ts';
import {
	ActiveVerificationClaims,
	raceVerificationOperation,
	withRenewedVerificationClaim
} from '../do/verification-claim-lease.ts';
import {
	type PendingVerificationBatch,
	type VerificationResult
} from '../do/verification-service.ts';
import {
	SubrequestTimeoutError,
	UploadedObjectNotFoundError
} from '../errors.ts';
import {
	blobReaperBatchSize,
	verifyClaimBatchSize,
	verifyClaimMaxNarBytes
} from '../http/http.ts';

import { tenantServer } from './durable-object.ts';

// Rotate through active tenants in bounded batches ordered by
// `last_maintained_at`.
const maintenanceBatchSize = 100;
const maintenanceConcurrency = 4;
const maintenanceEligibilityStaleMs = 6 * 60 * 60 * 1000;
export const verificationConsumerBudgetMs = 14 * 60 * 1000;

// Bound offboarding by tenants, rounds, and objects per round. The object chunk
// matches R2's 1,000-key delete limit.
const offboardTenantsPerTick = 10;
const offboardRoundsPerTick = 10;
const offboardDrainChunk = 1000;

const demoteCursorKey = 'reaper:demote-cursor';
const casDemoteCursorKey = 'reaper:cas-demote-cursor';

type CronDatabase = DrizzleD1Database<typeof d1Schema>;
type TenantCronPass =
	typeof d1Schema.tenantMaintenanceFailure.$inferSelect.pass;
type MaintainTenant = (logger: Logger, env: Env, id: TenantId) => Promise<void>;
type MigrateCacheCatalogue = (env: Env, id: TenantId) => Promise<void>;
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
	readonly migrateCacheCatalogue?: MigrateCacheCatalogue;
	readonly maintainTenant?: MaintainTenant;
	readonly verifyTenant?: MaintainTenant;
	readonly drainTenant?: DrainTenant;
	readonly runBlobReaper?: (
		logger: Logger,
		env: Env,
		phase: ObjectReaperPhase
	) => Promise<unknown>;
	readonly runCasReaper?: (
		logger: Logger,
		env: Env,
		phase: ObjectReaperPhase
	) => Promise<unknown>;
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
const objectReaperPhaseSchema = z.enum([
	'delete-existing',
	'recover',
	'arm',
	'collect',
	'delete-collected'
]);

const maintenanceQueueMessageSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('cache-catalogue-migration'),
		tenant: tenantIdSchema
	}),
	z.object({ kind: z.literal('tenant-maintenance'), tenant: tenantIdSchema }),
	z.object({ kind: z.literal('tenant-verify'), tenant: tenantIdSchema }),
	z.object({ kind: z.literal('offboard'), tenant: tenantIdSchema }),
	z.object({
		kind: z.literal('blob-reaper'),
		phase: objectReaperPhaseSchema.optional()
	}),
	z.object({
		kind: z.literal('cas-reaper'),
		phase: objectReaperPhaseSchema.optional()
	}),
	z.object({ kind: z.literal('blob-demote') }),
	z.object({ kind: z.literal('cas-demote') }),
	z.object({ kind: z.literal('control-key-retirement') })
]);

export type MaintenanceQueueMessage =
	| { readonly kind: 'cache-catalogue-migration'; readonly tenant: TenantId }
	| { readonly kind: 'tenant-maintenance'; readonly tenant: TenantId }
	| { readonly kind: 'tenant-verify'; readonly tenant: TenantId }
	| { readonly kind: 'offboard'; readonly tenant: TenantId }
	| { readonly kind: 'blob-reaper'; readonly phase?: ObjectReaperPhase }
	| { readonly kind: 'cas-reaper'; readonly phase?: ObjectReaperPhase }
	| { readonly kind: 'blob-demote' }
	| { readonly kind: 'cas-demote' }
	| { readonly kind: 'control-key-retirement' };

/**
 * Runs every maintenance pass in sequence and reports their failures together.
 * Reaper passes run after tenant fan-out so tenant work cannot consume the
 * subrequest budget reserved for global cleanup.
 */
export async function runCronTick(logger: Logger, env: Env): Promise<void> {
	const failures: unknown[] = [];

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
	// Refresh membership before sending queue messages. New tenants and missing
	// markers must not depend on successful queue delivery.
	await refreshTenantMembership(env);

	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const catalogueTenants = await incompleteCacheCatalogueTenants(
		database,
		maintenanceBatchSize
	);
	const maintenanceTenants = await overdueActiveTenants(
		database,
		maintenanceBatchSize
	);
	const offboardTenants = await selectOffboardTenants(
		database,
		offboardTenantsPerTick
	);
	const messages: MaintenanceQueueMessage[] = [
		...catalogueTenants.map(({ id }): MaintenanceQueueMessage => ({
			kind: 'cache-catalogue-migration',
			tenant: id
		})),
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
	// Attempt every chunk so one failed tenant batch does not prevent global
	// maintenance messages from being enqueued. Report all send failures together.
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
		return await withAppMutationAdmission(env.CUPBOARD_DB, () =>
			executeAdmittedMaintenanceQueueMessage(logger, env, message, options)
		);
	} catch (error) {
		return {
			action: 'retry',
			delaySeconds: queueRetryDelaySeconds,
			reason: errorSummary(error)
		};
	}
}

async function executeAdmittedMaintenanceQueueMessage(
	logger: Logger,
	env: Env,
	message: MaintenanceQueueMessage,
	options: ExecuteMaintenanceQueueOptions
): Promise<MaintenanceQueueDecision> {
	switch (message.kind) {
		case 'cache-catalogue-migration': {
			await (options.migrateCacheCatalogue ?? migrateCacheCatalogue)(
				env,
				message.tenant
			);
			return { action: 'ack' };
		}
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
			await (options.verifyTenant ?? verifyTenant)(logger, env, message.tenant);
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
			await (options.runBlobReaper ?? runBlobReaperPhase)(
				logger,
				env,
				message.phase ?? 'delete-existing'
			);
			return { action: 'ack' };
		}
		case 'cas-reaper': {
			await (options.runCasReaper ?? runCasReaperPhase)(
				logger,
				env,
				message.phase ?? 'delete-existing'
			);
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
	readonly phase?: ObjectReaperPhase;
	readonly tenant?: string;
} {
	if ('tenant' in message) {
		return { kind: message.kind, tenant: message.tenant };
	}
	if (message.kind === 'blob-reaper' || message.kind === 'cas-reaper') {
		return {
			kind: message.kind,
			phase: message.phase ?? 'delete-existing'
		};
	}

	return { kind: message.kind };
}

/**
 * Collects unreferenced canonical NAR objects. This runs on the Worker because
 * tenant Durable Objects cannot see reference edges owned by other tenants.
 */
export async function runBlobReaper(
	logger: Logger,
	env: Env,
	batchSize: number = blobReaperBatchSize,
	continueReaper: (phase: ObjectReaperPhase) => Promise<void> = (phase) =>
		sendQueueMessages(env.MAINTENANCE_QUEUE, [{ kind: 'blob-reaper', phase }]),
	phase: ObjectReaperPhase = 'delete-existing'
): Promise<number> {
	const result = await blobReaper(env).reapBlobs(
		logger,
		new Date(),
		batchSize,
		phase
	);

	if (result.continuation !== undefined) {
		await continueReaper(result.continuation);
	}

	return result.deleted;
}

export async function runCasReaper(
	logger: Logger,
	env: Env,
	batchSize: number = blobReaperBatchSize,
	continueReaper: (phase: ObjectReaperPhase) => Promise<void> = (phase) =>
		sendQueueMessages(env.MAINTENANCE_QUEUE, [{ kind: 'cas-reaper', phase }]),
	phase: ObjectReaperPhase = 'delete-existing'
): Promise<number> {
	const result = await blobReaper(env).reapCasObjects(
		logger,
		new Date(),
		batchSize,
		phase
	);

	if (result.continuation !== undefined) {
		await continueReaper(result.continuation);
	}

	return result.deleted;
}

function runBlobReaperPhase(
	logger: Logger,
	env: Env,
	phase: ObjectReaperPhase
): Promise<number> {
	return runBlobReaper(logger, env, blobReaperBatchSize, undefined, phase);
}

function runCasReaperPhase(
	logger: Logger,
	env: Env,
	phase: ObjectReaperPhase
): Promise<number> {
	return runCasReaper(logger, env, blobReaperBatchSize, undefined, phase);
}

/**
 * Scans a bounded page of `blob_state` for missing canonical objects. It removes
 * stale rows and asks each tenant Durable Object to retire the affected narinfos.
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

// An empty cursor restarts the scan from the first shared blob.
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

// Each tenant Durable Object remains the single writer for its narinfo objects.
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
 * Drains a bounded batch of offboarding tenants. Each tenant Durable Object
 * removes its reference rows, while the Worker removes namespaced R2 objects.
 * The registry becomes an offboarded tombstone only after both stores are empty.
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

// Drain several bounded chunks per tick, then finalise only when both the tenant
// Durable Object and its R2 prefix are empty.
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

// Restart each listing at the tenant prefix. Deleted keys disappear, so repeated
// bounded passes make progress without a cursor.
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

// Purge Durable Object storage before writing the terminal registry tombstone.
// Each step is safe to repeat after an interruption.
async function finaliseTenant(env: Env, id: TenantId): Promise<void> {
	await tenantServer(env, id).purgeStorage();

	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	await finaliseOffboardedTenant(database, id);
	await deleteTenantMember(env.TENANT_CACHE, id);
}

/**
 * Maintains the oldest active tenant batch. It advances every selected
 * `last_maintained_at` value even when a tenant fails so later tenants are not
 * starved.
 */
export async function runMaintenanceBatch(
	logger: Logger,
	env: Env,
	batchSize: number = maintenanceBatchSize,
	maintain: MaintainTenant = maintainTenant
): Promise<void> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const batch = await overdueActiveTenants(database, batchSize);

	// Bound the fan-out and isolate each tenant's failure from the rest of the
	// batch.
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

function migrateCacheCatalogue(env: Env, id: TenantId): Promise<void> {
	return tenantServer(env, id).migrateCacheCatalogue(id);
}

// Bound concurrent decoding so one tenant does not monopolise the queue
// consumer isolate.
const verifyDecodeConcurrency = 4;

// Retry briefly while claim leases are still valid, then fail the queue message
// so it can be redelivered.
const recordAttempts = 3;
const recordRetryDelayMs = 500;
const verificationCleanupMarginMs = 1000;

class VerificationPassDeadline {
	private readonly controller = new AbortController();
	private readonly workDeadline: number;
	private readonly timer: ReturnType<typeof setTimeout>;

	constructor(budgetMs: number) {
		const cleanupMargin = Math.min(
			verificationCleanupMarginMs,
			Math.floor(budgetMs / 10)
		);
		this.workDeadline = Date.now() + budgetMs - cleanupMargin;
		this.timer = setTimeout(
			() => {
				this.controller.abort(new SubrequestTimeoutError('nar.verify.batch'));
			},
			Math.max(0, this.workDeadline - Date.now())
		);
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	remainingWorkMs(): number {
		this.signal.throwIfAborted();

		return Math.max(1, this.workDeadline - Date.now());
	}

	dispose(): void {
		clearTimeout(this.timer);
	}
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms === 0) {
		signal?.throwIfAborted();
		return;
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const delay = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
	});

	try {
		await raceVerificationOperation(delay, signal);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Records completed verdicts incrementally through one RPC at a time. Verdicts
 * completed during an RPC form the next batch. A failed RPC keeps its batch at
 * the front of the buffer and makes `finishRecording` reject so the queue can
 * redeliver the idempotent writes.
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
		private readonly retryDelayMs = recordRetryDelayMs,
		private readonly signal?: AbortSignal
	) {}

	private async flush(): Promise<void> {
		while (this.buffer.length > 0) {
			const batch = this.buffer;
			this.buffer = [];

			try {
				this.applied += await this.recordWithRetry(batch);
			} catch (error) {
				// Preserve order and stop flushing after a failure. The queue retry will
				// redeliver the idempotent verdicts.
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
			this.signal?.throwIfAborted();

			if (attempt > 0) {
				await abortableDelay(this.retryDelayMs, this.signal);
			}

			try {
				return await this.record(batch);
			} catch (error) {
				lastError = error;
				this.logger.warn('verification verdicts not recorded', {
					kind: 'fresh',
					count: batch.length,
					attempt: attempt + 1,
					reason: 'record-rpc-failed'
				});
			}
		}

		throw lastError;
	}

	add(result: VerificationResult): void {
		this.signal?.throwIfAborted();
		this.buffer.push(result);

		if (this.failure === undefined) {
			this.flushing ??= this.flush();
		}
	}

	/**
	 * Waits until all buffered verdicts are recorded. A persistent RPC failure
	 * rejects the queue message for redelivery.
	 */
	async finishRecording(): Promise<number> {
		// A verdict added during a flush starts another flush. Wait for each
		// successor until the buffer is quiescent.
		while (this.flushing !== undefined) {
			await this.flushing;
		}

		if (this.failure !== undefined) {
			throw this.failure.error;
		}

		this.signal?.throwIfAborted();

		return this.applied;
	}
}

// Claim a bounded batch, then fetch and decode staging objects in the queue
// consumer so CPU-bound NAR verification does not occupy the Durable Object.
// The Durable Object applies each verdict only while this pass owns the claim.
// Transient failures release the claim; a missing staging object is terminal.
export async function verifyTenant(
	logger: Logger,
	env: Env,
	id: TenantId,
	batchSize: number = verifyClaimBatchSize,
	maxNarBytes: number = verifyClaimMaxNarBytes,
	budgetMs: number = verificationConsumerBudgetMs
): Promise<void> {
	const deadline = new VerificationPassDeadline(budgetMs);

	try {
		const server = tenantServer(env, id);
		let batch: PendingVerificationBatch | undefined;

		try {
			const budgetedClaim = server.claimVerificationBatchWithinBudget(
				batchSize,
				maxNarBytes,
				deadline.remainingWorkMs()
			);
			const claimResult = await raceVerificationOperation(
				Promise.resolve(budgetedClaim),
				deadline.signal
			);

			if (claimResult.kind === 'timed-out') {
				throw new SubrequestTimeoutError('verification.claim');
			}

			batch = claimResult.batch;
		} catch {
			deadline.signal.throwIfAborted();
			const compatibleBatch = (await raceVerificationOperation(
				server.claimVerificationBatch(
					batchSize,
					maxNarBytes,
					deadline.remainingWorkMs()
				),
				deadline.signal
			)) as PendingVerificationBatch | Omit<PendingVerificationBatch, 'owner'>;

			if (!('owner' in compatibleBatch)) {
				await raceVerificationOperation(
					server.requestVerificationPass(),
					deadline.signal
				);
				return;
			}

			batch = compatibleBatch;
		}

		const { claims, owner, truncated } = batch;
		const activeClaims = new ActiveVerificationClaims(
			claims.map((claim) => claim.uploadId)
		);
		const applied = await withRenewedVerificationClaim(
			async () => {
				const wereClaimsRenewed = await raceVerificationOperation(
					server.renewVerificationClaims(owner, activeClaims.remaining()),
					deadline.signal
				);

				if (!wereClaimsRenewed) {
					throw new Error(
						'The verification claim is no longer owned by this pass.'
					);
				}
			},
			async (signal) => {
				// Record verdicts as they complete so waiters do not depend on slower uploads
				// and an interrupted invocation keeps earlier progress.
				const recorder = new VerdictRecorder(
					logger.with({ job: 'verify-verdicts' }),
					async (results) => {
						const recordRpc = server.recordVerificationsWithinBudget(
							owner,
							results,
							deadline.remainingWorkMs()
						);
						const result = await raceVerificationOperation(
							Promise.resolve<VerificationRecordRpcResult>(recordRpc),
							signal
						);

						if (result.kind === 'timed-out') {
							throw new SubrequestTimeoutError('verification.record');
						}

						signal.throwIfAborted();

						activeClaims.recorded(results.map((result) => result.uploadId));

						return result.applied;
					},
					recordAttempts,
					recordRetryDelayMs,
					signal
				);

				const reuseClaims = claims.filter((claim) => claim.reuse);
				const freshClaims = claims.filter((claim) => !claim.reuse);

				// Reuse rows need no decode. The Durable Object checks the canonical object
				// and performs every shared write while it still owns the claim.
				for (const claim of reuseClaims) {
					signal.throwIfAborted();
					recorder.add({
						uploadId: claim.uploadId,
						verdict: { kind: 'verified', verification: { ok: true } }
					});
				}

				await mapWithConcurrency(
					freshClaims,
					verifyDecodeConcurrency,
					async (claim) => {
						try {
							signal.throwIfAborted();
							const verification = await verifyStoredNar(
								env.BLOBS,
								claim.r2Key,
								{
									narHash: claim.narHash,
									narSize: claim.narSize
								},
								narVerifyBudgetMs,
								signal
							);
							signal.throwIfAborted();

							recorder.add({
								uploadId: claim.uploadId,
								verdict: { kind: 'verified', verification }
							});
						} catch (error) {
							if (signal.aborted) {
								throw error;
							}
							if (error instanceof UploadedObjectNotFoundError) {
								recorder.add({
									uploadId: claim.uploadId,
									verdict: { kind: 'missing' }
								});
								return;
							}

							// Release a transient fetch or decode failure for the next pass.
							logger.warn('pending upload verification failed', {
								kind: 'fresh',
								reason: 'verification-failed'
							});
							recorder.add({
								uploadId: claim.uploadId,
								verdict: { kind: 'abandoned' }
							});
						}
					}
				);

				return recorder.finishRecording();
			},
			undefined,
			deadline.signal
		);

		// Continue a truncated claim only after applying a verdict. With no progress,
		// leave retry to cron instead of reclaiming the same rows immediately.
		const isProgressed = applied > 0;

		if (truncated && isProgressed) {
			await raceVerificationOperation(
				server.requestVerificationPass(),
				deadline.signal
			);
		}
	} finally {
		deadline.dispose();
	}
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

function incompleteCacheCatalogueTenants(
	database: CronDatabase,
	batchSize: number
): Promise<{ readonly id: TenantId }[]> {
	return database
		.select({ id: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.where(
			and(
				inArray(d1Schema.tenant.status, ['active', 'suspended']),
				isNull(d1Schema.tenant.cacheCatalogueVersion)
			)
		)
		.orderBy(asc(d1Schema.tenant.id))
		.limit(batchSize)
		.all();
}

// SQLite sorts NULL first in ascending order, so new tenants precede tenants
// with a maintenance timestamp. Tenant ID provides a stable tie-breaker.
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
 * Builds one bounded update for the selected tenants. The caller chunks the
 * full batch to stay within D1's parameter limit.
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

// Stamp every selected tenant after its pass, including failures, so one failing
// tenant cannot starve the fleet. A crash before this write repeats the batch.
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
 * Runs garbage collection, verification, and optional key retirement
 * independently. If several fail, reports the garbage-collection failure first.
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

	for (const result of [gc, verify, authKeyRetirement]) {
		if (result.status === 'rejected') {
			throw result.reason;
		}
	}
}

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
