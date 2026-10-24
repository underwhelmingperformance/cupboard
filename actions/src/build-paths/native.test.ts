import process from 'node:process';

import { stopLogging } from '@cupboard/logger/testing';
import { discoverNixStoreConfig } from '@cupboard/nix';
import { fetchWithProbeRetries } from '@cupboard/shared/paging';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { buildPathInputs, runNativeBuild } from './native.ts';
import { observeBuild } from './observation.ts';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe('native build inputs', () => {
	it.each([undefined, '', ' \t '])(
		'defaults an absent or blank publication scope to built: %j',
		(publish) => {
			const inputs = buildPathInputs({ INPUT_PUBLISH: publish });

			expect(inputs).toStrictEqual({
				installables: [],
				installablesFile: undefined,
				inlinePaths: undefined,
				cupboardPath: undefined,
				keepGoing: undefined,
				maxJobs: undefined,
				allowFailure: undefined,
				build: undefined,
				requireProvenance: undefined,
				publish: 'built',
				substituter: undefined,
				publicationUrl: undefined
			});
		}
	);
});

describe('native build diagnostic', () => {
	it('refuses an existing hook and recommends supported publication modes', async () => {
		vi.stubEnv('GITHUB_ACTIONS', 'true');
		const canWriteOutput = vi
			.spyOn(process.stdout, 'write')
			.mockReturnValue(true);
		const protect = vi.fn(() => Promise.resolve());
		const previousExitCode = process.exitCode;
		let result: unknown;
		try {
			await runNativeBuild(async () => {
				await observeBuild({
					environment: {},
					config: {
						...discoverNixStoreConfig(),
						postBuildHook: '/opt/existing-hook'
					},
					nix: {
						storeKind: 'local-filesystem',
						daemonTrust: () => Promise.resolve('trusted')
					},
					invocationId: 'existing-hook-test',
					cupboardPath: '/opt/cupboard',
					protection: { directory: '/private/tmp/unused-roots', protect }
				});
			});
			result = {
				output: canWriteOutput.mock.calls,
				status: process.exitCode,
				protectedPaths: protect.mock.calls
			};
		} finally {
			process.exitCode = previousExitCode;
		}

		expect(result).toStrictEqual({
			output: [
				[
					'::error::The Nix configuration already sets post-build-hook (/opt/existing-hook), and Nix supports exactly one. Remove the existing hook, or set publish: outputs or publish: closure. These modes do not publish observed intermediate outputs.\n'
				]
			],
			status: 1,
			protectedPaths: []
		});
	});
});

describe('native build logging', () => {
	it('writes a probe record from the build as a workflow debug line', async () => {
		vi.stubEnv('GITHUB_ACTIONS', 'true');
		stopLogging();
		onTestFinished(() => {
			stopLogging();
		});
		vi.useFakeTimers();
		const canWriteOutput = vi
			.spyOn(process.stdout, 'write')
			.mockReturnValue(true);
		try {
			await runNativeBuild(async () => {
				await fetchWithProbeRetries(
					() => Promise.resolve(new Response('response body')),
					'https://cache.example.test/a.narinfo',
					undefined,
					(response) => response.text()
				);
			});
		} finally {
			vi.useRealTimers();
		}

		expect(canWriteOutput.mock.calls).toStrictEqual([
			[
				'::debug::probe attempt finished url=https://cache.example.test/a.narinfo attempt=1 outcome=succeeded elapsedMs=0\n'
			]
		]);
	});
});
