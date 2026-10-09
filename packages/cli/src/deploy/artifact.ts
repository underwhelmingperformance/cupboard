import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeBuildInfo } from './build-info.ts';
import { resolveBuildVersion } from './build-version.ts';
import type { Bundler, WorkerBundle } from './bundle.ts';
import {
	type DeploymentConfig,
	mergeD1Bindings,
	parseDeploymentConfig,
	readD1Bindings
} from './config.ts';
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
	readonly d1MigrationSets?: Readonly<Record<string, readonly D1Migration[]>>;
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
	readonly d1MigrationSets?: Readonly<Record<string, readonly D1Migration[]>>;
	readonly buildVersion: string;
}

export function payloadToArtifact(
	payload: EmbeddedPayload
): DeploymentArtifact {
	return {
		config: parseDeploymentConfig(payload.controlSource, payload.tenantSource),
		controlBundle: payload.controlBundle,
		tenantBundle: payload.tenantBundle,
		d1Migrations: payload.d1Migrations,
		...(payload.d1MigrationSets !== undefined && {
			d1MigrationSets: payload.d1MigrationSets
		}),
		buildVersion: payload.buildVersion
	};
}

const serverDirectory = 'packages/server';
const buildInfoPath = `${serverDirectory}/src/build-info.generated.ts`;

// The server entrypoints import an uncommitted generated build version.
// Regenerate it before bundling because onboarding waits for `/_version` to
// return this value. A stale value could make the old deployment appear current.
async function ensureBuildInfo(checkoutRoot: string): Promise<string> {
	const outputPath = path.join(checkoutRoot, buildInfoPath);
	const version = await resolveBuildVersion(checkoutRoot);

	await writeBuildInfo(outputPath, version);

	return version;
}

async function readMigrations(
	checkoutRoot: string,
	migrationsDirectory: string
): Promise<D1Migration[]> {
	const directory = path.join(
		checkoutRoot,
		serverDirectory,
		migrationsDirectory
	);
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

	const [controlSource, tenantSource] = await Promise.all([
		readFile(
			path.join(checkoutRoot, serverDirectory, 'wrangler.jsonc'),
			'utf8'
		),
		readFile(
			path.join(checkoutRoot, serverDirectory, 'wrangler.tenant.jsonc'),
			'utf8'
		)
	]);

	const bindings = mergeD1Bindings([
		...readD1Bindings(controlSource),
		...readD1Bindings(tenantSource)
	]);
	const sharedDirectory =
		bindings.find((database) => database.binding === 'CUPBOARD_DB')
			?.migrationsDirectory ?? 'drizzle-d1';
	const additionalSets = await Promise.all(
		bindings
			.filter((database) => database.binding !== 'CUPBOARD_DB')
			.map(
				async (database) =>
					[
						database.binding,
						await readMigrations(
							checkoutRoot,
							database.migrationsDirectory ?? 'migrations'
						)
					] as const
			)
	);

	const [controlBundle, tenantBundle, d1Migrations] = await Promise.all([
		bundler.bundle(
			path.join(checkoutRoot, controlWorker.entryFile),
			controlWorker.mainModule
		),
		bundler.bundle(
			path.join(checkoutRoot, tenantWorker.entryFile),
			tenantWorker.mainModule
		),
		readMigrations(checkoutRoot, sharedDirectory)
	]);

	return {
		controlSource,
		tenantSource,
		controlBundle,
		tenantBundle,
		d1Migrations,
		...(additionalSets.length > 0 && {
			d1MigrationSets: {
				CUPBOARD_DB: d1Migrations,
				...Object.fromEntries(additionalSets)
			}
		}),
		buildVersion
	};
}

export async function buildArtifactFromTree(
	checkoutRoot: string,
	bundler: Bundler
): Promise<DeploymentArtifact> {
	return payloadToArtifact(await buildEmbeddedPayload(checkoutRoot, bundler));
}
