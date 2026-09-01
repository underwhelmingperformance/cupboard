import {
	cacheCatalogueMigration,
	cacheLocalContractMigration,
	cacheR2MetadataMigration,
	cacheRetentionMigration
} from '@cupboard/protocol/cache-deployment-manifest';
import type { DeploymentIdentity } from '@cupboard/protocol/deployment';
import type {
	DataMigrationDescriptor,
	DataMigrationId
} from '@cupboard/protocol/deployment-manifest';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { and, asc, count, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import { tenantServer } from '../routing/durable-object.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

const tenantBatchSize = 32;
const tenantClaimDurationMs = 5 * 60 * 1000;
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

	throw new Error(`No deployment migration is registered for ${id}`);
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
		.where(
			and(
				inArray(d1Schema.tenant.status, descriptor.tenantStatuses),
				lte(d1Schema.tenant.createdAt, now)
			)
		)
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
				inArray(d1Schema.tenant.status, descriptor.tenantStatuses),
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

async function completeTenant(
	database: Database,
	deployment: DeploymentIdentity,
	migration: DataMigrationId,
	tenant: typeof d1Schema.tenant.$inferSelect.id,
	now: ReturnType<typeof isoTimestampSchema.parse>
): Promise<void> {
	await database
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
				eq(d1Schema.tenantDataMigration.tenant, tenant)
			)
		);
}

async function didAdvanceTenant(
	env: Env,
	database: Database,
	deployment: DeploymentIdentity,
	descriptor: DataMigrationDescriptor,
	now: Date,
	claimId: string
): Promise<boolean> {
	const nowIso = isoTimestampSchema.parse(now.toISOString());
	const expiredClaim = and(
		eq(d1Schema.tenantDataMigration.status, 'running'),
		lte(d1Schema.tenantDataMigration.claimExpiresAt, nowIso)
	);
	const availabilityCondition = or(
		eq(d1Schema.tenantDataMigration.status, 'pending'),
		expiredClaim
	);
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
	await database
		.update(d1Schema.tenantDataMigration)
		.set({
			status: 'running',
			claimId,
			claimRevision: row.claimRevision + 1,
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
				eq(d1Schema.tenantDataMigration.claimRevision, row.claimRevision)
			)
		);

	const currentTenant = await database
		.select({ status: d1Schema.tenant.status })
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, row.tenant))
		.get();

	if (currentTenant === undefined || currentTenant.status === 'offboarded') {
		await database
			.update(d1Schema.tenantDataMigration)
			.set({
				status: 'not-applicable',
				claimId: sql`NULL`,
				claimExpiresAt: sql`NULL`,
				completedAt: nowIso
			})
			.where(
				and(
					eq(d1Schema.tenantDataMigration.artifactId, deployment.artifactId),
					eq(d1Schema.tenantDataMigration.instanceId, deployment.instanceId),
					eq(d1Schema.tenantDataMigration.migrationId, descriptor.id),
					eq(d1Schema.tenantDataMigration.tenant, row.tenant)
				)
			);

		return true;
	}

	try {
		const outcome = await tenantServer(
			env,
			row.tenant
		).advanceDeploymentMigration(row.tenant, supportedMigration(descriptor.id));

		if (outcome.outcome === 'complete') {
			await completeTenant(
				database,
				deployment,
				descriptor.id,
				row.tenant,
				nowIso
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
				and(
					eq(d1Schema.tenantDataMigration.artifactId, deployment.artifactId),
					eq(d1Schema.tenantDataMigration.instanceId, deployment.instanceId),
					eq(d1Schema.tenantDataMigration.migrationId, descriptor.id),
					eq(d1Schema.tenantDataMigration.tenant, row.tenant)
				)
			);
	} catch (error) {
		const isTerminal = row.attempts + 1 >= 3;
		const failure = {
			code: isTerminal ? 'tenant-migration-failed' : 'tenant-migration-retry',
			detail: error instanceof Error ? error.message.slice(0, 1000) : undefined
		};
		await database
			.update(d1Schema.tenantDataMigration)
			.set({
				status: isTerminal ? 'failed' : 'pending',
				claimId: sql`NULL`,
				claimExpiresAt: sql`NULL`,
				nextAttemptAt: isTerminal ? sql`NULL` : nowIso,
				lastFailureJson: JSON.stringify(failure)
			})
			.where(
				and(
					eq(d1Schema.tenantDataMigration.artifactId, deployment.artifactId),
					eq(d1Schema.tenantDataMigration.instanceId, deployment.instanceId),
					eq(d1Schema.tenantDataMigration.migrationId, descriptor.id),
					eq(d1Schema.tenantDataMigration.tenant, row.tenant)
				)
			);
	}

	return true;
}

export async function advanceFleetDataMigration(
	env: Env,
	database: Database,
	deployment: DeploymentIdentity,
	descriptor: DataMigrationDescriptor,
	claimId: string,
	now = new Date()
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
		throw new Error('The global data migration row was not created');
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
		await didAdvanceTenant(env, database, deployment, descriptor, now, claimId)
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

	await database
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
				eq(d1Schema.globalDataMigration.migrationId, descriptor.id)
			)
		)
		.run();

	return { outcome: 'complete' };
}
