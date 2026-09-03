import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { cacheCatalogueMigration } from '@cupboard/protocol/cache-deployment-manifest';
import {
	deploymentArtifactIdSchema,
	type DeploymentIdentity,
	deploymentInstanceIdSchema
} from '@cupboard/protocol/deployment';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import { firstCacheGeneration } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { deploymentManifest } from '../deployment-manifest.generated.ts';

import {
	advanceFleetDataMigration,
	type DeploymentDataMigrationDependencies
} from './deployment-data.ts';

const deployment: DeploymentIdentity = {
	artifactId: deploymentArtifactIdSchema.parse('a'.repeat(64)),
	instanceId: deploymentInstanceIdSchema.parse('b'.repeat(64))
};

function database() {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

function descriptor() {
	const descriptor = deploymentManifest.dataMigrations.find(
		(candidate) => candidate.id === cacheCatalogueMigration
	);

	if (descriptor === undefined) {
		throw new Error('The cache catalogue migration is not registered');
	}

	return descriptor;
}

async function seedTenantCohort(now: Date) {
	await database()
		.insert(d1Schema.tenant)
		.values({
			id: tenantIdSchema.parse('acme'),
			status: 'active',
			ownerIssuer: 'https://issuer.example',
			ownerSubject: 'owner',
			ownerAudience: 'cupboard',
			configVersion: 1,
			createdAt: isoTimestampSchema.parse('2026-08-31T00:00:00.000Z')
		})
		.run();

	await advanceFleetDataMigration(
		env,
		database(),
		deployment,
		descriptor(),
		'seed-cohort',
		now
	);
}

beforeEach(async () => {
	const d1 = database();
	await d1.delete(d1Schema.tenantDataMigration);
	await d1.delete(d1Schema.globalDataMigration);
	await d1.delete(d1Schema.tenant);
});

describe('deployment data migration', () => {
	it('records and resumes an empty fixed cohort idempotently', async () => {
		const first = await advanceFleetDataMigration(
			env,
			database(),
			deployment,
			descriptor(),
			'attempt-one',
			new Date('2026-09-01T00:00:00.000Z')
		);
		const second = await advanceFleetDataMigration(
			env,
			database(),
			deployment,
			descriptor(),
			'attempt-two',
			new Date('2026-09-01T00:01:00.000Z')
		);
		const globalRows = await database()
			.select()
			.from(d1Schema.globalDataMigration)
			.all();
		const global = globalRows.map((row) => ({
			...row,
			claimId: row.claimId ?? undefined,
			claimExpiresAt: row.claimExpiresAt ?? undefined,
			lastFailureJson: row.lastFailureJson ?? undefined
		}));

		expect({ first, second, global }).toStrictEqual({
			first: { outcome: 'complete' },
			second: { outcome: 'complete' },
			global: [
				{
					artifactId: deployment.artifactId,
					instanceId: deployment.instanceId,
					migrationId: cacheCatalogueMigration,
					status: 'complete',
					cohortCreatedAt: '2026-09-01T00:00:00.000Z',
					cohortHighWater: 0,
					scanHighWaterJson: '{"scanComplete":true}',
					claimId: undefined,
					claimRevision: 0,
					claimExpiresAt: undefined,
					fleetCompletionRevision: 1,
					completedAt: '2026-09-01T00:00:00.000Z',
					lastFailureJson: undefined
				}
			]
		});
	});

	it('prevents a stale claimant from overwriting a completed tenant', async () => {
		const start = new Date('2026-09-01T00:00:00.000Z');
		await seedTenantCohort(start);
		const firstStarted = Promise.withResolvers<undefined>();
		const releaseFirst = Promise.withResolvers<undefined>();
		const firstDependencies: DeploymentDataMigrationDependencies = {
			advanceTenant: async () => {
				firstStarted.resolve(undefined);
				await releaseFirst.promise;
				throw new Error('the abandoned claimant failed');
			}
		};
		const first = advanceFleetDataMigration(
			env,
			database(),
			deployment,
			descriptor(),
			'first-claim',
			start,
			firstDependencies
		);

		await firstStarted.promise;

		const second = await advanceFleetDataMigration(
			env,
			database(),
			deployment,
			descriptor(),
			'second-claim',
			new Date('2026-09-01T00:06:00.000Z'),
			{ advanceTenant: () => Promise.resolve({ outcome: 'complete' }) }
		);

		releaseFirst.resolve(undefined);
		await first;

		const storedTenantRows = await database()
			.select()
			.from(d1Schema.tenantDataMigration)
			.all();
		const tenantRows = storedTenantRows.map((row) => ({
			...row,
			claimId: row.claimId ?? undefined,
			claimExpiresAt: row.claimExpiresAt ?? undefined,
			nextAttemptAt: row.nextAttemptAt ?? undefined,
			lastFailureJson: row.lastFailureJson ?? undefined
		}));

		expect({ second, tenantRows }).toStrictEqual({
			second: { outcome: 'running' },
			tenantRows: [
				{
					artifactId: deployment.artifactId,
					instanceId: deployment.instanceId,
					migrationId: cacheCatalogueMigration,
					implementationRevision: descriptor().implementationRevision,
					tenant: 'acme',
					status: 'complete',
					attempts: 2,
					claimId: undefined,
					claimRevision: 2,
					claimExpiresAt: undefined,
					nextAttemptAt: undefined,
					startedAt: '2026-09-01T00:06:00.000Z',
					completedAt: '2026-09-01T00:06:00.000Z',
					lastFailureJson: undefined
				}
			]
		});
	});

	it('uses the descriptor taxonomy and retry deadline', async () => {
		const start = new Date('2026-09-01T00:00:00.000Z');
		await seedTenantCohort(start);
		let calls = 0;
		const retryableFailure = new Error('tenant busy');
		Object.defineProperty(retryableFailure, 'retryable', { value: true });
		const dependencies: DeploymentDataMigrationDependencies = {
			advanceTenant: () => {
				calls += 1;

				return Promise.reject(retryableFailure);
			}
		};

		await advanceFleetDataMigration(
			env,
			database(),
			deployment,
			descriptor(),
			'first-attempt',
			start,
			dependencies
		);
		await advanceFleetDataMigration(
			env,
			database(),
			deployment,
			descriptor(),
			'too-early',
			new Date('2026-09-01T00:00:29.000Z'),
			dependencies
		);
		const rows = await database()
			.select({
				status: d1Schema.tenantDataMigration.status,
				attempts: d1Schema.tenantDataMigration.attempts,
				nextAttemptAt: d1Schema.tenantDataMigration.nextAttemptAt,
				failure: d1Schema.tenantDataMigration.lastFailureJson
			})
			.from(d1Schema.tenantDataMigration)
			.all();

		expect({ calls, rows }).toStrictEqual({
			calls: 1,
			rows: [
				{
					status: 'pending',
					attempts: 1,
					nextAttemptAt: '2026-09-01T00:00:30.000Z',
					failure: '{"code":"tenant-busy","detail":"tenant busy"}'
				}
			]
		});
	});

	it('fails an invariant violation on its first attempt', async () => {
		const start = new Date('2026-09-01T00:00:00.000Z');
		await seedTenantCohort(start);

		const outcome = await advanceFleetDataMigration(
			env,
			database(),
			deployment,
			descriptor(),
			'terminal-attempt',
			start,
			{
				advanceTenant: () =>
					Promise.reject(new Error('cache generations disagree'))
			}
		);
		const rows = await database()
			.select({
				status: d1Schema.tenantDataMigration.status,
				attempts: d1Schema.tenantDataMigration.attempts,
				failure: d1Schema.tenantDataMigration.lastFailureJson
			})
			.from(d1Schema.tenantDataMigration)
			.all();

		expect({ outcome, rows }).toStrictEqual({
			outcome: { outcome: 'running' },
			rows: [
				{
					status: 'failed',
					attempts: 1,
					failure:
						'{"code":"migration-invariant-failed","detail":"cache generations disagree"}'
				}
			]
		});
	});

	it('adds a tenant which appears after the initial cohort scan', async () => {
		const start = new Date('2026-09-01T00:00:00.000Z');
		await database()
			.insert(d1Schema.globalDataMigration)
			.values({
				...deployment,
				migrationId: descriptor().id,
				status: 'running',
				cohortCreatedAt: isoTimestampSchema.parse(start.toISOString()),
				cohortHighWater: 0,
				scanHighWaterJson: JSON.stringify({ scanComplete: true })
			})
			.run();
		await database()
			.insert(d1Schema.tenant)
			.values({
				id: tenantIdSchema.parse('late'),
				status: 'active',
				ownerIssuer: 'https://issuer.example',
				ownerSubject: 'owner',
				ownerAudience: 'cupboard',
				configVersion: 1,
				createdAt: isoTimestampSchema.parse('2026-09-01T00:00:01.000Z')
			})
			.run();

		const outcome = await advanceFleetDataMigration(
			env,
			database(),
			deployment,
			descriptor(),
			'late-tenant',
			new Date('2026-09-01T00:00:02.000Z')
		);
		const rows = await database()
			.select({
				tenant: d1Schema.tenantDataMigration.tenant,
				status: d1Schema.tenantDataMigration.status
			})
			.from(d1Schema.tenantDataMigration)
			.all();

		expect({ outcome, rows }).toStrictEqual({
			outcome: { outcome: 'running' },
			rows: [{ tenant: 'late', status: 'pending' }]
		});
	});

	it('fails an offboarded tenant which retains cache state', async () => {
		const start = new Date('2026-09-01T00:00:00.000Z');
		const tenant = tenantIdSchema.parse('retired');
		await database()
			.insert(d1Schema.tenant)
			.values({
				id: tenant,
				status: 'offboarded',
				ownerIssuer: 'https://issuer.example',
				ownerSubject: 'owner',
				ownerAudience: 'cupboard',
				configVersion: 1,
				createdAt: isoTimestampSchema.parse('2026-08-31T00:00:00.000Z')
			})
			.run();
		await database()
			.insert(d1Schema.cacheLifecycle)
			.values({
				tenant,
				cacheKind: 'default',
				access: 'private',
				generation: firstCacheGeneration,
				updatedAt: isoTimestampSchema.parse(start.toISOString())
			})
			.run();

		const outcomes = [];

		for (let index = 0; index < 3; index += 1) {
			outcomes.push(
				await advanceFleetDataMigration(
					env,
					database(),
					deployment,
					descriptor(),
					`offboarded-${index.toString()}`,
					start
				)
			);
		}

		const rows = await database()
			.select({
				tenant: d1Schema.tenantDataMigration.tenant,
				status: d1Schema.tenantDataMigration.status,
				lastFailureJson: d1Schema.tenantDataMigration.lastFailureJson
			})
			.from(d1Schema.tenantDataMigration)
			.all();

		expect({ outcomes, rows }).toStrictEqual({
			outcomes: [
				{ outcome: 'running' },
				{ outcome: 'running' },
				{
					outcome: 'failed',
					failure: {
						code: 'fleet-data-migration-failed',
						detail:
							'{"code":"migration-invariant-failed","detail":"The offboarded tenant still has cache references or work"}'
					}
				}
			],
			rows: [
				{
					tenant: 'retired',
					status: 'failed',
					lastFailureJson:
						'{"code":"migration-invariant-failed","detail":"The offboarded tenant still has cache references or work"}'
				}
			]
		});
	});
});
