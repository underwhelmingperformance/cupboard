import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { DeploymentIdentity } from '@cupboard/protocol/deployment';
import {
	deploymentArtifactIdSchema,
	deploymentInstanceIdSchema
} from '@cupboard/protocol/deployment';
import type { RuntimeStageId } from '@cupboard/protocol/deployment-manifest';
import {
	subjectTokenTypeIdToken,
	tokenExchangeGrantType,
	tokenResponseSchema
} from '@cupboard/protocol/oidc';
import type { TenantStatus } from '@cupboard/protocol/tenants';
import { Miniflare, type MiniflareOptions } from 'miniflare';
import { z } from 'zod';

import { controlRpc } from '../../packages/cli/src/client/orpc.ts';
import type { DeploymentArtifact } from '../../packages/cli/src/deploy/artifact.ts';
import { buildArtifactFromTree } from '../../packages/cli/src/deploy/artifact.ts';
import { createEsbuildBundler } from '../../packages/cli/src/deploy/bundle.ts';
import type { CloudflareApi } from '../../packages/cli/src/deploy/cloudflare-api.ts';
import type { RuntimeStageObservation } from '../../packages/cli/src/deploy/deployment-runner.ts';
import type { DeploymentRecoveryClient } from '../../packages/cli/src/deploy/deployment-runner.ts';
import { databaseIdSchema } from '../../packages/cli/src/deploy/identifiers.ts';
import { applyD1Migrations } from '../../packages/cli/src/deploy/migrations.ts';
import {
	cacheNameSchema,
	storePathHashSchema,
	tenantIdSchema
} from '../../packages/nix-store/src/scalars.ts';
import {
	type FixtureTenant,
	fixtureTenants,
	predecessorD1Migration,
	predecessorVersionTag
} from '../fixtures/cache-deployment-predecessor/constants.ts';

import { StubOidcIssuer } from './oidc-issuer.ts';

const controlScript = 'cupboard';
const tenantScript = 'cupboard-tenant';
const databaseBinding = 'CUPBOARD_DB';
const databaseName = 'cupboard-upgrade';
const databaseId = databaseIdSchema.parse('cupboard-upgrade-database');
const blobsBinding = 'BLOBS';
const blobsBucket = 'cupboard-upgrade-blobs';
const recoveryBucket = 'cupboard-upgrade-recovery';
const maintenanceQueue = 'cupboard-upgrade-maintenance';
const pathHash = storePathHashSchema.parse('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const legacyCacheName = cacheNameSchema.parse('builds');
const attestationDigest = 'a'.repeat(64);
const narHash = 'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347';
const fileHash = 'sha256:0wzw5pz9bciz84825admrb4b848maxa2fh1isbsw4547mvra9czv';
const controlWrapSecret = 'AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK+2vcTL0tk=';
const operatorSubject = 'upgrade-deployment-operator';
const operatorAudience = 'upgrade-deployment-client';

const singleColumnRowsSchema = z.array(z.record(z.string(), z.unknown()));
const tenantRuntimeEvidenceSchema = z.strictObject({
	manifestId: z.string(),
	artifactId: z.string(),
	stage: z.string(),
	versionId: z.string().min(1),
	versionTag: z.string()
});
type TenantRuntimeEvidence = z.output<typeof tenantRuntimeEvidenceSchema>;
const deploymentRuntimePath = '/_cupboard/deployment-runtime';

class FixtureD1QueryShapeError extends Error {
	constructor(
		public readonly columnCount: number,
		public readonly value: unknown
	) {
		super('The D1 fixture query did not return exactly one text column');
		this.name = 'FixtureD1QueryShapeError';
	}
}

class FixtureRequestError extends Error {
	constructor(
		public readonly pathname: string,
		public readonly status: number,
		public readonly body: string
	) {
		super(`Fixture request ${pathname} failed with ${String(status)}: ${body}`);
		this.name = 'FixtureRequestError';
	}
}

class PredecessorSnapshotError extends Error {
	constructor(
		public readonly tenant: FixtureTenant,
		public readonly status: number
	) {
		super(`Predecessor snapshot for ${tenant} failed with ${String(status)}`);
		this.name = 'PredecessorSnapshotError';
	}
}

class RuntimeHealthError extends Error {
	constructor(
		public readonly runtime: 'control' | 'predecessor-pair',
		public readonly statuses: Readonly<Record<string, number>>
	) {
		super(
			`${runtime === 'control' ? 'Control runtime' : 'The predecessor Worker pair'} is not healthy: ${JSON.stringify(statuses)}`
		);
		this.name = 'RuntimeHealthError';
	}
}

class RuntimeEvidenceRequestError extends Error {
	constructor(
		public readonly runtime: 'control' | 'tenant',
		public readonly status: number
	) {
		super(
			`${runtime === 'control' ? 'Control' : 'Tenant'} runtime evidence failed with ${String(status)}`
		);
		this.name = 'RuntimeEvidenceRequestError';
	}
}

class RuntimeEvidenceMismatchError extends Error {
	constructor(
		public readonly expectedStage: RuntimeStageId,
		public readonly evidence: TenantRuntimeEvidence
	) {
		super(
			`Tenant runtime evidence does not match stage ${expectedStage}: ${JSON.stringify(evidence)}`
		);
		this.name = 'RuntimeEvidenceMismatchError';
	}
}

class DeploymentTokenExchangeError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: string
	) {
		super(`Deployment token exchange failed with ${String(status)}: ${body}`);
		this.name = 'DeploymentTokenExchangeError';
	}
}

