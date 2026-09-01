import {
	cacheDeploymentManifest,
	d1MigrationId,
	durableObjectMigrationId
} from '@cupboard/protocol/cache-deployment-manifest';
import {
	deploymentArtifactIdSchema,
	deploymentInstanceIdSchema,
	deploymentManifestIdSchema
} from '@cupboard/protocol/deployment';
import type { LegacyBootstrapTransition } from '@cupboard/protocol/deployment-manifest';
import { describe, expect, it, vi } from 'vitest';

import type { CloudflareApi } from './cloudflare-api.ts';
import {
	bootstrapLegacyDeployment,
	initialiseFreshDeployment,
	LegacyDeploymentBootstrapError
} from './deployment-bootstrap.ts';
import type { RuntimeStageObservation } from './deployment-runner.ts';
import { databaseIdSchema } from './identifiers.ts';
import type { D1Migration } from './migrations.ts';

const manifest = cacheDeploymentManifest({
	d1: [
		'0019_nar_read_authority.sql',
		'0020_deployment_ledger.sql',
		'0020a_deployment_runtime_controls.sql',
		'0021_cache_access_expand.sql',
		'0022_cache_access_legacy_write_mirror.sql',
		'0023_cache_access_backfill.sql',
		'0024_cache_access_contract_assertions.sql',
		'0025_cache_access_compatible_contract.sql',
		'0026_cache_incarnation_expand.sql',
		'0027_cache_generation_contract_assertions.sql',
		'0028_drop_cache_credential_lifecycle_guard.sql',
		'0029_cache_identity_contract.sql',
		'0030_cache_credential_lifecycle_guard.sql',
		'0031_cache_lifecycle_lookup_index.sql',
		'0032_chemical_silver_surfer.sql',
		'0032a_suspend_cache_credential_lifecycle_guard.sql',
		'0033_parallel_leo.sql',
		'0034_abnormal_the_stranger.sql',
		'0034a_restore_cache_credential_lifecycle_guard.sql'
	].map((id) => ({ id: d1MigrationId(id), sha256: '1'.repeat(64) })),
	durableObject: [
		'0041_pending_upload_recorded_verdict',
		'0049_cache_retention_migration_rules',
		'0056_small_longshot'
	].map((id) => ({
		id: durableObjectMigrationId(id),
		sha256: '2'.repeat(64)
	}))
});
function soleBootstrapTransition(): LegacyBootstrapTransition {
	const result = manifest.bootstrapTransitions[0];

	if (result === undefined) {
		throw new Error(
			'The cache deployment manifest has no bootstrap transition'
		);
	}

	return result;
}

const transition = soleBootstrapTransition();

const source = manifest.legacyRuntimeFingerprints.find(
	(fingerprint) => fingerprint.id === transition.sourceFingerprint
);

if (source === undefined) {
	throw new Error('The bootstrap transition has no legacy source fingerprint');
}

const migrations: D1Migration[] = manifest.d1Migrations.map((migration) => ({
	name: migration.id,
	sha256: migration.sha256,
	statements: [`SELECT '${migration.id}';`]
}));
const legacyEnd = migrations.findIndex(
	(migration) => migration.name === source.d1Migration
);

if (legacyEnd === -1) {
	throw new Error('The source migration is absent from the manifest');
}

const deployment = {
	artifactId: deploymentArtifactIdSchema.parse('a'.repeat(64)),
	instanceId: deploymentInstanceIdSchema.parse('b'.repeat(64))
};
const artifact = {
	d1Migrations: migrations,
	deploymentManifest: manifest,
	deploymentManifestId: deploymentManifestIdSchema.parse('c'.repeat(64))
};
const expectedHead = [
	artifact.deploymentManifestId,
	deployment.artifactId,
	deployment.instanceId,
	transition.to
].join(':');

function bootstrapApi(options?: { readonly head?: string }): {
	readonly api: Pick<CloudflareApi, 'd1QueryBatch' | 'd1QueryRows'>;
	readonly batches: string[][];
} {
	const applied = migrations
		.slice(0, legacyEnd + 1)
		.map((migration) => migration.name);
	const batches: string[][] = [];
	let head = options?.head;

	if (head !== undefined) {
		applied.push(...transition.migrations);
	}

	return {
		batches,
		api: {
			d1QueryBatch(_databaseId, statements) {
				batches.push([...statements]);

				for (const migration of migrations) {
					if (
						statements.includes(
							`INSERT INTO d1_migrations (name) VALUES ('${migration.name}');`
						)
					) {
						applied.push(migration.name);
					}
				}

				if (
					statements.some((statement) => statement.includes('deployment_head'))
				) {
					head ??= expectedHead;
				}

				return Promise.resolve();
			},
			d1QueryRows(_databaseId, sql) {
				if (sql.includes('deployment_head')) {
					return Promise.resolve(head === undefined ? [] : [head]);
				}

				if (sql.includes('structural_migration_checksum')) {
					return Promise.resolve([]);
				}

				return Promise.resolve([...applied]);
			}
		}
	};
}

