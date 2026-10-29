import { type Logger, rootLogger } from '@cupboard/logger';
import {
	nixSha256HashSchema,
	type NixSha256HashString,
	storePathHashSchema,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import type { UploadId } from '@cupboard/protocol/upload';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import {
	and,
	asc,
	eq,
	gt,
	inArray,
	isNull,
	lte,
	ne,
	or,
	sql
} from 'drizzle-orm';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import {
	ConnectionLimitedBucket,
	type R2ObjectStore
} from '../blob/connection-limited-bucket.ts';
import { type NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import {
	type DeclaredNarVerification,
	type NarVerifyProgress,
	narVerifyProgress,
	verifyAndWriteStoredNar,
	verifyStoredNar
} from '../blob/nar-verify.ts';
import { r2ErrorCode } from '../blob/r2-errors.ts';
import { retireScheduledControlKeys } from '../control/control-key-store.ts';
import {
	controlRefreshPrunePageSize,
	pruneControlRefreshSessions
} from '../control/control-refresh-sessions.ts';
import {
	controlSubjectNoncePrunePageSize,
	pruneControlSubjectNonces
} from '../control/control-subject-nonces.ts';
import { writableControlDatabase } from '../control/database.ts';
import {
	enqueueLocalStepWakes,
	localStepWakeBatchSize,
	type LocalStepWakeMessage,
	localStepWakeMessages,
	selectLocalStepWakes,
	wakeLocalStepTenants
} from '../control/local-step.ts';
import {
	deleteTenantMember,
	refreshTenantMembership
} from '../control/tenant-membership.ts';
import { finaliseOffboardedTenant } from '../control/tenant-registry.ts';
import { cacheIdSchema } from '../db/cache.ts';
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
import { batchNonEmpty, maxOutgoingConnections } from '../do/bulk.ts';
import { type JsonValueList, jsonValueLists } from '../do/json-list.ts';
import { withOperationCost } from '../do/operation-cost.ts';
import { logPromotionAttemptFailed } from '../do/promotion-record.ts';
import type {
	CupboardServer,
	VerificationClaimRpcResult,
	VerificationRecordRpcResult
} from '../do/server.ts';
import {
	holdSubrequests,
	type SubrequestHold
} from '../do/subrequest-slice.ts';
import {
	ActiveVerificationClaims,
	raceVerificationOperation,
	withRenewedVerificationClaim
} from '../do/verification-claim-lease.ts';
import {
	type CanonicalWrite,
	type CanonicalWriteReservation,
	type PendingVerification,
	type PendingVerificationBatch,
	type VerificationResult
} from '../do/verification-service.ts';
import { PublicationRecoveryExpiredError } from '../errors.ts';
import {
	SubrequestTimeoutError,
	UploadedObjectNotFoundError
} from '../errors.ts';
import {
	blobReaperBatchSize,
	narObjectKey,
	verifyClaimBatchSize,
	verifyClaimMaxNarBytes
} from '../http/http.ts';
import { logMethodFinished } from '../observability/logging.ts';
import { queueSendBatchSize } from '../policy/queues.ts';
import { subrequestsPerInvocation } from '../policy/subrequests.ts';
import {
	isDurableObjectCallRetryable,
	isDurableObjectOverloaded
} from '../runtime-fault.ts';

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
	readonly runControlSessionPruning?: (
		logger: Logger,
		env: Env
	) => Promise<unknown>;
	readonly wakeLocalStepTenants?: (
		logger: Logger,
		env: Env,
		tenants: readonly TenantId[]
	) => Promise<void>;
}

const maxStoredErrorLength = 4096;
const queueRetryDelaySeconds = 60;
const narInfoRefreshTenantsPerPage = 50;
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
	z.object({
		kind: z.literal('narinfo-refresh'),
		narHash: nixSha256HashSchema,
		afterTenant: tenantIdSchema.optional()
	}),
	z.object({
		kind: z.literal('narinfo-refresh-tenant'),
		tenant: tenantIdSchema,
		narHash: nixSha256HashSchema,
		after: z
			.object({ cacheId: cacheIdSchema, storePathHash: storePathHashSchema })
			.optional()
	}),
	z.object({ kind: z.literal('cas-demote') }),
	z.object({ kind: z.literal('control-key-retirement') }),
	z.object({ kind: z.literal('control-session-pruning') }),
	z.object({
		kind: z.literal('local-step'),
		tenants: z.array(tenantIdSchema).min(1).max(localStepWakeBatchSize)
	}),
	// The hourly wake that earlier builds enqueued. Messages of this kind can be
	// in the queue when this build deploys. They are acknowledged without work,
	// because each tick now enqueues `local-step` messages.
	z.object({ kind: z.literal('local-step-sweep') })
]);