class PredecessorMigrationMissingError extends Error {
	constructor(public readonly migration: string) {
		super(`The artifact does not contain predecessor migration ${migration}`);
		this.name = 'PredecessorMigrationMissingError';
	}
}

class ArtifactD1MigrationMissingError extends Error {
	constructor() {
		super('The deployment artifact does not contain a D1 migration');
		this.name = 'ArtifactD1MigrationMissingError';
	}
}

export interface StagedDeploymentPaths {
	readonly root: string;
	readonly d1: string;
	readonly durableObjects: string;
	readonly r2: string;
}

export interface PredecessorSnapshot {
	readonly migrationTags: readonly string[];
	readonly caches: readonly string[];
	readonly roots: readonly string[];
}

const predecessorSnapshotSchema = z.strictObject({
	migrationTags: z.array(z.string()),
	caches: z.array(z.string()),
	roots: z.array(z.string())
});
const terminalD1SnapshotSchema = z.strictObject({
	lastD1Migration: z.string(),
	deploymentState: z.string(),
	incompleteGlobalMigrations: z.number().int().nonnegative(),
	incompleteTenantMigrations: z.number().int().nonnegative(),
	incompleteLocalContracts: z.number().int().nonnegative()
});

export interface TerminalDeploymentSnapshot {
	readonly lastD1Migration: string;
	readonly deploymentState: string;
	readonly incompleteGlobalMigrations: number;
	readonly incompleteTenantMigrations: number;
	readonly incompleteLocalContracts: number;
	readonly generationNarInfoPresent: boolean;
	readonly generationAttestationListPresent: boolean;
	readonly legacyNarInfoPresent: boolean;
}

interface FixtureBundles {
	readonly control: string;
	readonly tenant: string;
}

type PersistedRuntime =
	| { readonly kind: 'predecessor'; readonly bundles: FixtureBundles }
	| { readonly kind: 'release'; readonly stage: RuntimeStageId };

function d1Api(
	database: Awaited<ReturnType<Miniflare['getD1Database']>>
): Pick<CloudflareApi, 'd1QueryBatch' | 'd1QueryRows'> {
	return {
		async d1QueryBatch(_databaseId, statements) {
			await database.batch(
				statements.map((statement) => database.prepare(statement))
			);
		},
		async d1QueryRows(_databaseId, sql) {
			const result = await database.prepare(sql).all();
			const rows = singleColumnRowsSchema.parse(result.results);

			return rows.map((row) => {
				const values = Object.values(row);
				const value = values.length === 1 ? values[0] : undefined;

				if (typeof value !== 'string') {
					throw new FixtureD1QueryShapeError(values.length, value);
				}

				return value;
			});
		}
	};
}

