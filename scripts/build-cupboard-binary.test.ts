import { describe, expect, it } from 'vitest';

import {
	compileHookHelper,
	hookHelperBinaryName,
	hookHelperSourcePath,
	normaliseBuildVersion,
	releaseArchiveArguments
} from './build-cupboard-binary.ts';

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
