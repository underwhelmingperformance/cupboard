import {
	cacheCatalogueMigration,
	cacheLocalContractMigration,
	cacheR2MetadataMigration,
	cacheRetentionMigration
} from '@cupboard/protocol/cache-deployment-manifest';
import type { DeploymentIdentity } from '@cupboard/protocol/deployment';
import type {
	DataMigrationBudget,
	DataMigrationDescriptor,
	DataMigrationId,
	MigrationFailureCode
} from '@cupboard/protocol/deployment-manifest';
import { migrationFailureCodeSchema } from '@cupboard/protocol/deployment-manifest';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import {
	and,
	asc,
	count,
	eq,
	inArray,
	isNull,
	lte,
	notInArray,
	or,
	sql
} from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import { tenantServer } from '../routing/durable-object.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

const tenantBatchSize = 32;
const tenantClaimDurationMs = 5 * 60 * 1000;
const tenantRetryBaseDelayMs = 30 * 1000;
const tenantRetryMaximumDelayMs = 30 * 60 * 1000;
type SupportedMigration =
	| 'cache-catalogue-reconciliation'
	| 'cache-r2-generation-metadata'
	| 'cache-retention-properties'
	| 'cache-local-storage-contract';

interface GlobalCursor {
	readonly afterTenant?: string;
	readonly scanComplete: boolean;
}

const globalCursorSchema = z.strictObject({
	afterTenant: z.string().optional(),
	scanComplete: z.boolean()
});

export type FleetMigrationOutcome =
	| { readonly outcome: 'complete' }
	| { readonly outcome: 'running' }
	| {
			readonly outcome: 'failed';
			readonly failure: { readonly code: string; readonly detail?: string };
	  };

export interface DeploymentDataMigrationDependencies {
	advanceTenant(
		env: Env,
		tenant: typeof d1Schema.tenant.$inferSelect.id,
		migration: SupportedMigration,
		budget: DataMigrationBudget
	): Promise<{ readonly outcome: 'complete' | 'pending' }>;
}

export class UnsupportedDeploymentDataMigrationError extends Error {
	constructor(public readonly migration: DataMigrationId) {
		super(`No deployment migration is registered for ${migration}`);
		this.name = 'UnsupportedDeploymentDataMigrationError';
	}
}

export class DataMigrationFailureClassificationError extends Error {
	constructor(
		public readonly migration: DataMigrationId,
		public readonly failureCode: MigrationFailureCode,
		options: ErrorOptions
	) {
		super(
			`Migration ${migration} does not classify failure ${failureCode} exactly once`,
			options
		);
		this.name = 'DataMigrationFailureClassificationError';
	}
}

export class GlobalDataMigrationInitialisationError extends Error {
	constructor(
		public readonly deployment: DeploymentIdentity,
		public readonly migration: DataMigrationId
	) {
		super(`The global row for migration ${migration} was not created`);
		this.name = 'GlobalDataMigrationInitialisationError';
	}
}

const defaultDependencies: DeploymentDataMigrationDependencies = {
	advanceTenant: (env, tenant, migration, budget) =>
		tenantServer(env, tenant).advanceDeploymentMigration(
			tenant,
			migration,
			budget
		)
};

const runtimeFaultFlags = z.object({
	retryable: z.boolean().optional(),
	durableObjectReset: z.boolean().optional(),
	overloaded: z.boolean().optional()
});

function failureDetail(error: unknown): string | undefined {
	const messages: string[] = [];
	const seen = new Set<unknown>();
	let current = error;

	while (
		current instanceof Error &&
		!seen.has(current) &&
		messages.length < 4
	) {
		seen.add(current);
		messages.push(current.message);
		current = current.cause;
	}

	return messages.length === 0 ? undefined : messages.join(': ').slice(0, 1000);
}

function parseCursor(value: string | null): GlobalCursor {
	if (value === null) {
		return { scanComplete: false };
	}

	const parsed: unknown = JSON.parse(value);

	return globalCursorSchema.parse(parsed);
}

function supportedMigration(id: DataMigrationId): SupportedMigration {
	if (id === cacheCatalogueMigration) {
		return 'cache-catalogue-reconciliation';
	}

	if (id === cacheR2MetadataMigration) {
		return 'cache-r2-generation-metadata';
	}

	if (id === cacheRetentionMigration) {
		return 'cache-retention-properties';
	}

	if (id === cacheLocalContractMigration) {
		return 'cache-local-storage-contract';
	}

	throw new UnsupportedDeploymentDataMigrationError(id);
}