export type MaintenanceQueueMessage =
	| LocalStepWakeMessage
	| { readonly kind: 'cache-catalogue-migration'; readonly tenant: TenantId }
	| { readonly kind: 'tenant-maintenance'; readonly tenant: TenantId }
	| { readonly kind: 'tenant-verify'; readonly tenant: TenantId }
	| { readonly kind: 'offboard'; readonly tenant: TenantId }
	| { readonly kind: 'blob-reaper'; readonly phase?: ObjectReaperPhase }
	| { readonly kind: 'cas-reaper'; readonly phase?: ObjectReaperPhase }
	| { readonly kind: 'blob-demote' }
	| {
			readonly kind: 'narinfo-refresh';
			readonly narHash: NixSha256HashString;
			readonly afterTenant?: TenantId;
	  }
	| {
			readonly kind: 'narinfo-refresh-tenant';
			readonly tenant: TenantId;
			readonly narHash: NixSha256HashString;
			readonly after?: {
				readonly cacheId: ReturnType<typeof cacheIdSchema.parse>;
				readonly storePathHash: ReturnType<typeof storePathHashSchema.parse>;
			};
	  }
	| { readonly kind: 'cas-demote' }
	| { readonly kind: 'control-key-retirement' }
	| { readonly kind: 'control-session-pruning' }
	| { readonly kind: 'local-step-sweep' };

