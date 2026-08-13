import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { arch, env, platform } from 'node:process';
import { pathToFileURL } from 'node:url';

import {
	CodedError,
	genericExitCode,
	UsageError
} from '@cupboard/shared/errors';
import { build } from 'esbuild';

import { buildEmbeddedPayload } from '../packages/cli/src/deploy/artifact.ts';
import { createEsbuildBundler } from '../packages/cli/src/deploy/bundle.ts';
import { embeddedAssetKey } from '../packages/cli/src/deploy/embedded.ts';

interface Options {
	readonly outputDirectory: string;
	readonly version: string;
}

type SeaFormat = 'esm' | 'cjs';

interface RunOptions {
	readonly optional?: boolean;
}

const supportedPlatforms = new Map([
	['darwin', 'macos'],
	['linux', 'linux']
]);

const supportedArchitectures = new Map([
	['arm64', 'arm64'],
	['x64', 'x64']
]);

const sentinelFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

export const hookHelperSourcePath =
	'packages/cli/hook-helper/cupboard-hook-relay.c';
export const hookHelperBinaryName = 'cupboard-hook-relay';

export type CommandRunner = (
	command: string,
	arguments_: readonly string[]
) => void;

/**
 * Compiles the post-build hook helper beside the CLI binary, so the tarball
 * unpacks it exactly where the CLI's helper resolution looks. The four
 * release platforms each compile natively; the Nix sandbox sets `CC` to the
 * stdenv compiler, and the release runners fall back to the system `cc`.
 */
export function compileHookHelper(options: {
	readonly binaryDirectory: string;
	readonly runCommand: CommandRunner;
	readonly compiler?: string;
}): string {
	const compiler = options.compiler ?? env.CC ?? 'cc';
	const outputPath = path.join(options.binaryDirectory, hookHelperBinaryName);

	options.runCommand(compiler, ['-O2', '-o', outputPath, hookHelperSourcePath]);

	return outputPath;
}

/**
 * The `tar` arguments for the release asset: the CLI binary and its hook
 * helper side by side at the archive root.
 */
export function releaseArchiveArguments(
	assetPath: string,
	binaryDirectory: string
): string[] {
	return [
		'-czf',
		assetPath,
		'-C',
		binaryDirectory,
		'cupboard',
		hookHelperBinaryName
	];
}

class UnsupportedPlatformError extends CodedError {
	constructor(
		public readonly runtimePlatform: string,
		public readonly runtimeArch: string
	) {
		super(`unsupported release platform: ${runtimePlatform}-${runtimeArch}`);
		this.name = 'UnsupportedPlatformError';
	}
}

class CommandFailedError extends CodedError {
	constructor(
		public readonly command: string,
		public readonly status: number | null
	) {
		super(`${command} failed with status ${String(status)}`);
		this.name = 'CommandFailedError';
	}
}

class UnknownArgumentError extends UsageError {
	constructor(public readonly argument: string) {
		super(`unknown or incomplete argument: ${argument}`);
		this.name = 'UnknownArgumentError';
	}
}

class MissingOptionError extends UsageError {
	constructor(public readonly option: string) {
		super(`${option} is required`);
		this.name = 'MissingOptionError';
	}
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const assetName = releaseAssetNameFor(platform, arch);

	const require = createRequire(import.meta.url);
	const postjectCliPath = require.resolve('postject/dist/cli.js');

	const outputDirectory = path.resolve(options.outputDirectory);
	const workDirectory = path.join(outputDirectory, 'work');
	const blobPath = path.join(workDirectory, 'cupboard.blob');
	const seaConfigPath = path.join(workDirectory, 'sea-config.json');
	const embeddedPayloadPath = path.join(workDirectory, embeddedAssetKey);
	const binaryDirectory = path.join(outputDirectory, 'package');
	const binaryPath = path.join(binaryDirectory, 'cupboard');
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
	compileHookHelper({ binaryDirectory, runCommand: run });
	run('tar', releaseArchiveArguments(assetPath, binaryDirectory));

	if (process.env.GITHUB_OUTPUT !== undefined) {
		await writeFile(
			process.env.GITHUB_OUTPUT,
			[
				`asset-name=${assetName}`,
				`asset-path=${assetPath}`,
				`version=${options.version}`,
				''
			].join('\n'),
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
			// The single-executable runs the bundle through the bare `node` binary, so
			// the `--disable-warning` shebang in `main.ts` never applies and SEA takes no
			// node CLI flags. Silence deprecation warnings here, as `--no-deprecation`
			// would, to keep transitive dependencies' noise (such as the `punycode`
			// DEP0040 warning) out of the released binary's output, and drop the
			// `node:sqlite` experimental-feature warning the local store loads.
			banner: {
				js: [
					'process.noDeprecation = true;',
					'{',
					'  const emitWarning = process.emitWarning.bind(process);',
					'  process.emitWarning = (warning, ...rest) => {',
					'    const options = rest[0];',
					"    const type = typeof options === 'object' && options !== null ? options.type : options;",
					"    if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;",
					'    return emitWarning(warning, ...rest);',
					'  };',
					'}'
				].join('\n')
			},
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
								'void (async () => {',
								'\tprocess.exitCode = await runCli();',
								'})();'
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
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

	throw new CommandFailedError(command, result.status);
}

function parseOptions(arguments_: readonly string[]): Options {
	const parsed: { version?: string; outputDirectory?: string } = {};

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

		throw new UnknownArgumentError(argument ?? '');
	}

	if (parsed.version === undefined || parsed.version.trim() === '') {
		throw new MissingOptionError('--version');
	}

	if (parsed.outputDirectory === undefined || parsed.outputDirectory === '') {
		throw new MissingOptionError('--out-dir');
	}

	return {
		version: normaliseBuildVersion(parsed.version),
		outputDirectory: parsed.outputDirectory
	};
}

/** Preserve the caller's build identity after rejecting surrounding whitespace. */
export function normaliseBuildVersion(version: string): string {
	return version.trim();
}

/** Name a binary by platform within the release that scopes it to one version. */
export function releaseAssetNameFor(
	runtimePlatform: string,
	runtimeArchitecture: string
): string {
	const releasePlatform = supportedPlatforms.get(runtimePlatform);
	const releaseArchitecture = supportedArchitectures.get(runtimeArchitecture);

	if (releasePlatform === undefined || releaseArchitecture === undefined) {
		throw new UnsupportedPlatformError(runtimePlatform, runtimeArchitecture);
	}

	return `cupboard-${releasePlatform}-${releaseArchitecture}.tar.gz`;
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		await main();
	} catch (error: unknown) {
		if (error instanceof CodedError) {
			console.error(error.message);
			process.exitCode = error.exitCode;
		} else {
			console.error(error);
			process.exitCode = genericExitCode;
		}
	}
}
