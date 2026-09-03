import { createHash, randomUUID } from 'node:crypto';

import {
	deploymentArtifactIdSchema,
	type DeploymentIdentity,
	deploymentInstanceIdSchema
} from '@cupboard/protocol/deployment';
import type {
	DeploymentManifestBody,
	LegacyBootstrapTransition,
	LegacyRuntimeFingerprint
} from '@cupboard/protocol/deployment-manifest';
import { z } from 'zod';

import type { DeploymentArtifact } from './artifact.ts';
import { canonicalJson } from './canonical-json.ts';
import type { CloudflareApi } from './cloudflare-api.ts';
import type { RuntimeStageObservation } from './deployment-runner.ts';
import {
	type CloudflareAccountId,
	cloudflareAccountIdSchema,
	type DatabaseId,
	databaseIdSchema
} from './identifiers.ts';
import { applyLegacyBootstrapD1Migrations } from './migrations.ts';

export class LegacyDeploymentBootstrapError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LegacyDeploymentBootstrapError';
	}
}

type LegacyBootstrapArtifact = Pick<
	DeploymentArtifact,
	'd1Migrations' | 'deploymentManifest' | 'deploymentManifestId'
>;

interface LegacyDeploymentBootstrapOptions {
	readonly api: Pick<CloudflareApi, 'd1QueryBatch' | 'd1QueryRows'>;
	readonly databaseId: DatabaseId;
	readonly artifact: LegacyBootstrapArtifact;
	readonly deployment: DeploymentIdentity;
	readonly observeLegacyRuntime: () => Promise<LegacyRuntimeObservation>;
	readonly deployRuntime: (
		transition: LegacyBootstrapTransition
	) => Promise<RuntimeStageObservation>;
}

export interface LegacyRuntimeObservation {
	readonly tenantVersionTag: string;
	readonly controlVersionTag: string;
	readonly tenantTrafficPercent: number;
	readonly controlTrafficPercent: number;
}

interface FreshDeploymentInitialisationOptions {
	readonly api: Pick<CloudflareApi, 'd1QueryBatch' | 'd1QueryRows'>;
	readonly databaseId: DatabaseId;
	readonly artifact: LegacyBootstrapArtifact;
	readonly deployment: DeploymentIdentity;
	readonly claim: FreshInstallationClaim;
}

type DeploymentLedgerOptions = Pick<
	LegacyDeploymentBootstrapOptions,
	'api' | 'databaseId'
>;

