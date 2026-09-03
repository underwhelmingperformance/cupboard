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
import { z } from 'zod';

import { canonicalJson } from './canonical-json.ts';
import type { CloudflareApi } from './cloudflare-api.ts';
import {
	bootstrapLegacyDeployment,
	claimFreshInstallation,
	type FreshInstallationClaim,
	initialiseFreshDeployment,
	LegacyDeploymentBootstrapError,
	recordFreshInstallationResources,
	sealFreshInstallationTopology
} from './deployment-bootstrap.ts';
import type { RuntimeStageObservation } from './deployment-runner.ts';
import { cloudflareAccountIdSchema, databaseIdSchema } from './identifiers.ts';
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
const sealedFreshClaim: FreshInstallationClaim = {
	databaseId: databaseIdSchema.parse('database-1'),
	accountId: cloudflareAccountIdSchema.parse('account-1'),
	artifactId: deployment.artifactId,
	intendedResources: { 'd1:cupboard': 'cupboard' },
	observedResources: { 'd1:cupboard': 'database-1' },
	instanceId: deployment.instanceId,
	topologyDigest: 'd'.repeat(64),
	phase: 'topology-sealed',
	claimId: '0199a0ea-1a00-7000-8000-000000000001',
	claimRevision: 2,
	claimOwner: '0199a0ea-1a00-7000-8000-000000000002',
	claimExpiresAt: '2026-09-02T12:15:00.000Z',
	updatedAt: '2026-09-02T12:00:00.000Z'
};
const expectedHead = [
	artifact.deploymentManifestId,
	deployment.artifactId,
	deployment.instanceId,
	transition.to
].join(':');
const legacyRuntimeObservation = {
	tenantVersionTag: source.tenantVersionTag,
	controlVersionTag: source.controlVersionTag,
	tenantTrafficPercent: 100,
	controlTrafficPercent: 100
};

function bootstrapApi(options?: { readonly head?: string }): {
	readonly api: Pick<CloudflareApi, 'd1QueryBatch' | 'd1QueryRows'>;
	readonly batches: string[][];
} {
	const applied = migrations
		.slice(0, legacyEnd + 1)
		.map((migration) => migration.name);
	const batches: string[][] = [];
	const evidence = new Map<
		string,
		{ readonly sha256?: string; readonly verificationState: string }
	>();
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

					if (
						statements.some((statement) => statement.includes(migration.sha256))
					) {
						evidence.set(migration.name, {
							sha256: migration.sha256,
							verificationState: 'verified'
						});
					}
				}

				if (
					statements.some((statement) =>
						statement.includes("SELECT 'd1', name, NULL")
					)
				) {
					for (const name of applied) {
						if (!evidence.has(name)) {
							evidence.set(name, {
								verificationState: 'unverified-baseline'
							});
						}
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
					return Promise.resolve(
						[...evidence].map(
							([name, record]) =>
								`${name}:${record.sha256 ?? ''}:${record.verificationState}`
						)
					);
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
				observeLegacyRuntime: () => Promise.resolve(legacyRuntimeObservation),
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
				observeLegacyRuntime: () => Promise.resolve(legacyRuntimeObservation),
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
				observeLegacyRuntime: () => Promise.resolve(legacyRuntimeObservation),
				deployRuntime: () => {
					throw new Error('A foreign ledger triggered a runtime deployment');
				}
			})
		).rejects.toBeInstanceOf(LegacyDeploymentBootstrapError);
	});

	it('refuses a predecessor runtime which does not match the manifest', async () => {
		const { api, batches } = bootstrapApi();
		const deployRuntime = vi.fn();

		await expect(
			bootstrapLegacyDeployment({
				api,
				databaseId: databaseIdSchema.parse('database-1'),
				artifact,
				deployment,
				observeLegacyRuntime: () =>
					Promise.resolve({
						...legacyRuntimeObservation,
						tenantVersionTag: 'unexpected-predecessor'
					}),
				deployRuntime
			})
		).rejects.toThrow(
			'The deployed predecessor Workers do not match the manifest legacy fingerprint'
		);
		expect({
			batches,
			deployRuntimeCalls: deployRuntime.mock.calls
		}).toStrictEqual({
			batches: [],
			deployRuntimeCalls: []
		});
	});
});