function persistenceOptions(
	paths: StagedDeploymentPaths
): Pick<MiniflareOptions, 'd1Persist' | 'durableObjectsPersist' | 'r2Persist'> {
	return {
		d1Persist: paths.d1,
		durableObjectsPersist: paths.durableObjects,
		r2Persist: paths.r2
	};
}

function commonBindings(artifactId: string, stage: RuntimeStageId) {
	return {
		CUPBOARD_LOCAL_DEV: 'true',
		CUPBOARD_RUNTIME_STAGE: stage,
		CUPBOARD_DEPLOYMENT_ARTIFACT_ID: artifactId,
		CUPBOARD_AUTH_ISSUER: 'cupboard',
		CUPBOARD_AUTH_AUDIENCE: 'cupboard',
		PUSH_ID_SIGNING_KEY: 'upgrade-fixture-push-signing-key',
		R2_ACCESS_KEY_ID: 'upgrade-fixture-access-key',
		R2_ACCOUNT_ID: 'upgrade-fixture-account',
		R2_BUCKET_NAME: blobsBucket,
		R2_SECRET_ACCESS_KEY: 'upgrade-fixture-secret-key'
	};
}

async function fixtureBundles(root: string): Promise<FixtureBundles> {
	const bundler = createEsbuildBundler();
	const directory = path.join(
		root,
		'tests/fixtures/cache-deployment-predecessor'
	);
	const [control, tenant] = await Promise.all([
		bundler.bundle(path.join(directory, 'control-worker.ts'), 'worker.js'),
		bundler.bundle(path.join(directory, 'tenant-worker.ts'), 'tenant-worker.js')
	]);

	return { control: control.code, tenant: tenant.code };
}

function predecessorOptions(
	paths: StagedDeploymentPaths,
	bundles: FixtureBundles
): MiniflareOptions {
	return {
		...persistenceOptions(paths),
		workers: [
			{
				name: controlScript,
				modules: true,
				script: bundles.control,
				compatibilityDate: '2026-05-15',
				compatibilityFlags: ['nodejs_compat'],
				durableObjects: {
					CUPBOARD_DO: {
						className: 'CupboardServer',
						scriptName: tenantScript,
						useSQLite: true
					}
				},
				serviceBindings: { CUPBOARD_TENANT: tenantScript },
				d1Databases: { [databaseBinding]: databaseName },
				r2Buckets: { [blobsBinding]: blobsBucket }
			},
			{
				name: tenantScript,
				modules: true,
				script: bundles.tenant,
				compatibilityDate: '2026-05-15',
				compatibilityFlags: ['nodejs_compat'],
				durableObjects: {
					CUPBOARD_DO: {
						className: 'CupboardServer',
						useSQLite: true
					}
				},
				d1Databases: { [databaseBinding]: databaseName },
				r2Buckets: { [blobsBinding]: blobsBucket },
				bindings: {
					CUPBOARD_AUTH_ISSUER: 'cupboard',
					CUPBOARD_AUTH_AUDIENCE: 'cupboard'
				}
			}
		]
	};
}

