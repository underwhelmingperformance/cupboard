import type { DeploymentIdentity } from '@cupboard/protocol/deployment';
import type { WriterEpoch } from '@cupboard/protocol/deployment-manifest';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { and, asc, eq, gt, inArray, lte } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { tenantServer } from '../routing/durable-object.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

const cohortBatchSize = 32;
const maximumPredecessorLifetimeMs = 16 * 60 * 1000;
const maximumDrainAttempts = 3;

export type WriterDrainOutcome =
	| { readonly outcome: 'complete' }
	| { readonly outcome: 'running' }
	| {
			readonly outcome: 'failed';
			readonly failure: { readonly code: string; readonly detail?: string };
	  };

async function initialiseCutover(
	database: Database,
	deployment: DeploymentIdentity,
	target: WriterEpoch,
	now: Date
): Promise<void> {
	const cutoverAt = isoTimestampSchema.parse(now.toISOString());
	const maximumLegacyDeadline = isoTimestampSchema.parse(
		new Date(now.getTime() + maximumPredecessorLifetimeMs).toISOString()
	);

	await database
		.insert(d1Schema.deploymentWriterCutover)
		.values({
			artifactId: deployment.artifactId,
			instanceId: deployment.instanceId,
			writerEpoch: target,
			cutoverAt,
			cohortCreatedAt: cutoverAt,
			maximumLegacyDeadline
		})
		.onConflictDoNothing();
}

async function didSeedCohort(
	database: Database,
	deployment: DeploymentIdentity,
	execution: typeof d1Schema.deploymentWriterCutover.$inferSelect,
	now: ReturnType<typeof isoTimestampSchema.parse>
): Promise<boolean> {
	if (execution.scanComplete) {
		return false;
	}

	const rows = await database
		.select({ tenant: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.where(
			and(
				inArray(d1Schema.tenant.status, ['active', 'suspended', 'offboarding']),
				lte(d1Schema.tenant.createdAt, execution.cohortCreatedAt),
				...(execution.afterTenant === null
					? []
					: [gt(d1Schema.tenant.id, execution.afterTenant)])
			)
		)
		.orderBy(asc(d1Schema.tenant.id))
		.limit(cohortBatchSize)
		.all();

	if (rows.length > 0) {
		await database
			.insert(d1Schema.deploymentWriterDrainTenant)
			.values(
				rows.map(({ tenant }) => ({
					artifactId: deployment.artifactId,
					instanceId: deployment.instanceId,
					tenant,
					updatedAt: now
				}))
			)
			.onConflictDoNothing();
	}

	const last = rows.at(-1);
	const isScanComplete = rows.length < cohortBatchSize;

	await database
		.update(d1Schema.deploymentWriterCutover)
		.set({
			...(last !== undefined && { afterTenant: last.tenant }),
			scanComplete: isScanComplete
		})
		.where(
			and(
				eq(d1Schema.deploymentWriterCutover.artifactId, deployment.artifactId),
				eq(d1Schema.deploymentWriterCutover.instanceId, deployment.instanceId)
			)
		);

	return rows.length > 0 || !isScanComplete;
}

async function didDrainTenant(
	env: Env,
	database: Database,
	deployment: DeploymentIdentity,
	target: WriterEpoch,
	now: ReturnType<typeof isoTimestampSchema.parse>
): Promise<boolean> {
	const row = await database
		.select()
		.from(d1Schema.deploymentWriterDrainTenant)
		.where(
			and(
				eq(
					d1Schema.deploymentWriterDrainTenant.artifactId,
					deployment.artifactId
				),
				eq(
					d1Schema.deploymentWriterDrainTenant.instanceId,
					deployment.instanceId
				),
				eq(d1Schema.deploymentWriterDrainTenant.status, 'pending')
			)
		)
		.orderBy(asc(d1Schema.deploymentWriterDrainTenant.tenant))
		.limit(1)
		.get();

	if (row === undefined) {
		return false;
	}

	const tenant = await database
		.select({ status: d1Schema.tenant.status })
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, row.tenant))
		.get();

	if (tenant === undefined || tenant.status === 'offboarded') {
		await database
			.update(d1Schema.deploymentWriterDrainTenant)
			.set({ status: 'not-applicable', updatedAt: now })
			.where(
				and(
					eq(
						d1Schema.deploymentWriterDrainTenant.artifactId,
						deployment.artifactId
					),
					eq(
						d1Schema.deploymentWriterDrainTenant.instanceId,
						deployment.instanceId
					),
					eq(d1Schema.deploymentWriterDrainTenant.tenant, row.tenant)
				)
			);

		return true;
	}

	try {
		await tenantServer(env, row.tenant).drainWriterEpoch(row.tenant, target);
		await database
			.update(d1Schema.deploymentWriterDrainTenant)
			.set({ status: 'complete', attempts: row.attempts + 1, updatedAt: now })
			.where(
				and(
					eq(
						d1Schema.deploymentWriterDrainTenant.artifactId,
						deployment.artifactId
					),
					eq(
						d1Schema.deploymentWriterDrainTenant.instanceId,
						deployment.instanceId
					),
					eq(d1Schema.deploymentWriterDrainTenant.tenant, row.tenant)
				)
			);
	} catch (error) {
		const attempts = row.attempts + 1;
		const isFailed = attempts >= maximumDrainAttempts;
		const failure = {
			code: isFailed ? 'writer-drain-failed' : 'writer-drain-retry',
			...(error instanceof Error && { detail: error.message.slice(0, 1000) })
		};

		await database
			.update(d1Schema.deploymentWriterDrainTenant)
			.set({
				status: isFailed ? 'failed' : 'pending',
				attempts,
				updatedAt: now,
				lastFailureJson: JSON.stringify(failure)
			})
			.where(
				and(
					eq(
						d1Schema.deploymentWriterDrainTenant.artifactId,
						deployment.artifactId
					),
					eq(
						d1Schema.deploymentWriterDrainTenant.instanceId,
						deployment.instanceId
					),
					eq(d1Schema.deploymentWriterDrainTenant.tenant, row.tenant)
				)
			);
	}

	return true;
}