/**
Runs every maintenance pass in sequence and reports their failures together.
Reaper passes run after tenant fan-out so tenant work cannot consume the
subrequest budget reserved for global cleanup.
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
		() => runControlKeyRetirement(logger, env),
		() => runControlSessionPruning(logger, env),
		() => enqueueLocalStepWakes(env)
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
	const localStepWakes = await selectLocalStepWakeMessages(env);
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
		{ kind: 'control-key-retirement' },
		{ kind: 'control-session-pruning' },
		...(localStepWakes.kind === 'selected' ? localStepWakes.messages : [])
	];

	try {
		await sendQueueMessages(queue, messages);
	} catch (error) {
		if (localStepWakes.kind === 'failed') {
			throw new AggregateError(
				[localStepWakes.error, error],
				'the local-step selection and the enqueue failed',
				{ cause: error }
			);
		}

		throw error;
	}

	if (localStepWakes.kind === 'failed') {
		throw localStepWakes.error;
	}

	return messages;
}

// A failed selection of the local-step wakes is returned, not thrown, so that
// it does not stop the other jobs of the tick.
async function selectLocalStepWakeMessages(
	env: Env
): Promise<
	| { readonly kind: 'selected'; readonly messages: LocalStepWakeMessage[] }
	| { readonly kind: 'failed'; readonly error: unknown }
> {
	try {
		const selection = await selectLocalStepWakes(env);

		return {
			kind: 'selected',
			messages: localStepWakeMessages(selection.tenants)
		};
	} catch (error) {
		return { kind: 'failed', error };
	}
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
	env: Env,
	buffers: NarReadBufferPool
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

		const job = parsed.data;
		const costLogger = messageLogger.with({
			method: job.kind,
			...('tenant' in job && { tenant: job.tenant })
		});
		const decision = await withOperationCost(
			job.kind,
			() => executeMaintenanceQueueMessage(messageLogger, env, buffers, job),
			(cost) => {
				logMethodFinished(costLogger, cost);
			}
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
	buffers: NarReadBufferPool,
	message: MaintenanceQueueMessage,
	options: ExecuteMaintenanceQueueOptions = {}
): Promise<MaintenanceQueueDecision> {
	try {
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
				const verify: MaintainTenant =
					options.verifyTenant ??
					((passLogger, passEnv, tenant) =>
						verifyTenant(passLogger, passEnv, buffers, tenant));
				await verify(logger, env, message.tenant);
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
			case 'narinfo-refresh': {
				await enqueueNarInfoRefreshTenants(
					env,
					message.narHash,
					message.afterTenant
				);
				return { action: 'ack' };
			}
			case 'narinfo-refresh-tenant': {
				const after = await tenantServer(
					env,
					message.tenant
				).enqueueNarInfoReconciliation(message.narHash, message.after);

				if (after !== undefined) {
					await sendQueueMessages(env.MAINTENANCE_QUEUE, [
						{ ...message, after }
					]);
				}

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
			case 'control-session-pruning': {
				await (options.runControlSessionPruning ?? runControlSessionPruning)(
					logger,
					env
				);
				return { action: 'ack' };
			}
			case 'local-step': {
				await (options.wakeLocalStepTenants ?? wakeLocalStepTenants)(
					logger,
					env,
					message.tenants
				);
				return { action: 'ack' };
			}
			case 'local-step-sweep': {
				return { action: 'ack' };
			}
		}
	} catch (error) {
		logger.error('maintenance queue operation failed', {
			kind: message.kind,
			error
		});
		return {
			action: 'retry',
			delaySeconds: queueRetryDelaySeconds,
			reason: errorSummary(error)
		};
	}
}

export async function enqueueNarInfoRefreshTenants(
	env: Env,
	narHash: NixSha256HashString,
	afterTenant: TenantId | undefined,
	queue: MaintenanceQueue = env.MAINTENANCE_QUEUE
): Promise<void> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const tenants = await database
		.selectDistinct({ tenant: d1Schema.blobReference.tenant })
		.from(d1Schema.blobReference)
		.where(
			and(
				eq(d1Schema.blobReference.narHash, narHash),
				afterTenant === undefined
					? undefined
					: gt(d1Schema.blobReference.tenant, afterTenant)
			)
		)
		.orderBy(asc(d1Schema.blobReference.tenant))
		.limit(narInfoRefreshTenantsPerPage + 1);
	const page = tenants.slice(0, narInfoRefreshTenantsPerPage);
	const messages: MaintenanceQueueMessage[] = page.map(({ tenant }) => ({
		kind: 'narinfo-refresh-tenant',
		tenant,
		narHash
	}));

	if (tenants.length > narInfoRefreshTenantsPerPage) {
		const last = page.at(-1);

		if (last !== undefined) {
			messages.push({
				kind: 'narinfo-refresh',
				narHash,
				afterTenant: last.tenant
			});
		}
	}

	await sendQueueMessages(queue, messages);
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
	readonly tenants?: readonly string[];
} {
	if ('tenant' in message) {
		return { kind: message.kind, tenant: message.tenant };
	}
	if (message.kind === 'local-step') {
		return { kind: message.kind, tenants: message.tenants };
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
Collects unreferenced canonical NAR objects. This runs on the Worker because
tenant Durable Objects cannot see reference edges owned by other tenants.
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
Scans a bounded page of `blob_state` for missing canonical objects. It removes
stale rows and asks each tenant Durable Object to retire the affected narinfos.
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
		new TenantCasReferenceDemoter(env),
		subrequestsPerInvocation(env)
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
Drains a bounded batch of offboarding tenants. Each tenant Durable Object
removes its reference rows, while the Worker removes namespaced R2 objects.
The registry becomes an offboarded tombstone only after both stores are empty.
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

	await recordTenantPassOutcomes(
		await writableControlDatabase(env),
		'offboard',
		tenants,
		results
	);

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
Maintains the oldest active tenant batch. It advances every selected
`last_maintained_at` value even when a tenant fails so later tenants are not
starved.
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

	await recordTenantPassOutcomes(
		await writableControlDatabase(env),
		'maintenance',
		batch,
		results
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

// zstd decodes synchronously on the isolate thread, so more concurrent decodes
// only interleave on that thread. Each extra decode lengthens every
// verification and adds a read buffer and a decoder window to memory. Two let
// one verification decode while the other waits for R2.
const verifyDecodeConcurrency = 2;

/**
The delays between attempts to record verdicts. A claim renewal uses only
`restart`.

`restart` applies after a fault that {@link isDurableObjectCallRetryable}
accepts. Its waits total 30 seconds, which covers the restart of a reset
object. `other` applies after any other failure. After an overload, the
recorder sends no further call in the pass.

Each schedule counts its own attempts during a run of consecutive failures,
and a recorded batch starts a new run. Once a schedule is spent, a later
failure of that kind gets no retry until a batch is recorded.
*/
export interface RecordRetrySchedule {
	readonly restart: readonly number[];
	readonly other: readonly number[];
}