function currentOptions(
	paths: StagedDeploymentPaths,
	artifact: DeploymentArtifact,
	stage: RuntimeStageId
): MiniflareOptions {
	const tenantBindings = commonBindings(artifact.deploymentArtifactId, stage);
	const controlBindings = {
		...tenantBindings,
		CUPBOARD_CONTROL_AUDIENCE: 'cupboard-control',
		CONTROL_KEY_WRAP_SECRET: controlWrapSecret,
		CUPBOARD_SIGNUP_ISSUER: '',
		CUPBOARD_SIGNUP_AUDIENCE: '',
		CUPBOARD_SIGNUP_SUBJECT: '',
		CUPBOARD_SIGNUP_SECRET: ''
	};

	return {
		...persistenceOptions(paths),
		workers: [
			{
				name: controlScript,
				modules: true,
				script: artifact.controlBundle.code,
				compatibilityDate: artifact.config.control.compatibilityDate,
				compatibilityFlags: [...artifact.config.control.compatibilityFlags],
				versionMetadata: 'WORKER_VERSION',
				unsafeDirectSockets: [{ entrypoint: 'ControlDeploymentRuntime' }],
				durableObjects: {
					CUPBOARD_DO: {
						className: 'CupboardServer',
						scriptName: tenantScript,
						useSQLite: true
					}
				},
				serviceBindings: {
					CUPBOARD_TENANT: {
						name: tenantScript,
						entrypoint: 'CachedTenantReads'
					}
				},
				d1Databases: { [databaseBinding]: databaseName },
				r2Buckets: {
					[blobsBinding]: blobsBucket,
					DEPLOYMENT_RECOVERY: recoveryBucket
				},
				kvNamespaces: {
					TENANT_CACHE: 'cupboard-upgrade-tenant-cache',
					CRON_STATE: 'cupboard-upgrade-cron-state'
				},
				queueProducers: {
					MAINTENANCE_QUEUE: { queueName: maintenanceQueue }
				},
				bindings: controlBindings
			},
			{
				name: tenantScript,
				modules: true,
				script: artifact.tenantBundle.code,
				compatibilityDate: artifact.config.tenant.compatibilityDate,
				compatibilityFlags: [...artifact.config.tenant.compatibilityFlags],
				versionMetadata: 'WORKER_VERSION',
				unsafeDirectSockets: [{ entrypoint: 'CachedTenantReads' }],
				durableObjects: {
					CUPBOARD_DO: {
						className: 'CupboardServer',
						useSQLite: true
					}
				},
				d1Databases: { [databaseBinding]: databaseName },
				r2Buckets: { [blobsBinding]: blobsBucket },
				queueProducers: {
					MAINTENANCE_QUEUE: { queueName: maintenanceQueue }
				},
				bindings: tenantBindings
			}
		]
	};
}

function runtimeOptions(
	paths: StagedDeploymentPaths,
	artifact: DeploymentArtifact,
	runtime: PersistedRuntime
): MiniflareOptions {
	return runtime.kind === 'predecessor'
		? predecessorOptions(paths, runtime.bundles)
		: currentOptions(paths, artifact, runtime.stage);
}

async function persistencePaths(): Promise<StagedDeploymentPaths> {
	const root = await mkdtemp(
		path.join(tmpdir(), 'cupboard-staged-deployment-')
	);

	return {
		root,
		d1: path.join(root, 'd1'),
		durableObjects: path.join(root, 'durable-objects'),
		r2: path.join(root, 'r2')
	};
}

export class StagedDeploymentServer {
	static async start(checkoutRoot: string): Promise<StagedDeploymentServer> {
		const [paths, bundles, artifact] = await Promise.all([
			persistencePaths(),
			fixtureBundles(checkoutRoot),
			buildArtifactFromTree(checkoutRoot, createEsbuildBundler())
		]);
		const issuer = await StubOidcIssuer.start();
		const miniflare = new Miniflare(predecessorOptions(paths, bundles));
		const server = new StagedDeploymentServer(
			paths,
			artifact,
			issuer,
			miniflare,
			{ kind: 'predecessor', bundles }
		);

		await server.applyPredecessorSchema();

		return server;
	}

	private constructor(
		readonly paths: StagedDeploymentPaths,
		readonly artifact: DeploymentArtifact,
		private readonly issuer: StubOidcIssuer,
		private miniflare: Miniflare,
		private persistedRuntime: PersistedRuntime
	) {}