describe('fresh installation claim', () => {
	it('claims an empty database and seals the observed topology in order', async () => {
		const databaseId = databaseIdSchema.parse('database-1');
		const accountId = cloudflareAccountIdSchema.parse('account-1');
		const intendedResources = {
			'd1:cupboard': 'cupboard',
			'r2:blobs': 'blobs'
		};
		const observedResources = {
			'd1:cupboard': 'database-1',
			'r2:blobs': 'blobs'
		};
		const claimId = '0199a0ea-1a00-7000-8000-000000000011';
		const claimOwner = '0199a0ea-1a00-7000-8000-000000000012';
		const ids = [claimId, claimOwner];
		const absent = z.null().parse(JSON.parse('null'));
		let hasClaimTable = false;
		let stored: FreshInstallationClaim | undefined;
		const currentClaim = (): FreshInstallationClaim => {
			if (stored === undefined) {
				throw new Error('The fake database has no fresh-install claim');
			}

			return stored;
		};
		const api: Pick<CloudflareApi, 'd1QueryBatch' | 'd1QueryRows'> = {
			d1QueryRows(_databaseId, sql) {
				if (sql.includes('sqlite_master')) {
					return Promise.resolve(
						hasClaimTable ? ['fresh_installation_bootstrap_claim'] : []
					);
				}

				return Promise.resolve(
					stored === undefined ? [] : [JSON.stringify(stored)]
				);
			},
			d1QueryBatch(_databaseId, statements) {
				if (
					statements.some((statement) =>
						statement.startsWith(
							'CREATE TABLE IF NOT EXISTS fresh_installation_bootstrap_claim'
						)
					)
				) {
					hasClaimTable = true;
				}

				if (
					statements.some((statement) =>
						statement.startsWith(
							'INSERT INTO fresh_installation_bootstrap_claim'
						)
					)
				) {
					stored = {
						databaseId,
						accountId,
						artifactId: deployment.artifactId,
						intendedResources,
						observedResources: {},
						instanceId: absent,
						topologyDigest: absent,
						phase: 'claimed',
						claimId,
						claimRevision: 0,
						claimOwner,
						claimExpiresAt: '2026-09-02T12:15:00.000Z',
						updatedAt: '2026-09-02T12:00:00.000Z'
					};
				}

				if (
					statements.some((statement) =>
						statement.includes("phase = 'resources-created'")
					)
				) {
					stored = {
						...currentClaim(),
						observedResources,
						phase: 'resources-created',
						claimRevision: 1
					};
				}

				if (
					statements.some((statement) =>
						statement.includes("phase = 'topology-sealed'")
					)
				) {
					stored = {
						...currentClaim(),
						instanceId: deployment.instanceId,
						topologyDigest: createHash('sha256')
							.update(canonicalJson(observedResources))
							.digest('hex'),
						phase: 'topology-sealed',
						claimRevision: 2
					};
				}

				return Promise.resolve();
			}
		};
		const claimed = await claimFreshInstallation({
			api,
			databaseId,
			accountId,
			artifactId: deployment.artifactId,
			intendedResources,
			now: new Date('2026-09-02T12:00:00.000Z'),
			createId: () => ids.shift() ?? ''
		});
		const recorded = await recordFreshInstallationResources({
			api,
			claim: claimed,
			observedResources,
			now: new Date('2026-09-02T12:01:00.000Z')
		});

		await expect(
			sealFreshInstallationTopology({
				api,
				claim: recorded,
				deployment,
				now: new Date('2026-09-02T12:02:00.000Z')
			})
		).resolves.toStrictEqual({
			...recorded,
			instanceId: deployment.instanceId,
			topologyDigest: createHash('sha256')
				.update(canonicalJson(observedResources))
				.digest('hex'),
			phase: 'topology-sealed',
			claimRevision: 2
		});
	});

	it('refuses a partial database which has no fresh-install claim', async () => {
		const api: Pick<CloudflareApi, 'd1QueryBatch' | 'd1QueryRows'> = {
			d1QueryBatch: () =>
				Promise.reject(new Error('The partial database was modified')),
			d1QueryRows: () => Promise.resolve(['blob_state'])
		};

		await expect(
			claimFreshInstallation({
				api,
				databaseId: databaseIdSchema.parse('database-1'),
				accountId: cloudflareAccountIdSchema.parse('account-1'),
				artifactId: deployment.artifactId,
				intendedResources: {}
			})
		).rejects.toThrow(
			'The database is not empty and has no fresh-install bootstrap claim'
		);
	});
});