export const recordRetrySchedule: RecordRetrySchedule = {
	restart: [1000, 2000, 4000, 8000, 15_000],
	other: [500, 500]
};

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

type RecordFailure = 'restart' | 'overloaded' | 'other';

function recordFailure(error: unknown): RecordFailure {
	if (isDurableObjectOverloaded(error)) {
		return 'overloaded';
	}

	return isDurableObjectCallRetryable(error) ? 'restart' : 'other';
}

/**
Records completed verdicts incrementally through one RPC at a time. Verdicts
completed during an RPC form the next batch. When a batch fails after its
retries, the next batch includes its verdicts. After an overload, the
recorder sends nothing more. While a verdict remains unrecorded,
`finishRecording` rejects so the queue can redeliver the message.

The object can receive a verdict twice when a reply is lost. The second write
is harmless: while the pass still owns the claim, the object stores the same
verdict again; once the verdict has been applied, the pass no longer owns the
claim and the object skips the verdict, and for a canonical object that the
consumer wrote, it gives up only a version that is still pending for this
pass, never a live one.
*/
export class VerdictRecorder {
	private pending: VerificationResult[] = [];
	private unrecorded: VerificationResult[] = [];
	private flushing: Promise<void> | undefined;
	private applied = 0;
	private failure: { readonly error: unknown } | undefined;
	private isOverloaded = false;
	private failures = { restart: 0, other: 0 };

	constructor(
		private readonly logger: Logger,
		private readonly record: (
			results: readonly VerificationResult[]
		) => Promise<number>,
		private readonly retry = recordRetrySchedule,
		private readonly signal?: AbortSignal
	) {}

	private async flush(): Promise<void> {
		while (this.pending.length > 0 && !this.isOverloaded) {
			const batch = [...this.unrecorded, ...this.pending];
			this.unrecorded = [];
			this.pending = [];

			try {
				this.applied += await this.recordWithRetry(batch);
				this.failure = undefined;
			} catch (error) {
				this.unrecorded = batch;
				this.failure = { error };
			}
		}

		this.flushing = undefined;
	}

	/**
	The wait before the next attempt after `failure`, or `undefined` when the
	failure gets no retry.
	*/
	private retryDelay(failure: RecordFailure): number | undefined {
		if (failure === 'overloaded') {
			this.isOverloaded = true;

			return undefined;
		}

		const delayMs = this.retry[failure].at(this.failures[failure]);
		this.failures[failure] += 1;

		return delayMs;
	}

	private async recordWithRetry(
		batch: readonly VerificationResult[]
	): Promise<number> {
		for (;;) {
			this.signal?.throwIfAborted();

			try {
				const applied = await this.record(batch);
				this.failures = { restart: 0, other: 0 };

				return applied;
			} catch (error) {
				this.signal?.throwIfAborted();
				const failure = recordFailure(error);
				const delayMs = this.retryDelay(failure);
				this.logger.warn('verification verdicts not recorded', {
					kind: 'fresh',
					count: batch.length,
					reason: 'record-rpc-failed',
					failure,
					retryDelayMs: delayMs
				});

				if (delayMs === undefined) {
					throw error;
				}

				await abortableDelay(delayMs, this.signal);
			}
		}
	}

	add(result: VerificationResult): void {
		this.signal?.throwIfAborted();

		if (this.isOverloaded) {
			this.unrecorded = [...this.unrecorded, result];

			return;
		}

		this.pending.push(result);
		this.flushing ??= this.flush();
	}

	/**
	Waits until all buffered verdicts are recorded. A persistent RPC failure
	rejects the queue message for redelivery.
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

/**
Calls the tenant's Durable Object for one verification pass. Cloudflare
documents that many exceptions leave a stub broken, so that every later call
on it fails at once with the same exception. When a call rejects, the calls
that follow therefore use a new stub.
*/
export class TenantObjectCalls {
	private stub: DurableObjectStub<CupboardServer>;

	constructor(
		private readonly env: Env,
		private readonly tenant: TenantId
	) {
		this.stub = tenantServer(env, tenant);
	}

	/**
	Makes one call, and stops waiting for it when `signal` aborts.
	*/
	async call<T>(
		signal: AbortSignal,
		rpc: (server: DurableObjectStub<CupboardServer>) => PromiseLike<T>
	): Promise<T> {
		const stub = this.stub;

		try {
			return await raceVerificationOperation(
				Promise.resolve(rpc(stub)),
				signal
			);
		} catch (error) {
			// A concurrent call can already have replaced the stub.
			if (this.stub === stub) {
				this.stub = tenantServer(this.env, this.tenant);
			}

			throw error;
		}
	}