	private async connectDeploymentClient(): Promise<DeploymentRecoveryClient> {
		const externalToken = this.issuer.sign({
			aud: operatorAudience,
			sub: operatorSubject
		});
		const response = await this.workerFetch('/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: tokenExchangeGrantType,
				subject_token: externalToken,
				subject_token_type: subjectTokenTypeIdToken
			}).toString()
		});

		if (!response.ok) {
			throw new DeploymentTokenExchangeError(
				response.status,
				await response.text()
			);
		}

		const value: unknown = await response.json();
		const token = tokenResponseSchema.parse(value);
		const rpc = controlRpc(new URL('https://cupboard.invalid'), {
			credential: token.access_token,
			fetcher: (input, init) => this.workerFetch(input, init)
		});

		return {
			status: (input) => rpc.deployment.status(input),
			advance: (input) => rpc.deployment.advance(input),
			recover: (input) => rpc.deployment.recover(input),
			prepareSuccessor: (input) => rpc.deployment.prepareSuccessor(input),
			adoptPredecessor: (input) => rpc.deployment.adoptPredecessor(input)
		};
	}

	private async applyPredecessorSchema(): Promise<void> {
		const migrationIndex = this.artifact.d1Migrations.findIndex(
			(migration) => migration.name === predecessorD1Migration
		);

		if (migrationIndex === -1) {
			throw new PredecessorMigrationMissingError(predecessorD1Migration);
		}

		await applyD1Migrations(
			{
				queryBatch: (id, statements) => this.api.d1QueryBatch(id, statements),
				queryRows: (id, sql) => this.api.d1QueryRows(id, sql)
			},
			databaseId,
			this.artifact.d1Migrations.slice(0, migrationIndex + 1)
		);
	}

	private async seedD1(): Promise<void> {
		const database = await this.database();
		const createdAt = '2026-01-01T00:00:00.000Z';
		const statuses: readonly (readonly [FixtureTenant, TenantStatus])[] = [
			['upgrade-active', 'active'],
			['upgrade-suspended', 'suspended'],
			['upgrade-offboarding', 'offboarding'],
			['upgrade-offboarded', 'offboarded'],
			['upgrade-sleeping-0022', 'active'],
			['upgrade-sleeping-0024', 'active'],
			['upgrade-sleeping-0031', 'active']
		];

		await database.batch([
			database
				.prepare(
					`INSERT INTO global_admin (id, issuer, subject, claimed_at, audience)
					 VALUES ('singleton', ?, ?, ?, ?)`
				)
				.bind(this.issuer.issuer, operatorSubject, createdAt, operatorAudience),
			database
				.prepare(
					`INSERT INTO control_trust (id, issuer, audience, claims_json, permitted_grants_json, created_at)
					 VALUES ('signup', ?, ?, ?, '[{"type":"cupboard_wildcard"}]', ?)`
				)
				.bind(
					this.issuer.issuer,
					operatorAudience,
					JSON.stringify({ sub: operatorSubject }),
					createdAt
				),
			database
				.prepare(
					`INSERT INTO cas_object (digest, size, incarnation, stored_at, delete_after)
					 VALUES (?, 24, 1, ?, NULL)`
				)
				.bind(attestationDigest, createdAt),
			database
				.prepare(
					`INSERT INTO blob_state (nar_hash, file_hash, file_size, compression, nar_size, incarnation, verified_at, delete_after)
					 VALUES (?, ?, 12, 'zstd', 16, 1, ?, NULL)`
				)
				.bind(narHash, fileHash, createdAt)
		]);

		for (const [tenant, status] of statuses) {
			await database
				.prepare(
					`INSERT INTO tenant (id, status, read_mode, owner_issuer, owner_subject, owner_audience, config_version, created_at)
					 VALUES (?, ?, 'public', 'https://issuer.invalid', 'owner', 'owner-client', 1, ?)`
				)
				.bind(tenant, status, createdAt)
				.run();
		}

		for (const tenant of fixtureTenants.slice(0, 3)) {
			await database.batch([
				database
					.prepare(
						`INSERT INTO cache_lifecycle (tenant, cache, generation, deleted_at, updated_at)
						 VALUES (?, '', 1, NULL, ?)`
					)
					.bind(tenant, createdAt),
				database
					.prepare(
						`INSERT INTO cache_lifecycle (tenant, cache, generation, deleted_at, updated_at)
						 VALUES (?, 'builds', 1, NULL, ?)`
					)
					.bind(tenant, createdAt),
				database
					.prepare(
						`INSERT INTO cache_lifecycle (tenant, cache, generation, deleted_at, updated_at)
						 VALUES (?, 'private/secrets', 1, NULL, ?)`
					)
					.bind(tenant, createdAt),
				database
					.prepare(
						`INSERT INTO blob_ref (tenant, cache, store_path_hash, generation, nar_hash, cache_generation)
						 VALUES (?, 'builds', ?, 0, ?, NULL)`
					)
					.bind(tenant, pathHash, narHash),
				database
					.prepare(
						`INSERT INTO tenant_blob (tenant, nar_hash, file_size)
						 VALUES (?, ?, 12)`
					)
					.bind(tenant, narHash),
				database
					.prepare(
						`INSERT INTO tenant_usage (tenant, bytes, narinfos, blobs, cas_bytes, cas_blobs, quota_bytes, updated_at)
						 VALUES (?, 12, 1, 1, 24, 1, NULL, ?)`
					)
					.bind(tenant, createdAt),
				database
					.prepare(
						`INSERT INTO attestation_ref (tenant, cache, store_path_hash, generation, predicate_type, digest)
						 VALUES (?, 'builds', ?, 0, 'https://slsa.dev/provenance/v1', ?)`
					)
					.bind(tenant, pathHash, attestationDigest),
				database
					.prepare(
						`INSERT INTO tenant_cas_blob (tenant, digest, size)
						 VALUES (?, ?, 24)`
					)
					.bind(tenant, attestationDigest)
			]);
		}
	}

	private async seedLegacyR2Object(): Promise<void> {
		const tenant = tenantIdSchema.parse('upgrade-active');
		const key = `t/${tenant}/narinfo/${legacyCacheName}/${pathHash}`;
		const body = [
			`StorePath: /nix/store/${pathHash}-predecessor`,
			`URL: nar/${narHash}.nar.zst`,
			'Compression: zstd',
			`FileHash: ${fileHash}`,
			'FileSize: 12',
			`NARHash: ${narHash}`,
			'NARSize: 16',
			'References: ',
			''
		].join('\n');

		const bucket = await this.bucket();

		await bucket.put(key, body, {
			httpMetadata: { contentType: 'text/x-nix-narinfo; charset=utf-8' }
		});
		await bucket.put(`nar/${narHash}.nar.zst`, 'predecessor\n');
	}

	private async tenantRuntimeEvidence() {
		const direct = await this.miniflare.unsafeGetDirectURL(
			tenantScript,
			'CachedTenantReads'
		);
		const response = await fetch(new URL(deploymentRuntimePath, direct));

		if (!response.ok) {
			throw new RuntimeEvidenceRequestError('tenant', response.status);
		}

		const value: unknown = await response.json();

		return tenantRuntimeEvidenceSchema.parse(value);
	}

	private async controlRuntimeEvidence() {
		const direct = await this.miniflare.unsafeGetDirectURL(
			controlScript,
			'ControlDeploymentRuntime'
		);
		const response = await fetch(direct);

		if (!response.ok) {
			throw new RuntimeEvidenceRequestError('control', response.status);
		}

		const value: unknown = await response.json();

		return tenantRuntimeEvidenceSchema.parse(value);
	}

	private async expectOk(pathname: string, init?: RequestInit): Promise<void> {
		const response = await this.dispatch(pathname, init);

		if (!response.ok) {
			throw new FixtureRequestError(
				pathname,
				response.status,
				await response.text()
			);
		}
	}

	private async workerFetch(
		input: URL | RequestInfo,
		init?: RequestInit
	): Promise<Response> {
		const source =
			typeof input === 'string'
				? new URL(input, 'https://cupboard.invalid')
				: input;
		const request = new Request(source, init);
		const target = new URL(request.url);
		const ready = await this.miniflare.ready;

		target.protocol = ready.protocol;
		target.host = ready.host;

		return fetch(new Request(target, request));
	}

	get deployment(): DeploymentIdentity {
		return {
			artifactId: deploymentArtifactIdSchema.parse(
				this.artifact.deploymentArtifactId
			),
			instanceId: deploymentInstanceIdSchema.parse('b'.repeat(64))
		};
	}

	get finalD1Migration(): string {
		const migration = this.artifact.d1Migrations.at(-1);

		if (migration === undefined) {
			throw new ArtifactD1MigrationMissingError();
		}

		return migration.name;
	}

	get api(): Pick<
		CloudflareApi,
		'd1QueryBatch' | 'd1QueryRows' | 'getD1Bookmark' | 'restoreD1Database'
	> {
		return {
			d1QueryBatch: async (id, statements) =>
				d1Api(await this.database()).d1QueryBatch(id, statements),
			d1QueryRows: async (id, sql) =>
				d1Api(await this.database()).d1QueryRows(id, sql),
			getD1Bookmark: () => Promise.resolve('miniflare-recovery-point'),
			restoreD1Database: () =>
				Promise.resolve({
					bookmark: 'miniflare-recovery-point',
					undoBookmark: 'miniflare-recovery-undo'
				})
		};
	}

	async seedPredecessor(): Promise<void> {
		await this.seedD1();

		for (const tenant of fixtureTenants) {
			if (tenant === 'upgrade-offboarded') {
				continue;
			}

			await this.expectOk(`/fixture/tenant/${tenant}/seed`, { method: 'POST' });
		}

		await this.seedLegacyR2Object();
	}

	async writeLateLegacyState(tenant: FixtureTenant): Promise<void> {
		await this.expectOk(`/fixture/tenant/${tenant}/late-write`, {
			method: 'POST'
		});
	}

	async predecessorSnapshot(
		tenant: FixtureTenant
	): Promise<PredecessorSnapshot> {
		const response = await this.dispatch(`/fixture/tenant/${tenant}/snapshot`);

		if (!response.ok) {
			throw new PredecessorSnapshotError(tenant, response.status);
		}

		const value: unknown = await response.json();

		return predecessorSnapshotSchema.parse(value);
	}

	async terminalSnapshot(): Promise<TerminalDeploymentSnapshot> {
		const database = await this.database();
		const result = await database
			.prepare(
				`SELECT
					(SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1) AS lastD1Migration,
					(SELECT state_id FROM deployment_head WHERE id = 'current') AS deploymentState,
					(SELECT count(*) FROM global_data_migration WHERE status <> 'complete') AS incompleteGlobalMigrations,
					(SELECT count(*) FROM tenant_data_migration WHERE status NOT IN ('complete', 'not-applicable')) AS incompleteTenantMigrations,
					(SELECT count(*) FROM local_contract_migration WHERE phase <> 'complete') AS incompleteLocalContracts`
			)
			.first();
		const d1 = terminalD1SnapshotSchema.parse(result);
		const tenant = tenantIdSchema.parse('upgrade-active');
		const bucket = await this.bucket();
		const generationNarInfoKey = `t/${tenant}/narinfo/generation/1/named/${legacyCacheName}/${pathHash}`;
		const generationAttestationListKey = `t/${tenant}/attestations/generation/1/named/${legacyCacheName}/${pathHash}`;
		const legacyNarInfoKey = `t/${tenant}/narinfo/${legacyCacheName}/${pathHash}`;
		const [generationNarInfo, generationAttestationList, legacyNarInfo] =
			await Promise.all([
				bucket.head(generationNarInfoKey),
				bucket.head(generationAttestationListKey),
				bucket.head(legacyNarInfoKey)
			]);

		return {
			...d1,
			generationNarInfoPresent: generationNarInfo !== null,
			generationAttestationListPresent: generationAttestationList !== null,
			legacyNarInfoPresent: legacyNarInfo !== null
		};
	}

	async deployStage(stage: RuntimeStageId): Promise<RuntimeStageObservation> {
		await this.miniflare.setOptions(
			currentOptions(this.paths, this.artifact, stage)
		);
		this.persistedRuntime = { kind: 'release', stage };
		const health = await this.workerFetch('/_health');

		if (!health.ok) {
			throw new RuntimeHealthError('control', { control: health.status });
		}

		const [control, tenant] = await Promise.all([
			this.controlRuntimeEvidence(),
			this.tenantRuntimeEvidence()
		]);

		if (
			tenant.stage !== stage ||
			tenant.artifactId !== this.artifact.deploymentArtifactId ||
			tenant.manifestId !== this.artifact.deploymentManifestId
		) {
			throw new RuntimeEvidenceMismatchError(stage, tenant);
		}

		return {
			kind: 'runtime-stage',
			stage,
			tenantVersionId: tenant.versionId,
			controlVersionId: control.versionId,
			tenantTrafficPercent: 100,
			controlTrafficPercent: 100
		};
	}

	async restart(): Promise<void> {
		await this.miniflare.dispose();
		this.miniflare = new Miniflare(
			runtimeOptions(this.paths, this.artifact, this.persistedRuntime)
		);
	}

	async legacyRuntimeObservation(): Promise<{
		readonly tenantVersionTag: string;
		readonly controlVersionTag: string;
		readonly tenantTrafficPercent: 100;
		readonly controlTrafficPercent: 100;
	}> {
		const [control, tenant] = await Promise.all([
			this.dispatch('/_health'),
			this.dispatch('/fixture/tenant-health')
		]);

		if (!control.ok || !tenant.ok) {
			throw new RuntimeHealthError('predecessor-pair', {
				control: control.status,
				tenant: tenant.status
			});
		}

		return {
			tenantVersionTag: predecessorVersionTag,
			controlVersionTag: predecessorVersionTag,
			tenantTrafficPercent: 100,
			controlTrafficPercent: 100
		};
	}

	async deploymentClient(): Promise<DeploymentRecoveryClient> {
		await this.connectDeploymentClient();

		return {
			status: async (input) => {
				const client = await this.connectDeploymentClient();

				return client.status(input);
			},
			advance: async (input) => {
				const client = await this.connectDeploymentClient();

				return client.advance(input);
			},
			recover: async (input) => {
				const client = await this.connectDeploymentClient();

				return client.recover(input);
			},
			prepareSuccessor: async (input) => {
				const client = await this.connectDeploymentClient();

				return client.prepareSuccessor(input);
			},
			adoptPredecessor: async (input) => {
				const client = await this.connectDeploymentClient();

				return client.adoptPredecessor(input);
			}
		};
	}

	async elapseWriterDrainDeadline(): Promise<void> {
		const database = await this.database();

		await database
			.prepare(
				"UPDATE deployment_writer_cutover SET maximum_legacy_deadline = '1970-01-01T00:00:00.000Z' WHERE completed_at IS NULL"
			)
			.run();
	}

	async dispatch(pathname: string, init?: RequestInit): Promise<Response> {
		return this.workerFetch(pathname, init);
	}

	async database(): Promise<Awaited<ReturnType<Miniflare['getD1Database']>>> {
		return this.miniflare.getD1Database(databaseBinding, controlScript);
	}

	async bucket(): Promise<Awaited<ReturnType<Miniflare['getR2Bucket']>>> {
		return this.miniflare.getR2Bucket(blobsBinding, controlScript);
	}

	async stop(): Promise<void> {
		await Promise.all([this.miniflare.dispose(), this.issuer.stop()]);
		await rm(this.paths.root, { recursive: true, force: true });
	}
}

export const stagedDeploymentDatabaseId = databaseId;