describe('initialiseFreshDeployment', () => {
	it('records checksums and the terminal state for a complete fresh schema', async () => {
		const batches: string[][] = [];
		let head: string | undefined;
		let claim = sealedFreshClaim;
		let areChecksumsRecorded = false;
		const api: Pick<CloudflareApi, 'd1QueryBatch' | 'd1QueryRows'> = {
			d1QueryBatch(_databaseId, statements) {
				batches.push([...statements]);
				areChecksumsRecorded = true;
				head = [
					artifact.deploymentManifestId,
					deployment.artifactId,
					deployment.instanceId,
					manifest.terminalState
				].join(':');
				claim = {
					...claim,
					phase: 'schema-applied',
					claimRevision: claim.claimRevision + 1
				};

				return Promise.resolve();
			},
			d1QueryRows(_databaseId, sql) {
				if (sql.includes('fresh_installation_bootstrap_claim')) {
					return Promise.resolve([JSON.stringify(claim)]);
				}

				if (sql.includes("migration_id || ':' || sha256")) {
					return Promise.resolve(
						areChecksumsRecorded
							? migrations.map(
									(migration) => `${migration.name}:${migration.sha256}`
								)
							: []
					);
				}

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
				claim: sealedFreshClaim,
				deployment
			})
		).resolves.toStrictEqual({
			...sealedFreshClaim,
			phase: 'schema-applied',
			claimRevision: 3
		});
		expect(batches).toHaveLength(1);
		const batch = batches[0];

		if (batch === undefined) {
			throw new Error('The fresh initialisation wrote no D1 batch');
		}

		expect(batch.slice(0, migrations.length)).toStrictEqual(
			migrations.map(
				(migration) =>
					`INSERT INTO structural_migration_checksum (kind, migration_id, sha256, applied_at) VALUES ('d1', '${migration.name}', '${migration.sha256}', CURRENT_TIMESTAMP) ON CONFLICT (kind, migration_id) DO NOTHING;`
			)
		);
		expect(
			batch.some((statement) =>
				statement.includes(`'${manifest.terminalState}'`)
			)
		).toBe(true);
	});

	it('refuses conflicting migration checksum evidence before finalisation', async () => {
		const firstMigration = migrations[0];

		if (firstMigration === undefined) {
			throw new Error('The deployment fixture has no D1 migrations');
		}

		let writes = 0;
		const api: Pick<CloudflareApi, 'd1QueryBatch' | 'd1QueryRows'> = {
			d1QueryBatch() {
				writes += 1;
				return Promise.resolve();
			},
			d1QueryRows(_databaseId, sql) {
				if (sql.includes("migration_id || ':' || sha256")) {
					return Promise.resolve([`${firstMigration.name}:conflicting`]);
				}

				return Promise.resolve(migrations.map((migration) => migration.name));
			}
		};

		await expect(
			initialiseFreshDeployment({
				api,
				databaseId: databaseIdSchema.parse('database-1'),
				artifact,
				claim: sealedFreshClaim,
				deployment
			})
		).rejects.toThrow('conflicting D1 migration checksums');
		expect(writes).toBe(0);
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
				claim: sealedFreshClaim,
				deployment
			})
		).rejects.toThrow('complete declared D1 schema');
	});
});
import { createHash } from 'node:crypto';
