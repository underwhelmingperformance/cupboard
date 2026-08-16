import { execFile } from 'node:child_process';
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildEventSchema, invocationIdSchema } from '@cupboard/protocol/build';
import { afterEach, describe, expect, it } from 'vitest';

import { composeBuildEventLine, renderHookScript } from './hook-script.ts';

const invocationId = invocationIdSchema.parse('invocation-1');
const outputPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const otherOutputPath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib';
const derivation = '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-app.drv';
const execute = promisify(execFile);
const fixtures: string[] = [];
const byText = (left: string, right: string): number =>
	left.localeCompare(right);

afterEach(async () => {
	const created = [...fixtures];
	fixtures.length = 0;

	await Promise.all(
		created.map((fixture) => rm(fixture, { recursive: true, force: true }))
	);
});

describe('renderHookScript', () => {
	it.each([
		{
			name: 'successful root creation',
			rootDirectoryExists: true,
			failedPath: undefined,
			protection: undefined,
			rootEntries: [
				'0123456789abcdfghijklmnpqrsvwxyz',
				'3123456789abcdfghijklmnpqrsvwxyz'
			],
			rootTargets: [outputPath, otherOutputPath]
		},
		{
			name: 'one failed root',
			rootDirectoryExists: true,
			failedPath: outputPath,
			protection: 'failed',
			rootEntries: ['3123456789abcdfghijklmnpqrsvwxyz'],
			rootTargets: [otherOutputPath]
		},
		{
			name: 'failed root creation',
			rootDirectoryExists: false,
			failedPath: undefined,
			protection: 'failed',
			rootEntries: [],
			rootTargets: []
		}
	])(
		'reports both outputs after $name',
		async ({
			rootDirectoryExists,
			failedPath,
			protection,
			rootEntries: expectedRootEntries,
			rootTargets: expectedRootTargets
		}) => {
			const workspace = await mkdtemp(path.join(tmpdir(), "cup-hook-o'brien-"));
			fixtures.push(workspace);
			const rootDirectory = path.join(workspace, "root links o'brien");
			const eventFile = path.join(workspace, 'event');
			const socketFile = path.join(workspace, 'socket');
			const helper = path.join(workspace, "helper o'brien");
			const hook = path.join(workspace, 'hook.sh');
			const binDirectory = path.join(workspace, 'bin');

			await mkdir(binDirectory);
			if (rootDirectoryExists) {
				await mkdir(rootDirectory, { recursive: true });
			}
			await writeFile(
				path.join(binDirectory, 'nix-store'),
				rootDirectoryExists
					? '#!/bin/sh\n[ "$2" = "$FAILED_PATH" ] && exit 1\n/bin/ln -s "$2" "$4"\n'
					: '#!/bin/sh\nexit 1\n',
				{ mode: 0o700 }
			);

			await writeFile(
				helper,
				'#!/bin/sh\nprintf \'%s\\n\' "$1" > "$SOCKET_FILE"\n/bin/cat > "$EVENT_FILE"\n',
				{ mode: 0o700, flush: true }
			);
			await writeFile(
				hook,
				renderHookScript({
					invocationId,
					helperPath: helper,
					socketPath: socketFile,
					rootLinkDirectory: rootDirectory
				}),
				{ mode: 0o700 }
			);
			await chmod(helper, 0o700);

			const result = await execute('/bin/sh', [hook], {
				env: {
					...process.env,
					PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
					FAILED_PATH: failedPath ?? '',
					EVENT_FILE: eventFile,
					SOCKET_FILE: socketFile,
					DRV_PATH: derivation,
					OUT_PATHS: `${outputPath} ${otherOutputPath}`
				}
			});
			const eventContents = await readFile(eventFile, 'utf8');
			const event = buildEventSchema.parse(JSON.parse(eventContents));
			const rootEntries = rootDirectoryExists
				? await readdir(rootDirectory)
				: [];
			const rootTargets = rootDirectoryExists
				? await Promise.all(
						rootEntries.map((entry) =>
							readlink(path.join(rootDirectory, entry))
						)
					)
				: [];
			const socketContents = await readFile(socketFile, 'utf8');
			expect({
				exitCode: 0,
				event,
				socket: socketContents.trim(),
				rootEntries: rootEntries.toSorted(byText),
				rootTargets: rootTargets.toSorted(byText),
				warned: result.stderr !== ''
			}).toStrictEqual({
				exitCode: 0,
				event: {
					version: 1,
					invocationId,
					derivation,
					outputPaths: [outputPath, otherOutputPath],
					...(protection !== undefined && { outputProtection: protection })
				},
				socket: socketFile,
				rootEntries: expectedRootEntries.toSorted(byText),
				rootTargets: expectedRootTargets.toSorted(byText),
				warned: protection !== undefined
			});
		}
	);
});

describe('composeBuildEventLine', () => {
	it.each([
		{
			name: 'a single output path',
			outPaths: outputPath,
			expectedOutputs: [outputPath]
		},
		{
			name: 'two space-separated output paths',
			outPaths: `${outputPath} ${otherOutputPath}`,
			expectedOutputs: [outputPath, otherOutputPath]
		},
		{
			name: 'a trailing separator',
			outPaths: `${outputPath} `,
			expectedOutputs: [outputPath]
		}
	])('composes a valid event for $name', ({ outPaths, expectedOutputs }) => {
		const line = composeBuildEventLine(invocationId, derivation, outPaths);

		expect(buildEventSchema.parse(JSON.parse(line))).toStrictEqual({
			version: 1,
			invocationId,
			derivation,
			outputPaths: expectedOutputs
		});
	});
});