export async function advanceWriterDrain(
	env: Env,
	database: Database,
	deployment: DeploymentIdentity,
	target: WriterEpoch,
	now = new Date()
): Promise<WriterDrainOutcome> {
	await initialiseCutover(database, deployment, target, now);

	const execution = await database
		.select()
		.from(d1Schema.deploymentWriterCutover)
		.where(
			and(
				eq(d1Schema.deploymentWriterCutover.artifactId, deployment.artifactId),
				eq(d1Schema.deploymentWriterCutover.instanceId, deployment.instanceId)
			)
		)
		.get();

	if (execution?.writerEpoch !== target) {
		return {
			outcome: 'failed',
			failure: { code: 'writer-drain-state-conflict' }
		};
	}

	if (execution.completedAt !== null) {
		return { outcome: 'complete' };
	}

	const nowIso = isoTimestampSchema.parse(now.toISOString());

	if (nowIso < execution.maximumLegacyDeadline) {
		return { outcome: 'running' };
	}

	if (await didSeedCohort(database, deployment, execution, nowIso)) {
		return { outcome: 'running' };
	}

	if (await didDrainTenant(env, database, deployment, target, nowIso)) {
		return { outcome: 'running' };
	}

	const failed = await database
		.select({ failure: d1Schema.deploymentWriterDrainTenant.lastFailureJson })
		.from(d1Schema.deploymentWriterDrainTenant)
		.where(
			and(
				eq(
					d1Schema.deploymentWriterDrainTenant.artifactId,
					deployment.artifactId
				),
				eq(
					d1Schema.deploymentWriterDrainTenant.instanceId,
					deployment.instanceId
				),
				eq(d1Schema.deploymentWriterDrainTenant.status, 'failed')
			)
		)
		.limit(1)
		.get();

	if (failed !== undefined) {
		return {
			outcome: 'failed',
			failure: {
				code: 'writer-drain-failed',
				...(failed.failure !== null && {
					detail: failed.failure.slice(0, 1000)
				})
			}
		};
	}

	await database
		.update(d1Schema.deploymentWriterCutover)
		.set({ completedAt: nowIso })
		.where(
			and(
				eq(d1Schema.deploymentWriterCutover.artifactId, deployment.artifactId),
				eq(d1Schema.deploymentWriterCutover.instanceId, deployment.instanceId)
			)
		);

	return { outcome: 'complete' };
}
