import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import {
	binaryCliEntrySource,
	compileHookHelper,
	generateSeaPreparationBlob,
	hookHelperBinaryName,
	hookHelperSourcePath,
	normaliseBuildVersion,
	releaseArchiveArguments,
	releaseAssetNameFor
} from './build-cupboard-binary.ts';

describe('binaryCliEntrySource', () => {
	it('initialises a real trace context before the packaged CLI runs', async () => {
		const bundled = await build({
			stdin: {
				contents: binaryCliEntrySource,
				loader: 'ts',
				resolveDir: path.resolve(import.meta.dirname, '..')
			},
			bundle: true,
			format: 'cjs',
			platform: 'node',
			write: false,
			plugins: [
				{
					name: 'cli-trace-probe',
					setup(bundler) {
						bundler.onLoad(
							{ filter: new RegExp(/packages\/cli\/src\/run\.ts$/u.source) },
							() => ({
								contents: [
									"import { trace } from '@opentelemetry/api';",
									'export async function runCli() {',
									"const span = trace.getTracer('binary-test').startSpan('command');",
									'console.log(JSON.stringify(span.spanContext()));',
									'span.end();',
									'return 0;',
									'}'
								].join('\n'),
								loader: 'ts',
								resolveDir: path.resolve(
									import.meta.dirname,
									'../packages/shared'
								)
							})
						);
					}
				}
			]
		});
		const output = bundled.outputFiles[0];
		if (output === undefined) {
			throw new TypeError('The binary entry bundle was not generated');
		}
		const context: unknown = JSON.parse(
			execFileSync(process.execPath, ['-e', output.text], {
				encoding: 'utf8'
			})
		);
		const traceId: unknown = expect.stringMatching(/^(?!0{32}$)[0-9a-f]{32}$/u);
		const spanId: unknown = expect.stringMatching(/^(?!0{16}$)[0-9a-f]{16}$/u);
		expect(context).toStrictEqual({
			traceId,
			spanId,
			traceFlags: 1
		});
	});
});

interface Invocation {
	readonly command: string;
	readonly arguments: readonly string[];
}

describe('compileHookHelper', () => {
	it.each([
		{
			name: 'the configured compiler',
			compiler: 'gcc',
			expectedCompiler: 'gcc'
		},
		{
			name: 'an explicit cc',
			compiler: 'cc',
			expectedCompiler: 'cc'
		}
	])('compiles the helper with $name', ({ compiler, expectedCompiler }) => {
		const invocations: Invocation[] = [];

		const outputPath = compileHookHelper({
			binaryDirectory: '/release/package',
			compiler,
			runCommand: (command, arguments_) => {
				invocations.push({ command, arguments: arguments_ });
			}
		});

		expect({ outputPath, invocations }).toStrictEqual({
			outputPath: `/release/package/${hookHelperBinaryName}`,
			invocations: [
				{
					command: expectedCompiler,
					arguments: [
						'-O2',
						'-o',
						`/release/package/${hookHelperBinaryName}`,
						hookHelperSourcePath
					]
				}
			]
		});
	});
});

describe('normaliseBuildVersion', () => {
	it.each([
		[' v1.2.3 ', 'v1.2.3'],
		['03ab395', '03ab395']
	])('preserves the build identity in %s', (version, expected) => {
		expect(normaliseBuildVersion(version)).toBe(expected);
	});
});

describe('releaseAssetNameFor', () => {
	it.each([
		['linux', 'x64', 'cupboard-linux-x64.tar.gz'],
		['linux', 'arm64', 'cupboard-linux-arm64.tar.gz'],
		['darwin', 'x64', 'cupboard-macos-x64.tar.gz'],
		['darwin', 'arm64', 'cupboard-macos-arm64.tar.gz']
	])(
		'names the %s %s release asset independently of its tag',
		(runtimePlatform, runtimeArchitecture, expected) => {
			expect(releaseAssetNameFor(runtimePlatform, runtimeArchitecture)).toBe(
				expected
			);
		}
	);
});

describe('generateSeaPreparationBlob', () => {
	it('produces identical blobs in different work directories', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'cupboard-sea-'));
		const workDirectories = ['first', 'second'].map((name) =>
			path.join(root, name)
		);

		try {
			const blobs = await Promise.all(
				workDirectories.map(async (workDirectory) => {
					await mkdir(workDirectory);
					await Promise.all([
						writeFile(
							path.join(workDirectory, 'cupboard.cjs'),
							"console.log('cupboard');\n"
						),
						writeFile(
							path.join(workDirectory, 'embedded-workers.json'),
							'{"worker":"same"}\n'
						)
					]);

					const blobPath = await generateSeaPreparationBlob(workDirectory);

					return readFile(blobPath);
				})
			);

			expect(blobs[1]).toStrictEqual(blobs[0]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});

describe('releaseArchiveArguments', () => {
	it('packs the helper beside the binary at the archive root', () => {
		expect(
			releaseArchiveArguments('/release/cupboard.tar.gz', '/release/package')
		).toStrictEqual([
			'-czf',
			'/release/cupboard.tar.gz',
			'-C',
			'/release/package',
			'cupboard',
			hookHelperBinaryName
		]);
	});
});