describe('bootstrapLegacyDeployment', () => {
	it('applies the declared bootstrap, deploys foundation and seeds the ledger', async () => {
		const { api, batches } = bootstrapApi();
		const deployRuntime = vi.fn<
			(
				transition: LegacyBootstrapTransition
			) => Promise<RuntimeStageObservation>
		>(() =>
			Promise.resolve({
				kind: 'runtime-stage',
				stage: transition.stage,
				tenantVersionId: 'tenant-version',
				controlVersionId: 'control-version',
				tenantTrafficPercent: 100,
				controlTrafficPercent: 100
			})
		);

		await expect(
			bootstrapLegacyDeployment({
				api,
				databaseId: databaseIdSchema.parse('database-1'),
				artifact,
				deployment,
				deployRuntime
			})
		).resolves.toBeUndefined();
		expect(deployRuntime).toHaveBeenCalledExactlyOnceWith(transition);
		expect(
			batches.some((batch) =>
				batch.some((statement) => statement.includes('deployment_head'))
			)
		).toBe(true);
	});

	it('returns without side effects when the exact foundation head exists', async () => {
		const { api, batches } = bootstrapApi({ head: expectedHead });
		const deployRuntime = vi.fn();

		await expect(
			bootstrapLegacyDeployment({
				api,
				databaseId: databaseIdSchema.parse('database-1'),
				artifact,
				deployment,
				deployRuntime
			})
		).resolves.toBeUndefined();
		expect(deployRuntime).not.toHaveBeenCalled();
		expect(batches).toStrictEqual([]);
	});

	it('refuses to overwrite a foreign deployment head', async () => {
		const { api } = bootstrapApi({ head: 'foreign:deployment:head:state' });

		await expect(
			bootstrapLegacyDeployment({
				api,
				databaseId: databaseIdSchema.parse('database-1'),
				artifact,
				deployment,
				deployRuntime: () => {
					throw new Error('A foreign ledger triggered a runtime deployment');
				}
			})
		).rejects.toBeInstanceOf(LegacyDeploymentBootstrapError);
	});
});

describe('initialiseFreshDeployment', () => {
	it('records checksums and the terminal state for a complete fresh schema', async () => {
		const batches: string[][] = [];
		let head: string | undefined;
		const api: Pick<CloudflareApi, 'd1QueryBatch' | 'd1QueryRows'> = {
			d1QueryBatch(_databaseId, statements) {
				batches.push([...statements]);
				head = [
					artifact.deploymentManifestId,
					deployment.artifactId,
					deployment.instanceId,
					manifest.terminalState
				].join(':');

				return Promise.resolve();
			},
			d1QueryRows(_databaseId, sql) {
				return Promise.resolve(
					sql.includes('deployment_head')
						? head === undefined
							? []
							: [head]
						: migrations.map((migration) => migration.name)
				);
			}
		};

		await expect(
			initialiseFreshDeployment({
				api,
				databaseId: databaseIdSchema.parse('database-1'),
				artifact,
				deployment
			})
		).resolves.toBeUndefined();
		expect(batches).toHaveLength(1);
		const batch = batches[0];

		if (batch === undefined) {
			throw new Error('The fresh initialisation wrote no D1 batch');
		}

		expect(batch.slice(0, -1)).toStrictEqual(
			migrations.map(
				(migration) =>
					`INSERT INTO structural_migration_checksum (kind, migration_id, sha256, applied_at) VALUES ('d1', '${migration.name}', '${migration.sha256}', CURRENT_TIMESTAMP) ON CONFLICT (kind, migration_id) DO UPDATE SET sha256 = excluded.sha256;`
			)
		);
		expect(batch.at(-1)).toContain(`'${manifest.terminalState}'`);
	});

	it('refuses to record a fresh head before the complete schema is applied', async () => {
		const api: Pick<CloudflareApi, 'd1QueryBatch' | 'd1QueryRows'> = {
			d1QueryBatch: () => Promise.resolve(),
			d1QueryRows: () =>
				Promise.resolve(
					migrations.slice(0, -1).map((migration) => migration.name)
				)
		};

		await expect(
			initialiseFreshDeployment({
				api,
				databaseId: databaseIdSchema.parse('database-1'),
				artifact,
				deployment
			})
		).rejects.toThrow('complete declared D1 schema');
	});
});
