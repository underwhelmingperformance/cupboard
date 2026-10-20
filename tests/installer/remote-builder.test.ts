import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
	BuildEventListener,
	environmentWithPostBuildHook,
	renderHookScript
} from '@cupboard/nix/build-observation';
import { type BuildEvent, invocationIdSchema } from '@cupboard/protocol/build';
import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	prepareBuilderHook,
	removeBuilderHook
} from '../../actions/src/prepare-builders/hook.ts';
import { discoverNixStoreConfig } from '../../packages/nix/src/store-config.ts';
import { startNixSshStore } from '../support/remote-nix-store.ts';

const execute = promisify(execFile);
const evaluatedSchema = z.object({
	input: z.string(),
	output: z.string(),
	derivation: z.string()
});

it('copies inputs and outputs through a separate builder while observing the completed build', async () => {
	if (
		process.env.CUPBOARD_NIX_INSTALLER_TRIAL !== '1' ||
		process.env.GITHUB_ACTIONS !== 'true'
	) {
		throw new Error(
			'Run this trial only in its disposable GitHub Actions jobs'
		);
	}
	const directory = await mkdtemp('/tmp/cb-builder-');
	const remote = await startNixSshStore();
	let hookDirectory: string | undefined;
	let listener: BuildEventListener | undefined;
	try {
		const seed = randomUUID();
		const invocationId = invocationIdSchema.parse(`builder-${seed}`);
		const marker = `/tmp/cupboard-built-${seed}`;
		const system = process.env.NIX_SYSTEM;
		if (system === undefined) {
			throw new Error('NIX_SYSTEM is required');
		}
		const environment = {
			...process.env,
			...remote.environment,
			NIX_CONFIG: `${process.env.NIX_CONFIG ?? ''}\nexperimental-features = nix-command flakes\nbuilders = ${remote.transportConfiguredStoreUri} ${system} - 1 1\nmax-jobs = 0\nsandbox = false\nsubstituters =\n`
		};
		const hook = await prepareBuilderHook(environment, {
			probeWorkerPath: new URL(
				'../../actions/prepare-builders/dist/probe-worker.cjs',
				import.meta.url
			).pathname
		});
		hookDirectory = hook.directory;
		const helper = path.join(directory, 'cupboard-hook-relay');
		await execute('cc', [
			'-std=c11',
			'-O2',
			'packages/cli/hook-helper/cupboard-hook-relay.c',
			'-o',
			helper
		]);
		const events: BuildEvent[] = [];
		const rejected: unknown[] = [];
		const socketPath = path.join(directory, 'hook.sock');
		listener = await BuildEventListener.listen({
			socketPath,
			storeDirectory: discoverNixStoreConfig().storeDirectory,
			onEvent: (event) => {
				events.push(event);
			},
			onRejected: (error) => {
				rejected.push(error);
			}
		});
		const postHook = path.join(directory, 'post-build');
		await writeFile(
			postHook,
			renderHookScript({ invocationId, helperPath: helper, socketPath }),
			{ mode: 0o700 }
		);
		const buildEnvironment = environmentWithPostBuildHook(
			{ ...environment, NIX_CONFIG: hook.nixConfig },
			postHook
		);
		const expression = String.raw`derivation { name = "cupboard-separate-builder-${seed}"; system = "${system}"; input = builtins.toFile "input-${seed}" "${seed}\n"; builder = "/bin/sh"; args = [ "-c" "read -r content < $input; printf '%s' \"$content\" > $out; : > ${marker}" ]; preferLocalBuild = false; allowSubstitutes = false; }`;
		const evaluated = await execute(
			'nix',
			[
				'eval',
				'--impure',
				'--json',
				'--expr',
				`let d = ${expression}; in { input = d.input; output = d.outPath; derivation = d.drvPath; }`
			],
			{ env: buildEnvironment }
		);
		const paths = evaluatedSchema.parse(JSON.parse(evaluated.stdout));
		await remote.exec(['test', '!', '-e', paths.input]);
		await remote.exec(['test', '!', '-e', paths.output]);
		await execute(
			'nix',
			['build', '--no-link', '--impure', '--expr', expression],
			{ env: buildEnvironment, timeout: 120_000 }
		);
		await listener.drain();
		await remote.exec(['test', '-f', marker]);
		expect({
			local: await readFile(paths.output, 'utf8'),
			remote: await remote.exec(['cat', paths.output]),
			input: await remote.exec(['cat', paths.input]),
			events,
			rejected
		}).toStrictEqual({
			local: seed,
			remote: seed,
			input: seed,
			events: [
				{
					version: 1,
					invocationId,
					derivation: paths.derivation,
					outputPaths: [paths.output]
				}
			],
			rejected: []
		});
	} finally {
		await listener?.close();
		if (hookDirectory !== undefined) {
			await removeBuilderHook(hookDirectory);
		}
		await remote.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 180_000);
