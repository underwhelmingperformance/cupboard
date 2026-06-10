import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Bundler, WorkerBundle } from './bundle.ts';
import { type DeploymentConfig, parseDeploymentConfig } from './config.ts';
import { type D1Migration, parseD1Migrations } from './migrations.ts';
import { controlWorker, tenantWorker } from './source.ts';

const execFileAsync = promisify(execFile);

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
}

export function payloadToArtifact(
	payload: EmbeddedPayload
): DeploymentArtifact {
	return {
		config: parseDeploymentConfig(payload.controlSource, payload.tenantSource),
		controlBundle: payload.controlBundle,
		tenantBundle: payload.tenantBundle,
		d1Migrations: payload.d1Migrations
	};
}

const serverDirectory = 'packages/server';
const buildInfoPath = `${serverDirectory}/src/build-info.generated.ts`;
const migrationsDirectory = `${serverDirectory}/drizzle-d1`;

// The server entrypoints import `build-info.generated.ts`, which is produced by
// `scripts/build-info.ts` and not committed. Generate it if missing so a tree
// build does not depend on a prior `pnpm` step.
async function ensureBuildInfo(checkoutRoot: string): Promise<void> {
	const outputPath = path.join(checkoutRoot, buildInfoPath);

	if (existsSync(outputPath)) {
		return;
	}

	const revision = await gitOutput(checkoutRoot, [
		'rev-parse',
		'--short=12',
		'HEAD'
	]);
	const status = await gitOutput(checkoutRoot, ['status', '--porcelain']);
	const version = status === '' ? revision : `${revision}+dirty`;

	await writeFile(
		outputPath,
		`export const buildVersion = ${JSON.stringify(version)};\n`
	);
}

async function gitOutput(
	cwd: string,
	arguments_: readonly string[]
): Promise<string> {
	const { stdout } = await execFileAsync('git', [...arguments_], { cwd });

	return stdout.trim();
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

/**
 * Read both wrangler sources, bundle each Worker from live source, and read the
 * D1 migrations from a checkout. This is the serializable payload the release
 * build embeds; a tree deploy turns it straight into an artifact.
 */
export async function buildEmbeddedPayload(
	checkoutRoot: string,
	bundler: Bundler
): Promise<EmbeddedPayload> {
	await ensureBuildInfo(checkoutRoot);

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

	const [controlBundle, tenantBundle, d1Migrations] = await Promise.all([
		bundler.bundle(
			path.join(checkoutRoot, controlWorker.entryFile),
			controlWorker.mainModule
		),
		bundler.bundle(
			path.join(checkoutRoot, tenantWorker.entryFile),
			tenantWorker.mainModule
		),
		readMigrations(checkoutRoot)
	]);

	return {
		controlSource,
		tenantSource,
		controlBundle,
		tenantBundle,
		d1Migrations
	};
}

/**
 * Assemble the deployment artifact from a checkout: bundle from live source and
 * parse both wrangler configs.
 */
export async function buildArtifactFromTree(
	checkoutRoot: string,
	bundler: Bundler
): Promise<DeploymentArtifact> {
	return payloadToArtifact(await buildEmbeddedPayload(checkoutRoot, bundler));
}
