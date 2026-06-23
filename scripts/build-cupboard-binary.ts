import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { arch, platform } from 'node:process';

import { build } from 'esbuild';

import { buildEmbeddedPayload } from '../packages/cli/src/deploy/artifact.ts';
import { createEsbuildBundler } from '../packages/cli/src/deploy/bundle.ts';
import { embeddedAssetKey } from '../packages/cli/src/deploy/embedded.ts';

interface Options {
	readonly outputDirectory: string;
	readonly version: string;
}

type SeaFormat = 'esm' | 'cjs';

const supportedPlatforms = new Map([
	['darwin', 'macos'],
	['linux', 'linux']
]);

const supportedArchitectures = new Map([
	['arm64', 'arm64'],
	['x64', 'x64']
]);

const options = parseOptions(process.argv.slice(2));
const releasePlatform = supportedPlatforms.get(platform);
const releaseArchitecture = supportedArchitectures.get(arch);

if (releasePlatform === undefined || releaseArchitecture === undefined) {
	throw new Error(`unsupported release platform: ${platform}-${arch}`);
}

const sentinelFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const require = createRequire(import.meta.url);
const postjectCliPath = require.resolve('postject/dist/cli.js');

const outputDirectory = path.resolve(options.outputDirectory);
const workDirectory = path.join(outputDirectory, 'work');
const blobPath = path.join(workDirectory, 'cupboard.blob');
const seaConfigPath = path.join(workDirectory, 'sea-config.json');
const embeddedPayloadPath = path.join(workDirectory, embeddedAssetKey);
const binaryDirectory = path.join(outputDirectory, 'package');
const binaryPath = path.join(binaryDirectory, 'cupboard');
const assetName = `cupboard-${options.version}-${releasePlatform}-${releaseArchitecture}.tar.gz`;
const assetPath = path.join(outputDirectory, assetName);

await mkdir(workDirectory, { recursive: true });
await mkdir(binaryDirectory, { recursive: true });

// Bundle both Workers and write the payload the deployed binary serves from
// embedded mode. Generated once and referenced as a SEA asset by both formats.
const payload = await buildEmbeddedPayload(
	process.cwd(),
	createEsbuildBundler()
);
await writeFile(embeddedPayloadPath, JSON.stringify(payload));

await buildAndSmokeSea();
run('tar', ['-czf', assetPath, '-C', binaryDirectory, 'cupboard']);

if (process.env.GITHUB_OUTPUT !== undefined) {
	await writeFile(
		process.env.GITHUB_OUTPUT,
		[`asset-name=${assetName}`, `asset-path=${assetPath}`, ''].join('\n'),
		{
			flag: 'a'
		}
	);
}

async function buildAndSmokeSea(): Promise<void> {
	try {
		await buildSea('esm');
		return;
	} catch (error) {
		console.warn(
			`ESM SEA smoke failed; rebuilding as CommonJS: ${errorMessage(error)}`
		);
	}

	await buildSea('cjs');
}

async function buildSea(seaFormat: SeaFormat): Promise<void> {
	const bundlePath = path.join(
		workDirectory,
		seaFormat === 'esm' ? 'cupboard.mjs' : 'cupboard.cjs'
	);

	await build({
		bundle: true,
		define: {
			CUPBOARD_VERSION: JSON.stringify(options.version)
		},
		...(seaFormat === 'esm'
			? { entryPoints: ['packages/cli/src/main.ts'] }
			: {
					stdin: {
						contents: [
							"import { runCli } from './packages/cli/src/run.ts';",
							'runCli().then((exitCode: number) => {',
							'\tprocess.exitCode = exitCode;',
							'});'
						].join('\n'),
						loader: 'ts',
						resolveDir: process.cwd(),
						sourcefile: 'cupboard-cjs-entry.ts'
					}
				}),
		format: seaFormat,
		outfile: bundlePath,
		platform: 'node',
		sourcemap: true,
		target: 'node24'
	});

	await writeFile(
		seaConfigPath,
		JSON.stringify(seaConfig(bundlePath, seaFormat), undefined, 2)
	);

	run(process.execPath, ['--experimental-sea-config', seaConfigPath]);
	await copyFile(process.execPath, binaryPath);
	await chmod(binaryPath, 0o755);

	if (platform === 'darwin') {
		run('codesign', ['--remove-signature', binaryPath], { optional: true });
	}

	run(process.execPath, [
		postjectCliPath,
		binaryPath,
		'NODE_SEA_BLOB',
		blobPath,
		'--sentinel-fuse',
		sentinelFuse,
		'--overwrite',
		...(platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])
	]);

	if (platform === 'darwin') {
		run('codesign', ['--sign', '-', binaryPath]);
	}

	run(binaryPath, ['--version']);
	run(binaryPath, ['push', '--help']);
	run(binaryPath, [
		'--no-colour',
		'config',
		'https://cache.example.invalid',
		'cupboard-1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa='
	]);
}

function seaConfig(bundlePath: string, seaFormat: SeaFormat): object {
	return {
		main: bundlePath,
		...(seaFormat === 'esm' && { mainFormat: 'module' }),
		output: blobPath,
		assets: { [embeddedAssetKey]: embeddedPayloadPath },
		disableExperimentalSEAWarning: true,
		useCodeCache: false,
		useSnapshot: false
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface RunOptions {
	readonly optional?: boolean;
}

function run(
	command: string,
	arguments_: readonly string[],
	options: RunOptions = {}
): void {
	const result = spawnSync(command, [...arguments_], { stdio: 'inherit' });

	if (result.status === 0) {
		return;
	}

	if (options.optional === true) {
		return;
	}

	throw new Error(`${command} failed with status ${String(result.status)}`);
}

function parseOptions(arguments_: readonly string[]): Options {
	const parsed: Partial<Options> = {};

	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];

		if (argument === '--') {
			continue;
		}

		const value = arguments_[index + 1];

		if (argument === '--version' && value !== undefined) {
			parsed.version = value;
			index += 1;
			continue;
		}

		if (argument === '--out-dir' && value !== undefined) {
			parsed.outputDirectory = value;
			index += 1;
			continue;
		}

		throw new Error(`unknown or incomplete argument: ${argument ?? ''}`);
	}

	if (parsed.version === undefined || parsed.version === '') {
		throw new Error('--version is required');
	}

	if (parsed.outputDirectory === undefined || parsed.outputDirectory === '') {
		throw new Error('--out-dir is required');
	}

	return {
		version: normaliseReleaseVersion(parsed.version),
		outputDirectory: parsed.outputDirectory
	};
}

function normaliseReleaseVersion(version: string): string {
	return version.startsWith('v') ? version : `v${version}`;
}