async function initialiseExecution(
	database: Database,
	deployment: DeploymentIdentity,
	descriptor: DataMigrationDescriptor,
	now: ReturnType<typeof isoTimestampSchema.parse>
): Promise<void> {
	const cohort = await database
		.select({ count: count() })
		.from(d1Schema.tenant)
		.where(lte(d1Schema.tenant.createdAt, now))
		.get();

	await database
		.insert(d1Schema.globalDataMigration)
		.values({
			artifactId: deployment.artifactId,
			instanceId: deployment.instanceId,
			migrationId: descriptor.id,
			status: 'pending',
			cohortCreatedAt: now,
			cohortHighWater: cohort?.count ?? 0
		})
		.onConflictDoNothing();
}

async function didSeedCohort(
	database: Database,
	deployment: DeploymentIdentity,
	descriptor: DataMigrationDescriptor,
	execution: typeof d1Schema.globalDataMigration.$inferSelect,
	cursor: GlobalCursor
): Promise<boolean> {
	if (cursor.scanComplete) {
		return false;
	}

	const rows = await database
		.select({ tenant: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.where(
			and(
				lte(d1Schema.tenant.createdAt, execution.cohortCreatedAt),
				...(cursor.afterTenant === undefined
					? []
					: [sqlTenantAfter(cursor.afterTenant)])
			)
		)
		.orderBy(asc(d1Schema.tenant.id))
		.limit(tenantBatchSize)
		.all();

	if (rows.length > 0) {
		const values: (typeof d1Schema.tenantDataMigration.$inferInsert)[] =
			rows.map(({ tenant }) => ({
				artifactId: deployment.artifactId,
				instanceId: deployment.instanceId,
				migrationId: descriptor.id,
				implementationRevision: descriptor.implementationRevision,
				tenant,
				status: 'pending'
			}));

		await database
			.insert(d1Schema.tenantDataMigration)
			.values(values)
			.onConflictDoNothing();
	}

	const last = rows.at(-1);
	const isScanComplete = rows.length < tenantBatchSize;

	await database
		.update(d1Schema.globalDataMigration)
		.set({
			scanHighWaterJson: JSON.stringify({
				...(last !== undefined && { afterTenant: last.tenant }),
				scanComplete: isScanComplete
			})
		})
		.where(
			and(
				eq(d1Schema.globalDataMigration.artifactId, deployment.artifactId),
				eq(d1Schema.globalDataMigration.instanceId, deployment.instanceId),
				eq(d1Schema.globalDataMigration.migrationId, descriptor.id)
			)
		);

	return rows.length > 0 || !isScanComplete;
}

function sqlTenantAfter(tenant: string) {
	return sql`${d1Schema.tenant.id} > ${tenant}`;
}

async function didCompleteTenant(
	database: Database,
	deployment: DeploymentIdentity,
	migration: DataMigrationId,
	tenant: typeof d1Schema.tenant.$inferSelect.id,
	now: ReturnType<typeof isoTimestampSchema.parse>,
	claimId: string,
	claimRevision: number
): Promise<boolean> {
	const completed = await database
		.update(d1Schema.tenantDataMigration)
		.set({
			status: 'complete',
			claimId: sql`NULL`,
			claimExpiresAt: sql`NULL`,
			completedAt: now,
			lastFailureJson: sql`NULL`
		})
		.where(
			and(
				eq(d1Schema.tenantDataMigration.artifactId, deployment.artifactId),
				eq(d1Schema.tenantDataMigration.instanceId, deployment.instanceId),
				eq(d1Schema.tenantDataMigration.migrationId, migration),
				eq(d1Schema.tenantDataMigration.tenant, tenant),
				eq(d1Schema.tenantDataMigration.status, 'running'),
				eq(d1Schema.tenantDataMigration.claimId, claimId),
				eq(d1Schema.tenantDataMigration.claimRevision, claimRevision)
			)
		)
		.run();

	return completed.meta.changes === 1;
}

async function isOffboardedTenantDrained(
	database: Database,
	tenant: typeof d1Schema.tenant.$inferSelect.id,
	shouldCheckManagedState: boolean
): Promise<boolean> {
	const unresolvedRepairCondition = and(
		eq(d1Schema.projectionRepairIntent.tenant, tenant),
		notInArray(d1Schema.projectionRepairIntent.status, [
			'complete',
			'rolled-back'
		])
	);
	const [
		lifecycles,
		blobs,
		references,
		attestations,
		casBlobs,
		credentials,
		repairs
	] = await database.batch([
		database
			.select({ tenant: d1Schema.cacheLifecycle.tenant })
			.from(d1Schema.cacheLifecycle)
			.where(eq(d1Schema.cacheLifecycle.tenant, tenant))
			.limit(1),
		database
			.select({ tenant: d1Schema.tenantBlob.tenant })
			.from(d1Schema.tenantBlob)
			.where(eq(d1Schema.tenantBlob.tenant, tenant))
			.limit(1),
		database
			.select({ tenant: d1Schema.blobReference.tenant })
			.from(d1Schema.blobReference)
			.where(eq(d1Schema.blobReference.tenant, tenant))
			.limit(1),
		database
			.select({ tenant: d1Schema.attestationReference.tenant })
			.from(d1Schema.attestationReference)
			.where(eq(d1Schema.attestationReference.tenant, tenant))
			.limit(1),
		database
			.select({ tenant: d1Schema.tenantCasBlob.tenant })
			.from(d1Schema.tenantCasBlob)
			.where(eq(d1Schema.tenantCasBlob.tenant, tenant))
			.limit(1),
		database
			.select({ tenant: d1Schema.tenantCacheReadCredential.tenant })
			.from(d1Schema.tenantCacheReadCredential)
			.where(eq(d1Schema.tenantCacheReadCredential.tenant, tenant))
			.limit(1),
		database
			.select({ tenant: d1Schema.projectionRepairIntent.tenant })
			.from(d1Schema.projectionRepairIntent)
			.where(unresolvedRepairCondition)
			.limit(1)
	]);

	const hasBaseState = [
		lifecycles,
		blobs,
		references,
		attestations,
		casBlobs,
		credentials,
		repairs
	].some((rows) => rows.length > 0);

	if (hasBaseState || !shouldCheckManagedState) {
		return !hasBaseState;
	}

	const [policies, groups] = await database.batch([
		database
			.select({ tenant: d1Schema.managedPolicyFamily.tenant })
			.from(d1Schema.managedPolicyFamily)
			.where(eq(d1Schema.managedPolicyFamily.tenant, tenant))
			.limit(1),
		database
			.select({ tenant: d1Schema.managedCacheGroup.tenant })
			.from(d1Schema.managedCacheGroup)
			.where(eq(d1Schema.managedCacheGroup.tenant, tenant))
			.limit(1)
	]);

	return policies.length === 0 && groups.length === 0;
}

function tenantClaimCondition(
	deployment: DeploymentIdentity,
	migration: DataMigrationId,
	tenant: typeof d1Schema.tenant.$inferSelect.id,
	claimId: string,
	claimRevision: number
) {
	return and(
		eq(d1Schema.tenantDataMigration.artifactId, deployment.artifactId),
		eq(d1Schema.tenantDataMigration.instanceId, deployment.instanceId),
		eq(d1Schema.tenantDataMigration.migrationId, migration),
		eq(d1Schema.tenantDataMigration.tenant, tenant),
		eq(d1Schema.tenantDataMigration.status, 'running'),
		eq(d1Schema.tenantDataMigration.claimId, claimId),
		eq(d1Schema.tenantDataMigration.claimRevision, claimRevision)
	);
}

function failureFor(error: unknown): {
	readonly code: MigrationFailureCode;
	readonly detail?: string;
} {
	const flags = runtimeFaultFlags.safeParse(error);
	const isRetryable =
		flags.success &&
		(flags.data.retryable === true ||
			flags.data.durableObjectReset === true ||
			flags.data.overloaded === true);
	const code = migrationFailureCodeSchema.parse(
		isRetryable ? 'tenant-busy' : 'migration-invariant-failed'
	);
	const detail = failureDetail(error);

	return {
		code,
		...(detail !== undefined && { detail })
	};
}

function retryAt(now: Date, attempts: number) {
	const exponent = Math.max(0, Math.min(attempts - 1, 16));
	const delay = Math.min(
		tenantRetryMaximumDelayMs,
		tenantRetryBaseDelayMs * 2 ** exponent
	);

	return isoTimestampSchema.parse(
		new Date(now.getTime() + delay).toISOString()
	);
}

async function didAdvanceTenant(
	env: Env,
	database: Database,
	deployment: DeploymentIdentity,
	descriptor: DataMigrationDescriptor,
	now: Date,
	claimId: string,
	dependencies: DeploymentDataMigrationDependencies
): Promise<boolean> {
	const nowIso = isoTimestampSchema.parse(now.toISOString());
	const expiredClaim = and(
		eq(d1Schema.tenantDataMigration.status, 'running'),
		lte(d1Schema.tenantDataMigration.claimExpiresAt, nowIso)
	);
	const pending = and(
		eq(d1Schema.tenantDataMigration.status, 'pending'),
		or(
			isNull(d1Schema.tenantDataMigration.nextAttemptAt),
			lte(d1Schema.tenantDataMigration.nextAttemptAt, nowIso)
		)
	);
	const availabilityCondition = or(pending, expiredClaim);
	const row = await database
		.select({
			tenant: d1Schema.tenantDataMigration.tenant,
			status: d1Schema.tenantDataMigration.status,
			claimRevision: d1Schema.tenantDataMigration.claimRevision,
			attempts: d1Schema.tenantDataMigration.attempts
		})
		.from(d1Schema.tenantDataMigration)
		.where(
			and(
				eq(d1Schema.tenantDataMigration.artifactId, deployment.artifactId),
				eq(d1Schema.tenantDataMigration.instanceId, deployment.instanceId),
				eq(d1Schema.tenantDataMigration.migrationId, descriptor.id),
				availabilityCondition
			)
		)
		.orderBy(asc(d1Schema.tenantDataMigration.tenant))
		.limit(1)
		.get();

	if (row === undefined) {
		return false;
	}

	const claimExpiresAt = isoTimestampSchema.parse(
		new Date(now.getTime() + tenantClaimDurationMs).toISOString()
	);
	const claimRevision = row.claimRevision + 1;
	const claimed = await database
		.update(d1Schema.tenantDataMigration)
		.set({
			status: 'running',
			claimId,
			claimRevision,
			claimExpiresAt,
			attempts: row.attempts + 1,
			startedAt: nowIso,
			nextAttemptAt: sql`NULL`
		})
		.where(
			and(
				eq(d1Schema.tenantDataMigration.artifactId, deployment.artifactId),
				eq(d1Schema.tenantDataMigration.instanceId, deployment.instanceId),
				eq(d1Schema.tenantDataMigration.migrationId, descriptor.id),
				eq(d1Schema.tenantDataMigration.tenant, row.tenant),
				eq(d1Schema.tenantDataMigration.claimRevision, row.claimRevision),
				eq(d1Schema.tenantDataMigration.status, row.status)
			)
		)
		.run();

	if (claimed.meta.changes !== 1) {
		return false;
	}

	const currentTenant = await database
		.select({ status: d1Schema.tenant.status })
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, row.tenant))
		.get();

	if (currentTenant === undefined || currentTenant.status === 'offboarded') {
		const isDrained =
			currentTenant === undefined ||
			(await isOffboardedTenantDrained(
				database,
				row.tenant,
				descriptor.id === cacheLocalContractMigration
			));

		if (!isDrained) {
			await database
				.update(d1Schema.tenantDataMigration)
				.set({
					status: 'failed',
					claimId: sql`NULL`,
					claimExpiresAt: sql`NULL`,
					lastFailureJson: JSON.stringify({
						code: 'migration-invariant-failed',
						detail: 'The offboarded tenant still has cache references or work'
					})
				})
				.where(
					tenantClaimCondition(
						deployment,
						descriptor.id,
						row.tenant,
						claimId,
						claimRevision
					)
				)
				.run();

			return true;
		}

		await database
			.update(d1Schema.tenantDataMigration)
			.set({
				status: 'not-applicable',
				claimId: sql`NULL`,
				claimExpiresAt: sql`NULL`,
				completedAt: nowIso
			})
			.where(
				tenantClaimCondition(
					deployment,
					descriptor.id,
					row.tenant,
					claimId,
					claimRevision
				)
			)
			.run();

		return true;
	}

	try {
		const outcome = await dependencies.advanceTenant(
			env,
			row.tenant,
			supportedMigration(descriptor.id),
			descriptor.budget
		);

		if (outcome.outcome === 'complete') {
			await didCompleteTenant(
				database,
				deployment,
				descriptor.id,
				row.tenant,
				nowIso,
				claimId,
				claimRevision
			);
			return true;
		}

		await database
			.update(d1Schema.tenantDataMigration)
			.set({
				status: 'pending',
				claimId: sql`NULL`,
				claimExpiresAt: sql`NULL`,
				nextAttemptAt: nowIso
			})
			.where(
				tenantClaimCondition(
					deployment,
					descriptor.id,
					row.tenant,
					claimId,
					claimRevision
				)
			)
			.run();
	} catch (error) {
		const failure = failureFor(error);
		const isRetryable = descriptor.retryableFailures.includes(failure.code);
		const isTerminal = descriptor.terminalFailures.includes(failure.code);

		if (isRetryable === isTerminal) {
			throw new DataMigrationFailureClassificationError(
				descriptor.id,
				failure.code,
				{ cause: error }
			);
		}

		await database
			.update(d1Schema.tenantDataMigration)
			.set({
				status: isTerminal ? 'failed' : 'pending',
				claimId: sql`NULL`,
				claimExpiresAt: sql`NULL`,
				nextAttemptAt: isTerminal ? sql`NULL` : retryAt(now, row.attempts + 1),
				lastFailureJson: JSON.stringify(failure)
			})
			.where(
				tenantClaimCondition(
					deployment,
					descriptor.id,
					row.tenant,
					claimId,
					claimRevision
				)
			)
			.run();
	}

	return true;
}