	/**
	Makes one call like `call`, and repeats it after a fault that
	{@link isDurableObjectCallRetryable} accepts, waiting `delays` between
	attempts. Any other failure, and a fault after the last delay, rejects.
	*/
	async callRetryingResets<T>(
		signal: AbortSignal,
		delays: readonly number[],
		rpc: (server: DurableObjectStub<CupboardServer>) => PromiseLike<T>
	): Promise<T> {
		for (let attempt = 0; ; attempt += 1) {
			try {
				return await this.call(signal, rpc);
			} catch (error) {
				const delayMs = isDurableObjectCallRetryable(error)
					? delays.at(attempt)
					: undefined;

				if (delayMs === undefined) {
					throw error;
				}

				await abortableDelay(delayMs, signal);
			}
		}
	}
}

/**
Waits for `pass`. If it rejects before the pass deadline, `release` gives up
the claims that the pass has not recorded, and the rejection then propagates.
*/
async function releaseClaimsIfPassFails<T>(
	pass: Promise<T>,
	release: () => Promise<void>,
	deadline: AbortSignal
): Promise<T> {
	try {
		return await pass;
	} catch (error) {
		if (!deadline.aborted) {
			await release();
		}

		throw error;
	}
}

/**
Releases the claims on `uploadIds`. The pass could not record their verdicts,
and the release lets the next delivery of the queue message claim them at
once. If the release fails too, each claim stays leased until six minutes
after its last renewal.
*/
async function releaseUnrecordedClaims(
	logger: Logger,
	tenant: TenantObjectCalls,
	owner: string,
	uploadIds: readonly UploadId[],
	signal: AbortSignal
): Promise<void> {
	if (uploadIds.length === 0) {
		return;
	}

	try {
		await tenant.call(signal, (server) =>
			server.releaseVerificationClaims(owner, uploadIds)
		);
	} catch (error) {
		logger.warn('verification claims not released', {
			count: uploadIds.length,
			error
		});
	}
}

type FreshVerificationOutcome =
	| 'verified'
	| Extract<DeclaredNarVerification, { readonly ok: false }>['reason']
	| 'missing'
	| 'abandoned'
	| 'aborted';

/**
Asks the tenant's Durable Object to reserve the canonical incarnation for a
declared upload. `undefined` means that the consumer verifies the upload
without writing the canonical object.
*/
type CanonicalWriteReserver = (
	claim: PendingVerification
) => Promise<CanonicalWriteReservation | undefined>;

interface FreshVerification {
	readonly verification: DeclaredNarVerification;
	readonly canonicalWrite?: CanonicalWrite;
}

/**
What every verification in one pass shares.
*/
interface FreshVerificationPass {
	readonly logger: Logger;
	readonly blobs: R2ObjectStore;
	readonly buffers: NarReadBufferPool;
	readonly reserveCanonicalWrite: CanonicalWriteReserver;
	readonly recorder: VerdictRecorder;
	readonly signal: AbortSignal;
}

/**
One claimed upload and the subrequests that the pass set aside for it: its
first get and, for a declared upload, the canonical put.
*/
interface FreshClaim {
	readonly claim: PendingVerification;
	readonly firstGet: SubrequestHold;
	readonly canonicalPut?: SubrequestHold;
}

// A declared upload whose incarnation is reserved is verified and written in
// one read. Every other upload is verified alone, and the Durable Object later
// copies its staged object. The declaration is never used without the write:
// a copy checks the hash that this verifier computes from the bytes it read.
async function verifyFreshBytes(
	pass: FreshVerificationPass,
	{ claim, firstGet, canonicalPut }: FreshClaim,
	reservation: CanonicalWriteReservation | undefined,
	progress: NarVerifyProgress
): Promise<FreshVerification> {
	const { blobs, buffers } = pass;
	const remainingMs =
		claim.recoveryDeadline === undefined
			? undefined
			: Math.max(0, Date.parse(claim.recoveryDeadline) - Date.now());
	const signal =
		remainingMs === undefined
			? pass.signal
			: remainingMs === 0
				? AbortSignal.abort(new PublicationRecoveryExpiredError())
				: AbortSignal.any([pass.signal, AbortSignal.timeout(remainingMs)]);
	const expected = { narHash: claim.narHash, narSize: claim.narSize };

	if (reservation?.kind !== 'reserved' || claim.blob === undefined) {
		canonicalPut?.release();

		return {
			verification: await verifyStoredNar(blobs, claim.r2Key, expected, {
				buffers,
				firstGet,
				signal,
				progress
			})
		};
	}

	const startedAt = Date.now();
	const verification = await verifyAndWriteStoredNar(
		blobs,
		claim.r2Key,
		expected,
		{
			key: narObjectKey(claim.narHash, reservation.incarnation),
			fileHash: claim.blob.fileHash,
			fileSize: claim.blob.fileSize
		},
		{ buffers, firstGet, canonicalPut, signal, progress }
	);

	return {
		verification,
		canonicalWrite: {
			incarnation: reservation.incarnation,
			bytes: progress.compressedBytes,
			durationMs: Date.now() - startedAt
		}
	};
}

/**
Verifies the staged object of one upload that is not a reuse, and adds the
verdict to the pass's recorder. A missing object is terminal. When the pass
is aborted, the error propagates; any other failure abandons the upload for
a later pass, as does a claim that the pass no longer owns. Each call logs
one `pending upload verification finished` event with its outcome and the
work that it did.
*/
async function verifyFreshClaim(
	pass: FreshVerificationPass,
	fresh: FreshClaim
): Promise<void> {
	const { logger, buffers, reserveCanonicalWrite, recorder, signal } = pass;
	const { claim, firstGet, canonicalPut } = fresh;
	const progress = narVerifyProgress();
	const startedAt = Date.now();
	let outcome: FreshVerificationOutcome = 'aborted';
	let write:
		{ readonly incarnation: number; readonly startedAt: number } | undefined;

	try {
		signal.throwIfAborted();
		if (
			claim.recoveryDeadline !== undefined &&
			Date.parse(claim.recoveryDeadline) <= Date.now()
		) {
			outcome = 'abandoned';
			recorder.add({
				uploadId: claim.uploadId,
				verdict: { kind: 'abandoned' }
			});
			return;
		}
		const reservation =
			claim.blob === undefined ? undefined : await reserveCanonicalWrite(claim);
		signal.throwIfAborted();

		if (reservation?.kind === 'revoked') {
			outcome = 'abandoned';
			recorder.add({
				uploadId: claim.uploadId,
				verdict: { kind: 'abandoned' }
			});
			return;
		}

		if (reservation?.kind === 'reserved') {
			write = { incarnation: reservation.incarnation, startedAt: Date.now() };
		}

		const { verification, canonicalWrite } = await verifyFreshBytes(
			pass,
			fresh,
			reservation,
			progress
		);
		signal.throwIfAborted();
		outcome = verification.ok ? 'verified' : verification.reason;

		recorder.add({
			uploadId: claim.uploadId,
			verdict: {
				kind: 'verified',
				verification,
				...(canonicalWrite !== undefined && { canonicalWrite })
			}
		});
	} catch (error) {
		const code = r2ErrorCode(error);
		// A missing staged object stops the verification before the write.
		const failedWrite =
			write === undefined || error instanceof UploadedObjectNotFoundError
				? undefined
				: {
						incarnation: write.incarnation,
						bytes: progress.compressedBytes,
						durationMs: Date.now() - write.startedAt
					};

		if (failedWrite !== undefined) {
			logPromotionAttemptFailed(
				logger,
				{
					uploadId: claim.uploadId,
					storePathHash: claim.storePathHash,
					narHash: claim.narHash
				},
				{
					mode: 'fused',
					outcome: signal.aborted ? 'aborted' : 'failed',
					bytes: failedWrite.bytes,
					durationMs: failedWrite.durationMs,
					...(code !== undefined && { r2ErrorCode: code })
				}
			);
		}

		if (signal.aborted) {
			throw error;
		}

		if (error instanceof UploadedObjectNotFoundError) {
			outcome = 'missing';
			recorder.add({ uploadId: claim.uploadId, verdict: { kind: 'missing' } });
			return;
		}

		outcome = 'abandoned';
		logger.warn('pending upload verification failed', {
			uploadId: claim.uploadId,
			storePathHash: claim.storePathHash,
			narHash: claim.narHash,
			narSize: claim.narSize,
			kind: 'fresh',
			reason: 'verification-failed',
			stage: progress.stage,
			error
		});
		recorder.add({
			uploadId: claim.uploadId,
			verdict: {
				kind: 'abandoned',
				...(failedWrite !== undefined && { canonicalWrite: failedWrite }),
				...(failedWrite !== undefined &&
					code !== undefined && { r2ErrorCode: code })
			}
		});
	} finally {
		firstGet.release();
		canonicalPut?.release();
		logger.info('pending upload verification finished', {
			uploadId: claim.uploadId,
			storePathHash: claim.storePathHash,
			narHash: claim.narHash,
			narSize: claim.narSize,
			outcome,
			compressedBytes: progress.compressedBytes,
			narBytes: progress.narBytes,
			reads: progress.reads,
			ranges: progress.ranges,
			rangeBufferMisses: progress.rangeBufferMisses,
			rangeBudgetSkips: progress.rangeBudgetSkips,
			lostRangeBuffers: progress.lostRangeBuffers,
			peakRangeBuffers: progress.peakRangeBuffers,
			rangeBufferAllocations: buffers.state.allocations,
			durationMs: Date.now() - startedAt
		});
	}
}

// Claim a bounded batch, then fetch and decode staging objects in the queue
// consumer so CPU-bound NAR verification does not occupy the Durable Object.
// The Durable Object applies each verdict only while this pass owns the claim.
// Transient failures release the claim; a missing staging object is terminal.
export async function verifyTenant(
	logger: Logger,
	env: Env,
	buffers: NarReadBufferPool,
	id: TenantId,
	batchSize: number = verifyClaimBatchSize,
	maxNarBytes: number = verifyClaimMaxNarBytes,
	budgetMs: number = verificationConsumerBudgetMs,
	recordRetry: RecordRetrySchedule = recordRetrySchedule
): Promise<void> {
	const deadline = new VerificationPassDeadline(budgetMs);

	try {
		const tenant = new TenantObjectCalls(env, id);
		let batch: PendingVerificationBatch | undefined;

		try {
			const claimResult = await tenant.call<VerificationClaimRpcResult>(
				deadline.signal,
				(server) =>
					server.claimVerificationBatchWithinBudget(
						batchSize,
						maxNarBytes,
						deadline.remainingWorkMs()
					)
			);

			if (claimResult.kind === 'timed-out') {
				throw new SubrequestTimeoutError('verification.claim');
			}

			batch = claimResult.batch;
		} catch {
			deadline.signal.throwIfAborted();
			const compatibleBatch = (await tenant.call(deadline.signal, (server) =>
				server.claimVerificationBatch(
					batchSize,
					maxNarBytes,
					deadline.remainingWorkMs()
				)
			)) as PendingVerificationBatch | Omit<PendingVerificationBatch, 'owner'>;

			if (!('owner' in compatibleBatch)) {
				await tenant.call(deadline.signal, (server) =>
					server.requestVerificationPass()
				);
				return;
			}

			batch = compatibleBatch;
		}

		const { claims, owner, truncated } = batch;
		const activeClaims = new ActiveVerificationClaims(
			claims.map((claim) => claim.uploadId)
		);
		const pass = withRenewedVerificationClaim(
			async (renewalSignal) => {
				const wereClaimsRenewed = await tenant.callRetryingResets(
					renewalSignal,
					recordRetry.restart,
					(server) =>
						server.renewVerificationClaims(owner, activeClaims.remaining())
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
						const result = await tenant.call<VerificationRecordRpcResult>(
							signal,
							(server) =>
								server.recordVerificationsWithinBudget(
									owner,
									results,
									deadline.remainingWorkMs()
								)
						);

						// The object stores verdicts before it applies them, and its verdict
						// drain applies the stored ones. A timed-out call that left no verdict
						// unstored therefore needs no retry. An object of an earlier version
						// does not report which verdicts it stored.
						if (result.kind === 'timed-out' && result.unheld?.length !== 0) {
							throw new SubrequestTimeoutError('verification.record');
						}

						signal.throwIfAborted();

						activeClaims.recorded(results.map((result) => result.uploadId));

						return result.kind === 'recorded' ? result.applied : 0;
					},
					recordRetry,
					signal
				);

				const reuseClaims = claims.filter((claim) => claim.reuse);
				const freshClaims = claims.filter((claim) => !claim.reuse);
				const blobs = new ConnectionLimitedBucket(
					env.BLOBS,
					maxOutgoingConnections
				);
				// A Durable Object from an earlier build has no reservation RPC. After
				// any failure the consumer verifies the upload without the write, and
				// the Durable Object copies its staged object.
				const reserveCanonicalWrite: CanonicalWriteReserver = async (claim) => {
					try {
						return await tenant.call<CanonicalWriteReservation>(
							signal,
							(server) => server.reserveCanonicalWrite(owner, claim.uploadId)
						);
					} catch (error) {
						signal.throwIfAborted();
						logger.warn('canonical write not reserved', {
							uploadId: claim.uploadId,
							narHash: claim.narHash,
							reason: 'reservation-failed',
							error
						});

						return;
					}
				};

				// Reuse rows need no decode. The Durable Object checks the canonical object
				// and performs every shared write while it still owns the claim.
				for (const claim of reuseClaims) {
					signal.throwIfAborted();
					recorder.add({
						uploadId: claim.uploadId,
						verdict: { kind: 'verified', verification: { ok: true } }
					});
				}

				// Set aside every upload's first get, and the canonical put of every
				// declared upload, before any verification starts, so ranged reads for
				// earlier uploads cannot spend the subrequests that later uploads need.
				const verifications = freshClaims.map((claim): FreshClaim => ({
					claim,
					firstGet: holdSubrequests(1),
					...(claim.blob !== undefined && {
						canonicalPut: holdSubrequests(1)
					})
				}));
				const pass: FreshVerificationPass = {
					logger,
					blobs,
					buffers,
					reserveCanonicalWrite,
					recorder,
					signal
				};

				try {
					await mapWithConcurrency(
						verifications,
						verifyDecodeConcurrency,
						(fresh) => verifyFreshClaim(pass, fresh)
					);
				} finally {
					for (const { firstGet, canonicalPut } of verifications) {
						firstGet.release();
						canonicalPut?.release();
					}
				}

				return recorder.finishRecording();
			},
			undefined,
			deadline.signal
		);
		const applied = await releaseClaimsIfPassFails(
			pass,
			() =>
				releaseUnrecordedClaims(
					logger,
					tenant,
					owner,
					activeClaims.remaining(),
					deadline.signal
				),
			deadline.signal
		);

		// Continue a truncated claim only after applying a verdict. With no progress,
		// leave retry to cron instead of reclaiming the same rows immediately.
		const isProgressed = applied > 0;

		if (truncated && isProgressed) {
			await tenant.call(deadline.signal, (server) =>
				server.requestVerificationPass()
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
		await writableControlDatabase(env),
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
			await writableControlDatabase(env),
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

// Offboarding tenants still run their objects to drain storage, so their
// catalogues must also be converted before local schema contraction.
const convertibleTenant = ne(d1Schema.tenant.status, 'offboarded');

function incompleteCacheCatalogueTenants(
	database: CronDatabase,
	batchSize: number
): Promise<{ readonly id: TenantId }[]> {
	return database
		.select({ id: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.where(
			and(convertibleTenant, isNull(d1Schema.tenant.cacheCatalogueVersion))
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
Builds one update for the selected tenants.
*/
export function buildStampMaintainedStatement(
	database: CronDatabase,
	tenantIds: JsonValueList<TenantId>,
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
	const queries = jsonValueLists(tenantIds).map((list) =>
		buildStampMaintainedStatement(database, list, maintainedAt)
	);

	await batchNonEmpty(database, queries);
}

/**
Runs garbage collection, verification, and optional key retirement
independently. If several fail, reports the garbage-collection failure first.
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

async function runControlKeyRetirement(
	logger: Logger,
	env: Env
): Promise<number> {
	return retireScheduledControlKeys(
		await writableControlDatabase(env),
		isoTimestamp(new Date())
	);
}

async function runControlSessionPruning(
	logger: Logger,
	env: Env
): Promise<void> {
	const database = await writableControlDatabase(env);
	const now = isoTimestamp(new Date());
	const pruned = await pruneControlRefreshSessions(database, now);
	const noncesDeleted = await pruneControlSubjectNonces(database, now);

	if (pruned.membersDeleted >= controlRefreshPrunePageSize) {
		logger.warn('control refresh-session backlog may remain after pruning', {
			...pruned
		});
	}

	if (noncesDeleted >= controlSubjectNoncePrunePageSize) {
		logger.warn('consumed subject-nonce backlog may remain after pruning', {
			noncesDeleted
		});
	}
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
