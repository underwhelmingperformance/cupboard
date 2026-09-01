import { cacheCatalogueMigration } from '@cupboard/protocol/cache-deployment-manifest';
import {
	deploymentArtifactIdSchema,
	type DeploymentIdentity,
	deploymentInstanceIdSchema
} from '@cupboard/protocol/deployment';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { deploymentManifest } from '../deployment-manifest.generated.ts';

import { advanceFleetDataMigration } from './deployment-data.ts';

const deployment: DeploymentIdentity = {
	artifactId: deploymentArtifactIdSchema.parse('a'.repeat(64)),
	instanceId: deploymentInstanceIdSchema.parse('b'.repeat(64))
};

function database() {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

beforeEach(async () => {
	const d1 = database();
	await d1.delete(d1Schema.tenantDataMigration);
	await d1.delete(d1Schema.globalDataMigration);
	await d1.delete(d1Schema.tenant);
});

describe('deployment data migration', () => {
	it('records and resumes an empty fixed cohort idempotently', async () => {
		const descriptor = deploymentManifest.dataMigrations.find(
			(candidate) => candidate.id === cacheCatalogueMigration
		);

		if (descriptor === undefined) {
			throw new Error('The cache catalogue migration is not registered');
		}

		const first = await advanceFleetDataMigration(
			env,
			database(),
			deployment,
			descriptor,
			'attempt-one',
			new Date('2026-09-01T00:00:00.000Z')
		);
		const second = await advanceFleetDataMigration(
			env,
			database(),
			deployment,
			descriptor,
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
});
