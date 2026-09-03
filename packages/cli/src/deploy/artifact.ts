import { createHash } from 'node:crypto';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
	cacheDeploymentManifest,
	d1MigrationId,
	durableObjectMigrationId
} from '@cupboard/protocol/cache-deployment-manifest';
import type {
	DeploymentArtifactId,
	DeploymentExecutorSha256,
	DeploymentManifestBody,
	DeploymentManifestId,
	StaticDeploymentArtifacts,
	WorkerUploadTemplate
} from '@cupboard/protocol/deployment-manifest';
import {
	bundleSha256Schema,
	cloudflareWorkerVersionTagSchema,
	deploymentExecutorSha256Schema,
	isoDateSchema,
	validateDeploymentManifest
} from '@cupboard/protocol/deployment-manifest';
import { format, resolveConfig } from 'prettier';
import { z } from 'zod';

import { resolveBuildVersion } from './build-version.ts';
import type { Bundler, WorkerBundle } from './bundle.ts';
import { type DeploymentConfig, parseDeploymentConfig } from './config.ts';
import {
	deploymentArtifactId,
	deploymentManifestId
} from './deployment-identity.ts';
import { type D1Migration, parseD1Migrations } from './migrations.ts';
import { controlWorker, tenantWorker } from './source.ts';

/**
 * Everything needed to deploy, independent of where it came from. Tree mode
 * assembles it from a checkout; embedded mode imports it from the bundle baked
 * into the binary at release time.
 */
export interface DeploymentArtifact {
	readonly config: DeploymentConfig;
	readonly controlBundle: WorkerBundle;
	readonly tenantBundle: WorkerBundle;
	readonly d1Migrations: readonly D1Migration[];
	readonly deploymentManifest: DeploymentManifestBody;
	readonly deploymentManifestId: DeploymentManifestId;
	readonly deploymentArtifactId: DeploymentArtifactId;
	readonly deploymentExecutorHash: DeploymentExecutorSha256;
	/**
	The version the bundled Workers return from `/_version`.
	*/
	readonly buildVersion: string;
}

/**
 * The serializable form embedded in the released binary: the raw wrangler
 * sources (re-parsed on load, reusing the same validation as a tree build)
 * alongside the bundles and migrations. {@link payloadToArtifact} turns it back
 * into a {@link DeploymentArtifact}.
 */
export interface EmbeddedPayload {
	readonly controlSource: string;
	readonly tenantSource: string;
	readonly controlBundle: WorkerBundle;
	readonly tenantBundle: WorkerBundle;
	readonly d1Migrations: readonly D1Migration[];
	readonly deploymentManifest: DeploymentManifestBody;
	readonly deploymentExecutorHash: DeploymentExecutorSha256;
	readonly buildVersion: string;
}

function bindingTemplates(
	worker: DeploymentConfig['tenant']
): WorkerUploadTemplate['bindings'] {
	return [
		...(worker.versionMetadataBinding === undefined
			? []
			: [{ name: worker.versionMetadataBinding, type: 'version_metadata' }]),
		...worker.durableObjects.map(({ binding, className, scriptName }) => ({
			name: binding,
			type: 'durable_object_namespace',
			target: `${scriptName ?? 'self'}:${className}`
		})),
		...worker.r2Buckets.map(({ binding, bucketName }) => ({
			name: binding,
			type: 'r2_bucket',
			target: bucketName
		})),
		...worker.kvNamespaces.map(({ binding, title }) => ({
			name: binding,
			type: 'kv_namespace',
			target: title
		})),
		...worker.d1Databases.map(({ binding, databaseName }) => ({
			name: binding,
			type: 'd1',
			target: databaseName
		})),
		...worker.queueProducers.map(({ binding, queue }) => ({
			name: binding,
			type: 'queue',
			target: queue
		})),
		...worker.services.map(({ binding, service, entrypoint }) => ({
			name: binding,
			type: 'service',
			target: `${service}:${entrypoint ?? ''}`
		})),
		...Object.entries(worker.vars).map(([name, value]) => ({
			name,
			type: 'plain_text',
			...(name !== 'CUPBOARD_DEPLOYMENT_ARTIFACT_ID' && { target: value })
		}))
	].toSorted((left, right) =>
		`${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`)
	);
}

function workerUploadTemplate(
	worker: DeploymentConfig['tenant'],
	bundle: WorkerBundle,
	buildVersion: string
): WorkerUploadTemplate {
	return {
		bundleHash: bundleSha256Schema.parse(
			createHash('sha256').update(bundle.code).digest('hex')
		),
		versionTag: cloudflareWorkerVersionTagSchema.parse(buildVersion),
		mainModule: bundle.mainModule,
		compatibilityDate: isoDateSchema.parse(worker.compatibilityDate),
		compatibilityFlags: [...worker.compatibilityFlags],
		observability: {
			enabled: worker.observability,
			tracing: worker.tracing
		},
		keepBindings: ['secret_text', 'plain_text'],
		cache: {
			enabled: worker.cacheEnabled,
			crossVersion: worker.cacheEnabled
		},
		exports: worker.exports,
		...(worker.cpuMs !== undefined && { cpuMilliseconds: worker.cpuMs }),
		bindings: bindingTemplates(worker)
	};
}