function quoteSql(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

const freshInstallationPhaseSchema = z.enum([
	'claimed',
	'resources-created',
	'topology-sealed',
	'schema-applied',
	'tenant-uploaded',
	'control-uploaded',
	'runtime-deployed',
	'administrator-onboarded',
	'complete'
]);

export type FreshInstallationPhase = z.infer<
	typeof freshInstallationPhaseSchema
>;

const freshInstallationClaimSchema = z.strictObject({
	databaseId: databaseIdSchema,
	accountId: cloudflareAccountIdSchema,
	artifactId: deploymentArtifactIdSchema,
	intendedResources: z.record(z.string(), z.string()),
	observedResources: z.record(z.string(), z.string()),
	instanceId: deploymentInstanceIdSchema.nullable(),
	topologyDigest: z
		.string()
		.regex(/^[\da-f]{64}$/)
		.nullable(),
	phase: freshInstallationPhaseSchema,
	claimId: z.uuid(),
	claimRevision: z.int().nonnegative(),
	claimOwner: z.uuid(),
	claimExpiresAt: z.iso.datetime(),
	updatedAt: z.iso.datetime()
});

export type FreshInstallationClaim = z.infer<
	typeof freshInstallationClaimSchema
>;

interface ClaimFreshInstallationOptions {
	readonly api: Pick<CloudflareApi, 'd1QueryBatch' | 'd1QueryRows'>;
	readonly databaseId: DatabaseId;
	readonly accountId: CloudflareAccountId;
	readonly artifactId: DeploymentIdentity['artifactId'];
	readonly intendedResources: Readonly<Record<string, string>>;
	readonly now?: Date;
	readonly createId?: () => string;
}

interface AdvanceFreshInstallationOptions {
	readonly api: Pick<CloudflareApi, 'd1QueryBatch' | 'd1QueryRows'>;
	readonly claim: FreshInstallationClaim;
	readonly expectedPhase: FreshInstallationPhase;
	readonly phase: FreshInstallationPhase;
	readonly observedResources?: Readonly<Record<string, string>>;
	readonly deployment?: DeploymentIdentity;
	readonly now?: Date;
}

const freshInstallationClaimTable = 'fresh_installation_bootstrap_claim';
const freshInstallationClaimSql = `CREATE TABLE IF NOT EXISTS ${freshInstallationClaimTable} (
	database_id TEXT PRIMARY KEY NOT NULL,
	account_id TEXT NOT NULL,
	artifact_id TEXT NOT NULL,
	intended_resources_json TEXT NOT NULL,
	observed_resources_json TEXT NOT NULL,
	instance_id TEXT,
	topology_digest TEXT,
	phase TEXT NOT NULL,
	claim_id TEXT NOT NULL,
	claim_revision INTEGER NOT NULL,
	claim_owner TEXT NOT NULL,
	claim_expires_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	CHECK (claim_revision >= 0),
	CHECK ((phase IN ('claimed', 'resources-created') AND instance_id IS NULL AND topology_digest IS NULL) OR (phase NOT IN ('claimed', 'resources-created') AND instance_id IS NOT NULL AND topology_digest IS NOT NULL))
);`;
const freshClaimDurationMilliseconds = 15 * 60 * 1000;

function claimExpiry(now: Date): string {
	return new Date(now.getTime() + freshClaimDurationMilliseconds).toISOString();
}

function topologyDigest(resources: Readonly<Record<string, string>>): string {
	return createHash('sha256').update(canonicalJson(resources)).digest('hex');
}

async function readFreshInstallationClaim(
	options: Pick<ClaimFreshInstallationOptions, 'api' | 'databaseId'>
): Promise<FreshInstallationClaim | undefined> {
	const rows = await options.api.d1QueryRows(
		options.databaseId,
		`SELECT json_object(
			'databaseId', database_id,
			'accountId', account_id,
			'artifactId', artifact_id,
			'intendedResources', json(intended_resources_json),
			'observedResources', json(observed_resources_json),
			'instanceId', instance_id,
			'topologyDigest', topology_digest,
			'phase', phase,
			'claimId', claim_id,
			'claimRevision', claim_revision,
			'claimOwner', claim_owner,
			'claimExpiresAt', claim_expires_at,
			'updatedAt', updated_at
		) AS claim FROM ${freshInstallationClaimTable} WHERE database_id = ${quoteSql(options.databaseId)};`
	);
	const [row, ...extra] = rows;

	if (extra.length > 0) {
		throw new LegacyDeploymentBootstrapError(
			'The fresh-install bootstrap contains duplicate database claims'
		);
	}

	if (row === undefined) {
		return;
	}

	const parsed: unknown = JSON.parse(row);

	return freshInstallationClaimSchema.parse(parsed);
}

function assertFreshClaimIdentity(
	claim: FreshInstallationClaim,
	options: ClaimFreshInstallationOptions,
	intendedResources: string
): void {
	if (
		claim.databaseId !== options.databaseId ||
		claim.accountId !== options.accountId ||
		claim.artifactId !== options.artifactId ||
		canonicalJson(claim.intendedResources) !== intendedResources
	) {
		throw new LegacyDeploymentBootstrapError(
			'The fresh-install claim belongs to another account, artifact or resource plan'
		);
	}
}

/**
 * Claims an empty D1 database before the deploy creates any other Cupboard
 * resource. A later process may take over only after the current claim expires.
 */
export async function claimFreshInstallation(
	options: ClaimFreshInstallationOptions
): Promise<FreshInstallationClaim> {
	const tables = await options.api.d1QueryRows(
		options.databaseId,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
	);
	const hasClaimTable = tables.includes(freshInstallationClaimTable);
	const unexpectedTables = tables.filter(
		(table) => table !== freshInstallationClaimTable
	);

	if (!hasClaimTable && unexpectedTables.length > 0) {
		throw new LegacyDeploymentBootstrapError(
			'The database is not empty and has no fresh-install bootstrap claim'
		);
	}

	if (!hasClaimTable) {
		await options.api.d1QueryBatch(options.databaseId, [
			freshInstallationClaimSql
		]);
	}

	const intendedResources = canonicalJson(options.intendedResources);
	const current = await readFreshInstallationClaim(options);
	const now = options.now ?? new Date();
	const nowIso = now.toISOString();
	const createId = options.createId ?? randomUUID;
	const claimId = createId();
	const claimOwner = createId();
	const claimExpiresAt = claimExpiry(now);

	if (current === undefined) {
		await options.api.d1QueryBatch(options.databaseId, [
			`INSERT INTO ${freshInstallationClaimTable} (database_id, account_id, artifact_id, intended_resources_json, observed_resources_json, instance_id, topology_digest, phase, claim_id, claim_revision, claim_owner, claim_expires_at, updated_at) VALUES (${quoteSql(options.databaseId)}, ${quoteSql(options.accountId)}, ${quoteSql(options.artifactId)}, ${quoteSql(intendedResources)}, '{}', NULL, NULL, 'claimed', ${quoteSql(claimId)}, 0, ${quoteSql(claimOwner)}, ${quoteSql(claimExpiresAt)}, ${quoteSql(nowIso)}) ON CONFLICT (database_id) DO NOTHING;`
		]);
	} else {
		assertFreshClaimIdentity(current, options, intendedResources);

		if (current.phase === 'complete') {
			return current;
		}

		const canResumeOnboarding =
			current.phase === 'runtime-deployed' ||
			current.phase === 'administrator-onboarded';

		if (!canResumeOnboarding && current.claimExpiresAt > nowIso) {
			throw new LegacyDeploymentBootstrapError(
				`Another fresh-install process owns the claim until ${current.claimExpiresAt}`
			);
		}

		const permanentTakeover =
			current.phase === 'claimed' || current.phase === 'resources-created'
				? []
				: [
						`UPDATE fresh_installation_bootstrap SET claim_id = ${quoteSql(claimId)}, claim_owner = ${quoteSql(claimOwner)}, claim_revision = claim_revision + 1, claim_expires_at = ${quoteSql(claimExpiresAt)}, updated_at = ${quoteSql(nowIso)} WHERE database_id = ${quoteSql(options.databaseId)} AND claim_id = ${quoteSql(current.claimId)} AND claim_revision = ${String(current.claimRevision)};`
					];

		await options.api.d1QueryBatch(options.databaseId, [
			`UPDATE ${freshInstallationClaimTable} SET claim_id = ${quoteSql(claimId)}, claim_owner = ${quoteSql(claimOwner)}, claim_revision = claim_revision + 1, claim_expires_at = ${quoteSql(claimExpiresAt)}, updated_at = ${quoteSql(nowIso)} WHERE database_id = ${quoteSql(options.databaseId)} AND claim_id = ${quoteSql(current.claimId)} AND claim_revision = ${String(current.claimRevision)}${canResumeOnboarding ? '' : ` AND claim_expires_at <= ${quoteSql(nowIso)}`};`,
			...permanentTakeover
		]);
	}

	const claimed = await readFreshInstallationClaim(options);

	if (claimed?.claimId !== claimId) {
		throw new LegacyDeploymentBootstrapError(
			'Another process acquired the fresh-install claim'
		);
	}

	return claimed;
}

export async function resumeFreshInstallation(
	options: ClaimFreshInstallationOptions
): Promise<FreshInstallationClaim | undefined> {
	const tables = await options.api.d1QueryRows(
		options.databaseId,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
	);

	if (!tables.includes(freshInstallationClaimTable)) {
		return;
	}

	const current = await readFreshInstallationClaim(options);

	if (current?.phase === 'complete') {
		return;
	}

	return claimFreshInstallation(options);
}

async function advanceFreshInstallation(
	options: AdvanceFreshInstallationOptions
): Promise<FreshInstallationClaim> {
	const now = options.now ?? new Date();
	const nowIso = now.toISOString();
	const observedResources =
		options.observedResources ?? options.claim.observedResources;
	const instanceId = options.deployment?.instanceId ?? options.claim.instanceId;
	const digest =
		options.deployment === undefined
			? options.claim.topologyDigest
			: topologyDigest(observedResources);
	const nextRevision = options.claim.claimRevision + 1;
	const nextExpiry = claimExpiry(now);
	const instanceSql = instanceId === null ? 'NULL' : quoteSql(instanceId);
	const digestSql = digest === null ? 'NULL' : quoteSql(digest);
	const permanentLedgerUpdate =
		options.expectedPhase === 'claimed' ||
		options.expectedPhase === 'resources-created'
			? []
			: [
					`UPDATE fresh_installation_bootstrap SET observed_resources_json = ${quoteSql(canonicalJson(observedResources))}, instance_id = ${instanceSql}, topology_digest = ${digestSql}, phase = ${quoteSql(options.phase)}, claim_id = ${quoteSql(options.claim.claimId)}, claim_revision = ${String(nextRevision)}, claim_owner = ${quoteSql(options.claim.claimOwner)}, claim_expires_at = ${quoteSql(nextExpiry)}, updated_at = ${quoteSql(nowIso)} WHERE database_id = ${quoteSql(options.claim.databaseId)} AND artifact_id = ${quoteSql(options.claim.artifactId)} AND claim_revision = ${String(options.claim.claimRevision)};`
				];

	await options.api.d1QueryBatch(options.claim.databaseId, [
		`UPDATE ${freshInstallationClaimTable} SET observed_resources_json = ${quoteSql(canonicalJson(observedResources))}, instance_id = ${instanceSql}, topology_digest = ${digestSql}, phase = ${quoteSql(options.phase)}, claim_revision = ${String(nextRevision)}, claim_expires_at = ${quoteSql(nextExpiry)}, updated_at = ${quoteSql(nowIso)} WHERE database_id = ${quoteSql(options.claim.databaseId)} AND claim_id = ${quoteSql(options.claim.claimId)} AND claim_revision = ${String(options.claim.claimRevision)} AND phase = ${quoteSql(options.expectedPhase)};`,
		...permanentLedgerUpdate
	]);

	const advanced = await readFreshInstallationClaim({
		api: options.api,
		databaseId: options.claim.databaseId
	});

	if (
		advanced?.claimId !== options.claim.claimId ||
		advanced.claimRevision !== nextRevision ||
		advanced.phase !== options.phase
	) {
		throw new LegacyDeploymentBootstrapError(
			'The fresh-install claim changed while the deployment was advancing'
		);
	}

	return advanced;
}

export async function recordFreshInstallationResources(
	options: Omit<
		AdvanceFreshInstallationOptions,
		'expectedPhase' | 'phase' | 'deployment'
	> & {
		readonly observedResources: Readonly<Record<string, string>>;
	}
): Promise<FreshInstallationClaim> {
	return advanceFreshInstallation({
		...options,
		expectedPhase: 'claimed',
		phase: 'resources-created'
	});
}

export async function sealFreshInstallationTopology(
	options: Omit<AdvanceFreshInstallationOptions, 'expectedPhase' | 'phase'> & {
		readonly deployment: DeploymentIdentity;
	}
): Promise<FreshInstallationClaim> {
	return advanceFreshInstallation({
		...options,
		expectedPhase: 'resources-created',
		phase: 'topology-sealed'
	});
}

const freshInstallationNextPhase: Partial<
	Readonly<Record<FreshInstallationPhase, FreshInstallationPhase>>
> = {
	'schema-applied': 'tenant-uploaded',
	'tenant-uploaded': 'control-uploaded',
	'control-uploaded': 'runtime-deployed',
	'runtime-deployed': 'administrator-onboarded',
	'administrator-onboarded': 'complete'
};

export async function advanceFreshInstallationPhase(
	options: Omit<
		AdvanceFreshInstallationOptions,
		'expectedPhase' | 'phase' | 'observedResources' | 'deployment'
	> & { readonly phase: FreshInstallationPhase }
): Promise<FreshInstallationClaim> {
	const expected = freshInstallationNextPhase[options.claim.phase];

	if (expected !== options.phase) {
		throw new LegacyDeploymentBootstrapError(
			`Fresh installation cannot advance from ${options.claim.phase} to ${options.phase}`
		);
	}

	const input = {
		api: options.api,
		claim: options.claim,
		expectedPhase: options.claim.phase,
		phase: options.phase
	};

	return advanceFreshInstallation({
		...input,
		...(options.now !== undefined && { now: options.now })
	});
}

function soleBootstrapTransition(
	manifest: DeploymentManifestBody
): LegacyBootstrapTransition {
	const [transition, ...extra] = manifest.bootstrapTransitions;

	if (transition === undefined || extra.length > 0) {
		throw new LegacyDeploymentBootstrapError(
			'The artifact must contain one legacy bootstrap transition'
		);
	}

	return transition;
}

async function currentDeploymentHead(
	options: DeploymentLedgerOptions
): Promise<string | undefined> {
	const rows = await options.api.d1QueryRows(
		options.databaseId,
		"SELECT manifest_id || ':' || artifact_id || ':' || instance_id || ':' || state_id AS identity FROM deployment_head WHERE id = 'current';"
	);
	const [head, ...extra] = rows;

	if (extra.length > 0) {
		throw new LegacyDeploymentBootstrapError(
			'The deployment ledger contains more than one current head'
		);
	}

	return head;
}

function identityHead(
	options: FreshDeploymentInitialisationOptions,
	state: string
): string {
	return [
		options.artifact.deploymentManifestId,
		options.deployment.artifactId,
		options.deployment.instanceId,
		state
	].join(':');
}

function expectedHead(
	options: LegacyDeploymentBootstrapOptions,
	transition: LegacyBootstrapTransition
): string {
	return [
		options.artifact.deploymentManifestId,
		options.deployment.artifactId,
		options.deployment.instanceId,
		transition.to
	].join(':');
}

function assertLegacyRuntime(
	fingerprint: LegacyRuntimeFingerprint,
	observation: LegacyRuntimeObservation
): void {
	if (
		observation.tenantVersionTag !== fingerprint.tenantVersionTag ||
		observation.controlVersionTag !== fingerprint.controlVersionTag ||
		observation.tenantTrafficPercent !== 100 ||
		observation.controlTrafficPercent !== 100
	) {
		throw new LegacyDeploymentBootstrapError(
			'The deployed predecessor Workers do not match the manifest legacy fingerprint'
		);
	}
}

async function seedFoundationHead(
	options: LegacyDeploymentBootstrapOptions,
	transition: LegacyBootstrapTransition
): Promise<void> {
	const now = new Date().toISOString();

	await options.api.d1QueryBatch(options.databaseId, [
		`INSERT INTO deployment_head (id, manifest_id, artifact_id, instance_id, state_id, revision, status, updated_at) VALUES ('current', ${quoteSql(options.artifact.deploymentManifestId)}, ${quoteSql(options.deployment.artifactId)}, ${quoteSql(options.deployment.instanceId)}, ${quoteSql(transition.to)}, 0, 'active', ${quoteSql(now)}) ON CONFLICT (id) DO NOTHING;`
	]);

	if (
		(await currentDeploymentHead(options)) !== expectedHead(options, transition)
	) {
		throw new LegacyDeploymentBootstrapError(
			'The deployment ledger belongs to another artifact, topology or state'
		);
	}
}

/**
 * Moves the one supported pre-ledger release into the manifest's foundation
 * state. The manifest fixes the source fingerprint, SQL range and runtime
 * stage; callers cannot provide any of those operations.
 */
export async function bootstrapLegacyDeployment(
	options: LegacyDeploymentBootstrapOptions
): Promise<void> {
	const transition = soleBootstrapTransition(
		options.artifact.deploymentManifest
	);
	const source =
		options.artifact.deploymentManifest.legacyRuntimeFingerprints.find(
			(fingerprint) => fingerprint.id === transition.sourceFingerprint
		);

	if (source === undefined) {
		throw new LegacyDeploymentBootstrapError(
			'The bootstrap transition has no declared legacy source fingerprint'
		);
	}

	const applied = await options.api.d1QueryRows(
		options.databaseId,
		'SELECT name FROM d1_migrations ORDER BY id;'
	);
	const ledgerMigration = transition.migrations[0];

	if (ledgerMigration !== undefined && applied.includes(ledgerMigration)) {
		const head = await currentDeploymentHead(options);

		if (head === expectedHead(options, transition)) {
			return;
		}

		if (head !== undefined) {
			throw new LegacyDeploymentBootstrapError(
				'The deployment ledger belongs to another artifact, topology or state'
			);
		}
	}

	assertLegacyRuntime(source, await options.observeLegacyRuntime());

	await applyLegacyBootstrapD1Migrations(
		{
			queryBatch: (databaseId, statements) =>
				options.api.d1QueryBatch(databaseId, statements),
			queryRows: (databaseId, sql) => options.api.d1QueryRows(databaseId, sql)
		},
		options.databaseId,
		options.artifact.d1Migrations,
		source.d1Migration,
		transition.migrations
	);

	const observation = await options.deployRuntime(transition);

	if (observation.stage !== transition.stage) {
		throw new LegacyDeploymentBootstrapError(
			'The foundation upload did not activate the manifest runtime stage'
		);
	}

	await seedFoundationHead(options, transition);
}

/**
 * Records a fresh database at the terminal state after the CLI has applied the
 * complete schema. Cloudflare authority can resume this operation before the
 * deployment has an administrator, but it cannot attach the database to a
 * different artifact or resolved topology.
 */
export async function initialiseFreshDeployment(
	options: FreshDeploymentInitialisationOptions
): Promise<FreshInstallationClaim> {
	const applied = await options.api.d1QueryRows(
		options.databaseId,
		'SELECT name FROM d1_migrations ORDER BY id;'
	);
	const expected = options.artifact.d1Migrations.map(
		(migration) => migration.name
	);

	if (applied.join('\n') !== expected.join('\n')) {
		throw new LegacyDeploymentBootstrapError(
			'The fresh deployment has not applied the complete declared D1 schema'
		);
	}

	const expectedChecksums = options.artifact.d1Migrations.map(
		(migration) => `${migration.name}:${migration.sha256}`
	);

	const storedChecksums = await options.api.d1QueryRows(
		options.databaseId,
		"SELECT migration_id || ':' || sha256 FROM structural_migration_checksum WHERE kind = 'd1' ORDER BY migration_id;"
	);

	if (
		storedChecksums.length > 0 &&
		storedChecksums.join('\n') !== expectedChecksums.join('\n')
	) {
		throw new LegacyDeploymentBootstrapError(
			'The fresh deployment has conflicting D1 migration checksums'
		);
	}

	if (
		options.claim.phase !== 'topology-sealed' ||
		options.claim.instanceId === null ||
		options.claim.topologyDigest === null ||
		options.claim.instanceId !== options.deployment.instanceId
	) {
		throw new LegacyDeploymentBootstrapError(
			'The fresh deployment topology has not been sealed for this instance'
		);
	}

	const state = options.artifact.deploymentManifest.terminalState;
	const head = identityHead(options, state);
	const now = new Date().toISOString();
	const claimExpiryIso = claimExpiry(new Date(now));
	const claimRevision = options.claim.claimRevision + 1;
	const checksumStatements = options.artifact.d1Migrations.map(
		(migration) =>
			`INSERT INTO structural_migration_checksum (kind, migration_id, sha256, applied_at) VALUES ('d1', ${quoteSql(migration.name)}, ${quoteSql(migration.sha256)}, CURRENT_TIMESTAMP) ON CONFLICT (kind, migration_id) DO NOTHING;`
	);

	await options.api.d1QueryBatch(options.databaseId, [
		...checksumStatements,
		`INSERT INTO fresh_installation_bootstrap (database_id, account_id, artifact_id, intended_resources_json, observed_resources_json, instance_id, topology_digest, phase, claim_id, claim_revision, claim_owner, claim_expires_at, updated_at) VALUES (${quoteSql(options.claim.databaseId)}, ${quoteSql(options.claim.accountId)}, ${quoteSql(options.claim.artifactId)}, ${quoteSql(canonicalJson(options.claim.intendedResources))}, ${quoteSql(canonicalJson(options.claim.observedResources))}, ${quoteSql(options.claim.instanceId)}, ${quoteSql(options.claim.topologyDigest)}, 'schema-applied', ${quoteSql(options.claim.claimId)}, ${String(claimRevision)}, ${quoteSql(options.claim.claimOwner)}, ${quoteSql(claimExpiryIso)}, ${quoteSql(now)}) ON CONFLICT (database_id) DO NOTHING;`,
		`INSERT INTO deployment_head (id, manifest_id, artifact_id, instance_id, state_id, revision, status, updated_at) VALUES ('current', ${quoteSql(options.artifact.deploymentManifestId)}, ${quoteSql(options.deployment.artifactId)}, ${quoteSql(options.deployment.instanceId)}, ${quoteSql(state)}, 0, 'active', ${quoteSql(now)}) ON CONFLICT (id) DO NOTHING;`,
		`UPDATE ${freshInstallationClaimTable} SET phase = 'schema-applied', claim_revision = ${String(claimRevision)}, claim_expires_at = ${quoteSql(claimExpiryIso)}, updated_at = ${quoteSql(now)} WHERE database_id = ${quoteSql(options.claim.databaseId)} AND claim_id = ${quoteSql(options.claim.claimId)} AND claim_revision = ${String(options.claim.claimRevision)} AND phase = 'topology-sealed';`
	]);

	if ((await currentDeploymentHead(options)) !== head) {
		throw new LegacyDeploymentBootstrapError(
			'The fresh deployment ledger belongs to another artifact, topology or state'
		);
	}

	const recordedChecksums = await options.api.d1QueryRows(
		options.databaseId,
		"SELECT migration_id || ':' || sha256 FROM structural_migration_checksum WHERE kind = 'd1' ORDER BY migration_id;"
	);

	if (recordedChecksums.join('\n') !== expectedChecksums.join('\n')) {
		throw new LegacyDeploymentBootstrapError(
			'The fresh deployment did not record the declared D1 migration checksums'
		);
	}

	const claim = await readFreshInstallationClaim(options);

	if (
		claim?.claimId !== options.claim.claimId ||
		claim.claimRevision !== claimRevision ||
		claim.phase !== 'schema-applied'
	) {
		throw new LegacyDeploymentBootstrapError(
			'The fresh-install claim did not record the applied schema'
		);
	}

	return claim;
}
