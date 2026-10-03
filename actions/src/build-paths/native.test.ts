import process from 'node:process';

import { discoverNixStoreConfig } from '@cupboard/nix';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
		const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
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
				output: output.mock.calls,
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