function deploymentArtifacts(
	payload: Pick<
		EmbeddedPayload,
		| 'controlSource'
		| 'tenantSource'
		| 'controlBundle'
		| 'tenantBundle'
		| 'deploymentManifest'
		| 'deploymentExecutorHash'
		| 'buildVersion'
	>
): {
	readonly config: DeploymentConfig;
	readonly manifestId: DeploymentManifestId;
	readonly artifactId: DeploymentArtifactId;
} {
	const config = parseDeploymentConfig(
		payload.controlSource,
		payload.tenantSource
	);
	const manifestId = deploymentManifestId(payload.deploymentManifest);
	const artifacts: StaticDeploymentArtifacts = {
		manifestId,
		deploymentExecutorHash: payload.deploymentExecutorHash,
		tenant: workerUploadTemplate(
			config.tenant,
			payload.tenantBundle,
			payload.buildVersion
		),
		control: workerUploadTemplate(
			config.control,
			payload.controlBundle,
			payload.buildVersion
		)
	};

	return {
		config,
		manifestId,
		artifactId: deploymentArtifactId(artifacts)
	};
}

export function payloadToArtifact(
	payload: EmbeddedPayload
): DeploymentArtifact {
	const identity = deploymentArtifacts(payload);

	return {
		config: identity.config,
		controlBundle: payload.controlBundle,
		tenantBundle: payload.tenantBundle,
		d1Migrations: payload.d1Migrations,
		deploymentManifest: payload.deploymentManifest,
		deploymentManifestId: identity.manifestId,
		deploymentArtifactId: identity.artifactId,
		deploymentExecutorHash: payload.deploymentExecutorHash,
		buildVersion: payload.buildVersion
	};
}

const serverDirectory = 'packages/server';
const buildInfoPath = `${serverDirectory}/src/build-info.generated.ts`;
const migrationsDirectory = `${serverDirectory}/drizzle-d1`;
const durableObjectMigrationsDirectory = `${serverDirectory}/drizzle`;
const deploymentManifestOutputPath = `${serverDirectory}/src/deployment-manifest.generated.ts`;
const executorSourceRoots = [
	'packages/cli/src',
	'packages/protocol/src',
	'packages/shared/src',
	'packages/reporter/src',
	'packages/cli-ui/src'
];

async function sourceFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const entryPath = path.join(directory, entry.name);

			if (entry.isDirectory()) {
				return sourceFiles(entryPath);
			}

			return entry.isFile() && !entry.name.endsWith('.test.ts')
				? [entryPath]
				: [];
		})
	);

	return nested.flat();
}

async function deploymentExecutorHash(
	checkoutRoot: string
): Promise<DeploymentExecutorSha256> {
	const roots = executorSourceRoots.map((root) =>
		path.join(checkoutRoot, root)
	);
	const filesByRoot = await Promise.all(
		roots.map(async (root) => sourceFiles(root))
	);
	const files = filesByRoot
		.flat()
		.toSorted((left, right) => left.localeCompare(right));
	const hash = createHash('sha256');

	for (const file of files) {
		hash.update(path.relative(checkoutRoot, file));
		hash.update('\0');
		hash.update(await readFile(file));
		hash.update('\0');
	}

	for (const file of ['package.json', 'pnpm-lock.yaml']) {
		hash.update(file);
		hash.update('\0');
		hash.update(await readFile(path.join(checkoutRoot, file)));
		hash.update('\0');
	}

	return deploymentExecutorSha256Schema.parse(hash.digest('hex'));
}

// The server entrypoints import an uncommitted generated build version.
// Regenerate it before bundling because onboarding waits for `/_version` to
// return this value. A stale value could make the old deployment appear current.
async function ensureBuildInfo(checkoutRoot: string): Promise<string> {
	const outputPath = path.join(checkoutRoot, buildInfoPath);
	const version = await resolveBuildVersion(checkoutRoot);

	await writeFile(
		outputPath,
		`export const buildVersion = ${JSON.stringify(version)};\n`
	);

	return version;
}

async function readMigrations(checkoutRoot: string): Promise<D1Migration[]> {
	const directory = path.join(checkoutRoot, migrationsDirectory);
	const entries = await readdir(directory);
	const sqlFiles = entries.filter((entry) => entry.endsWith('.sql'));

	const files = await Promise.all(
		sqlFiles.map(async (name) => ({
			name,
			sql: await readFile(path.join(directory, name), 'utf8')
		}))
	);

	return parseD1Migrations(files);
}

const durableObjectJournalEntrySchema = z.object({ tag: z.string() });
const durableObjectJournalSchema = z.object({
	entries: z.array(durableObjectJournalEntrySchema)
});

