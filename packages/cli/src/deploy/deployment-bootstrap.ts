import type { DeploymentIdentity } from '@cupboard/protocol/deployment';
import type {
	DeploymentManifestBody,
	LegacyBootstrapTransition
} from '@cupboard/protocol/deployment-manifest';

import type { DeploymentArtifact } from './artifact.ts';
import type { CloudflareApi } from './cloudflare-api.ts';
import type { RuntimeStageObservation } from './deployment-runner.ts';
import type { DatabaseId } from './identifiers.ts';
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
	readonly deployRuntime: (
		transition: LegacyBootstrapTransition
	) => Promise<RuntimeStageObservation>;
}

interface FreshDeploymentInitialisationOptions {
	readonly api: Pick<CloudflareApi, 'd1QueryBatch' | 'd1QueryRows'>;
	readonly databaseId: DatabaseId;
	readonly artifact: LegacyBootstrapArtifact;
	readonly deployment: DeploymentIdentity;
}

type DeploymentLedgerOptions = Pick<
	LegacyDeploymentBootstrapOptions,
	'api' | 'databaseId'
>;

function quoteSql(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
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
): Promise<void> {
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

	const state = options.artifact.deploymentManifest.terminalState;
	const head = identityHead(options, state);
	const now = new Date().toISOString();
	const checksumStatements = options.artifact.d1Migrations.map(
		(migration) =>
			`INSERT INTO structural_migration_checksum (kind, migration_id, sha256, applied_at) VALUES ('d1', ${quoteSql(migration.name)}, ${quoteSql(migration.sha256)}, CURRENT_TIMESTAMP) ON CONFLICT (kind, migration_id) DO UPDATE SET sha256 = excluded.sha256;`
	);

	await options.api.d1QueryBatch(options.databaseId, [
		...checksumStatements,
		`INSERT INTO deployment_head (id, manifest_id, artifact_id, instance_id, state_id, revision, status, updated_at) VALUES ('current', ${quoteSql(options.artifact.deploymentManifestId)}, ${quoteSql(options.deployment.artifactId)}, ${quoteSql(options.deployment.instanceId)}, ${quoteSql(state)}, 0, 'active', ${quoteSql(now)}) ON CONFLICT (id) DO NOTHING;`
	]);

	if ((await currentDeploymentHead(options)) !== head) {
		throw new LegacyDeploymentBootstrapError(
			'The fresh deployment ledger belongs to another artifact, topology or state'
		);
	}
}
