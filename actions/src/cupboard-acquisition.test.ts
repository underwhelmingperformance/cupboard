import { createGithubReporter } from '@cupboard/reporter';
import { describe, expect, it, vi } from 'vitest';

import { acquireCupboard } from './cupboard-acquisition.ts';
import type { ResolvedCupboard } from './cupboard-resolution.ts';

const reporter = createGithubReporter();
const baseOptions = {
	installDirectory: '/runner/temp/cupboard-bin',
	checkoutDirectory: '/workspace/.cupboard',
	githubToken: 'token',
	environment: { GITHUB_API_URL: 'https://api.github.test' }
};

describe('acquireCupboard', () => {
	it('installs an already-canonical release with its exact source commit', async () => {
		const cupboard: ResolvedCupboard = {
			kind: 'release',
			repository: 'owner/cupboard',
			tag: 'v1.2.3',
			sourceCommit: 'a'.repeat(40)
		};
		const installRelease = vi.fn(() =>
			Promise.resolve({
				binaryPath: '/runner/temp/cupboard-bin/cupboard',
				version: 'v1.2.3',
				sourceCommit: 'a'.repeat(40)
			})
		);
		const installSource = vi.fn();

		const acquired = await acquireCupboard(
			{ ...baseOptions, cupboard },
			reporter,
			{ installRelease, installSource }
		);

		expect({ acquired, releaseCalls: installRelease.mock.calls }).toStrictEqual(
			{
				acquired: {
					binaryPath: '/runner/temp/cupboard-bin/cupboard',
					cupboard
				},
				releaseCalls: [
					[
						{
							installDirectory: '/runner/temp/cupboard-bin',
							releaseRepository: 'owner/cupboard',
							version: 'v1.2.3',
							includePrereleases: true,
							githubToken: 'token',
							environment: {
								GITHUB_API_URL: 'https://api.github.test'
							},
							expectedSourceCommit: 'a'.repeat(40)
						},
						reporter
					]
				]
			}
		);
		expect(installSource).not.toHaveBeenCalled();
	});

	it('builds an already-canonical source checkout', async () => {
		const cupboard: ResolvedCupboard = {
			kind: 'source',
			repository: 'owner/cupboard',
			sourceCommit: 'b'.repeat(40)
		};
		const installRelease = vi.fn();
		const installSource = vi.fn(() =>
			Promise.resolve({
				binaryPath: '/nix/store/cupboard/bin/cupboard',
				cupboard
			})
		);

		const acquired = await acquireCupboard(
			{ ...baseOptions, cupboard },
			reporter,
			{ installRelease, installSource }
		);

		expect({ acquired, sourceCalls: installSource.mock.calls }).toStrictEqual({
			acquired: {
				binaryPath: '/nix/store/cupboard/bin/cupboard',
				cupboard
			},
			sourceCalls: [
				[
					{
						checkoutDirectory: '/workspace/.cupboard',
						cupboard
					}
				]
			]
		});
		expect(installRelease).not.toHaveBeenCalled();
	});

	it('never falls back to source when release installation fails', async () => {
		const failure = new Error('attestation missing');
		const installSource = vi.fn();

		await expect(
			acquireCupboard(
				{
					...baseOptions,
					cupboard: {
						kind: 'release',
						repository: 'owner/cupboard',
						tag: 'v1.2.3',
						sourceCommit: 'a'.repeat(40)
					}
				},
				reporter,
				{
					installRelease: () => Promise.reject(failure),
					installSource
				}
			)
		).rejects.toBe(failure);
		expect(installSource).not.toHaveBeenCalled();
	});
});