async function readDurableObjectMigrations(checkoutRoot: string) {
	const directory = path.join(checkoutRoot, durableObjectMigrationsDirectory);
	const journalPath = path.join(directory, 'meta/_journal.json');
	const journalSource = await readFile(journalPath, 'utf8');
	const journal = durableObjectJournalSchema.parse(JSON.parse(journalSource));

	return Promise.all(
		journal.entries.map(async ({ tag }) => {
			const source = await readFile(path.join(directory, `${tag}.sql`), 'utf8');

			return {
				id: durableObjectMigrationId(tag),
				sha256: createHash('sha256').update(source).digest('hex')
			};
		})
	);
}

function deploymentManifestSource(manifest: DeploymentManifestBody): string {
	const migrationSource = (
		migrations: DeploymentManifestBody['d1Migrations'],
		factory: 'd1MigrationId' | 'durableObjectMigrationId'
	) =>
		migrations
			.map(
				(migration) =>
					`\t\t{ id: ${factory}(${JSON.stringify(migration.id)}), sha256: ${JSON.stringify(migration.sha256)} }`
			)
			.join(',\n');

	return [
		"import { cacheDeploymentManifest, d1MigrationId, durableObjectMigrationId } from '@cupboard/protocol/cache-deployment-manifest';",
		"import type { ForwardDeploymentTransition } from '@cupboard/protocol/deployment-manifest';",
		'',
		'export const deploymentManifest = cacheDeploymentManifest({',
		'\td1: [',
		migrationSource(manifest.d1Migrations, 'd1MigrationId'),
		'\t],',
		'\tdurableObject: [',
		migrationSource(
			manifest.durableObjectMigrations,
			'durableObjectMigrationId'
		),
		'\t]',
		'});',
		'',
		'export const deploymentForwardTransitions: readonly ForwardDeploymentTransition[] =',
		'\tdeploymentManifest.forwardTransitions;',
		''
	].join('\n');
}

async function writeDeploymentManifest(
	checkoutRoot: string,
	manifest: DeploymentManifestBody
): Promise<void> {
	const outputPath = path.join(checkoutRoot, deploymentManifestOutputPath);
	const temporaryPath = `${outputPath}.${String(process.pid)}.tmp`;
	const formatting = await resolveConfig(outputPath);
	const source = await format(deploymentManifestSource(manifest), {
		...formatting,
		parser: 'typescript'
	});

	await writeFile(temporaryPath, source);
	await rename(temporaryPath, outputPath);
}

export async function generateDeploymentManifest(
	checkoutRoot: string
): Promise<DeploymentManifestBody> {
	const [d1Migrations, durableObjectMigrations] = await Promise.all([
		readMigrations(checkoutRoot),
		readDurableObjectMigrations(checkoutRoot)
	]);
	const manifest = cacheDeploymentManifest({
		d1: d1Migrations.map((migration) => ({
			id: d1MigrationId(migration.name),
			sha256: migration.sha256
		})),
		durableObject: durableObjectMigrations
	});

	validateDeploymentManifest(manifest);
	await writeDeploymentManifest(checkoutRoot, manifest);

	return manifest;
}

/**
 * Read both wrangler sources, bundle each Worker from live source, and read the
 * D1 migrations from a checkout. This is the serializable payload the release
 * build embeds; a tree deploy turns it straight into an artifact.
 */
export async function buildEmbeddedPayload(
	checkoutRoot: string,
	bundler: Bundler
): Promise<EmbeddedPayload> {
	const buildVersion = await ensureBuildInfo(checkoutRoot);

	const [
		controlSource,
		tenantSource,
		d1Migrations,
		deploymentManifest,
		executorHash
	] = await Promise.all([
		readFile(
			path.join(checkoutRoot, serverDirectory, 'wrangler.jsonc'),
			'utf8'
		),
		readFile(
			path.join(checkoutRoot, serverDirectory, 'wrangler.tenant.jsonc'),
			'utf8'
		),
		readMigrations(checkoutRoot),
		generateDeploymentManifest(checkoutRoot),
		deploymentExecutorHash(checkoutRoot)
	]);

	const [controlBundle, tenantBundle] = await Promise.all([
		bundler.bundle(
			path.join(checkoutRoot, controlWorker.entryFile),
			controlWorker.mainModule
		),
		bundler.bundle(
			path.join(checkoutRoot, tenantWorker.entryFile),
			tenantWorker.mainModule
		)
	]);

	return {
		controlSource,
		tenantSource,
		controlBundle,
		tenantBundle,
		d1Migrations,
		deploymentManifest,
		deploymentExecutorHash: executorHash,
		buildVersion
	};
}

export async function buildArtifactFromTree(
	checkoutRoot: string,
	bundler: Bundler
): Promise<DeploymentArtifact> {
	return payloadToArtifact(await buildEmbeddedPayload(checkoutRoot, bundler));
}