export async function advanceFleetDataMigration(
	env: Env,
	database: Database,
	deployment: DeploymentIdentity,
	descriptor: DataMigrationDescriptor,
	claimId: string,
	now = new Date(),
	dependencies: DeploymentDataMigrationDependencies = defaultDependencies
): Promise<FleetMigrationOutcome> {
	const nowIso = isoTimestampSchema.parse(now.toISOString());
	await initialiseExecution(database, deployment, descriptor, nowIso);

	const execution = await database
		.select()
		.from(d1Schema.globalDataMigration)
		.where(
			and(
				eq(d1Schema.globalDataMigration.artifactId, deployment.artifactId),
				eq(d1Schema.globalDataMigration.instanceId, deployment.instanceId),
				eq(d1Schema.globalDataMigration.migrationId, descriptor.id)
			)
		)
		.get();

	if (execution === undefined) {
		throw new GlobalDataMigrationInitialisationError(deployment, descriptor.id);
	}

	if (execution.status === 'complete') {
		return { outcome: 'complete' };
	}

	const cursor = parseCursor(execution.scanHighWaterJson);

	if (
		await didSeedCohort(database, deployment, descriptor, execution, cursor)
	) {
		return { outcome: 'running' };
	}

	if (
		await didAdvanceTenant(
			env,
			database,
			deployment,
			descriptor,
			now,
			claimId,
			dependencies
		)
	) {
		return { outcome: 'running' };
	}

	const failures = await database
		.select({ failure: d1Schema.tenantDataMigration.lastFailureJson })
		.from(d1Schema.tenantDataMigration)
		.where(
			and(
				eq(d1Schema.tenantDataMigration.artifactId, deployment.artifactId),
				eq(d1Schema.tenantDataMigration.instanceId, deployment.instanceId),
				eq(d1Schema.tenantDataMigration.migrationId, descriptor.id),
				eq(d1Schema.tenantDataMigration.status, 'failed')
			)
		)
		.limit(1)
		.get();

	if (failures !== undefined) {
		return {
			outcome: 'failed',
			failure: {
				code: 'fleet-data-migration-failed',
				...(failures.failure !== null && {
					detail: failures.failure.slice(0, 1000)
				})
			}
		};
	}

	const missingTenant = await database
		.select({ tenant: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.leftJoin(
			d1Schema.tenantDataMigration,
			and(
				eq(d1Schema.tenantDataMigration.artifactId, deployment.artifactId),
				eq(d1Schema.tenantDataMigration.instanceId, deployment.instanceId),
				eq(d1Schema.tenantDataMigration.migrationId, descriptor.id),
				eq(d1Schema.tenantDataMigration.tenant, d1Schema.tenant.id)
			)
		)
		.where(isNull(d1Schema.tenantDataMigration.tenant))
		.orderBy(asc(d1Schema.tenant.id))
		.limit(1)
		.get();

	if (missingTenant !== undefined) {
		await database
			.insert(d1Schema.tenantDataMigration)
			.values({
				artifactId: deployment.artifactId,
				instanceId: deployment.instanceId,
				migrationId: descriptor.id,
				implementationRevision: descriptor.implementationRevision,
				tenant: missingTenant.tenant,
				status: 'pending'
			})
			.onConflictDoNothing()
			.run();

		return { outcome: 'running' };
	}

	const incomplete = await database
		.select({ tenant: d1Schema.tenantDataMigration.tenant })
		.from(d1Schema.tenantDataMigration)
		.where(
			and(
				eq(d1Schema.tenantDataMigration.artifactId, deployment.artifactId),
				eq(d1Schema.tenantDataMigration.instanceId, deployment.instanceId),
				eq(d1Schema.tenantDataMigration.migrationId, descriptor.id),
				inArray(d1Schema.tenantDataMigration.status, ['pending', 'running'])
			)
		)
		.limit(1)
		.get();

	if (incomplete !== undefined) {
		return { outcome: 'running' };
	}

	const baseOffboardedResidue = sql`
		exists (select 1 from ${d1Schema.cacheLifecycle} where ${d1Schema.cacheLifecycle.tenant} = ${d1Schema.tenant.id})
		or exists (select 1 from ${d1Schema.tenantCacheReadCredential} where ${d1Schema.tenantCacheReadCredential.tenant} = ${d1Schema.tenant.id})
		or exists (select 1 from ${d1Schema.blobReference} where ${d1Schema.blobReference.tenant} = ${d1Schema.tenant.id})
		or exists (select 1 from ${d1Schema.tenantBlob} where ${d1Schema.tenantBlob.tenant} = ${d1Schema.tenant.id})
		or exists (select 1 from ${d1Schema.attestationReference} where ${d1Schema.attestationReference.tenant} = ${d1Schema.tenant.id})
		or exists (select 1 from ${d1Schema.tenantCasBlob} where ${d1Schema.tenantCasBlob.tenant} = ${d1Schema.tenant.id})
		or exists (
			select 1 from ${d1Schema.projectionRepairIntent}
			where ${d1Schema.projectionRepairIntent.tenant} = ${d1Schema.tenant.id}
				and ${d1Schema.projectionRepairIntent.status} not in ('complete', 'rolled-back')
		)
	`;
	const offboardedResidue =
		descriptor.id === cacheLocalContractMigration
			? sql`${baseOffboardedResidue}
				or exists (select 1 from ${d1Schema.managedPolicyFamily} where ${d1Schema.managedPolicyFamily.tenant} = ${d1Schema.tenant.id})
				or exists (select 1 from ${d1Schema.managedCacheGroup} where ${d1Schema.managedCacheGroup.tenant} = ${d1Schema.tenant.id})`
			: baseOffboardedResidue;
	const completed = await database
		.update(d1Schema.globalDataMigration)
		.set({
			status: 'complete',
			fleetCompletionRevision: execution.claimRevision + 1,
			completedAt: nowIso,
			claimId: sql`NULL`,
			claimExpiresAt: sql`NULL`
		})
		.where(
			and(
				eq(d1Schema.globalDataMigration.artifactId, deployment.artifactId),
				eq(d1Schema.globalDataMigration.instanceId, deployment.instanceId),
				eq(d1Schema.globalDataMigration.migrationId, descriptor.id),
				sql`not exists (
					select 1
					from ${d1Schema.tenant}
					left join ${d1Schema.tenantDataMigration}
						on ${d1Schema.tenantDataMigration.artifactId} = ${deployment.artifactId}
						and ${d1Schema.tenantDataMigration.instanceId} = ${deployment.instanceId}
						and ${d1Schema.tenantDataMigration.migrationId} = ${descriptor.id}
						and ${d1Schema.tenantDataMigration.tenant} = ${d1Schema.tenant.id}
					where ${d1Schema.tenantDataMigration.tenant} is null
						or ${d1Schema.tenantDataMigration.status} not in ('complete', 'not-applicable')
				)`,
				sql`not exists (
					select 1 from ${d1Schema.tenant}
					where ${d1Schema.tenant.status} = 'offboarded'
						and (${offboardedResidue})
				)`
			)
		)
		.run();

	return completed.meta.changes === 1
		? { outcome: 'complete' }
		: { outcome: 'running' };
}
