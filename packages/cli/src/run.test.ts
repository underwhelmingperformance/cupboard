import { describe, expect, it, vi } from 'vitest';

import { runCli } from './run.ts';

// `cupboard init` runs a first deploy whose deployment never serves the new
// build, so the deploy stops before the claim.
vi.mock('./deploy/command.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./deploy/command.ts')>();

	return {
		...actual,
		executeDeploy: () => {
			actual.endBeforeReady(
				{
					outro: () => {
						// The outro is not part of the exit status.
					}
				},
				{ kind: 'bootstrap' },
				'https://cache.example.com'
			);

			return Promise.resolve();
		}
	};
});

describe('runCli', () => {
	it.each([
		{ name: 'the version', argv: ['--version'] },
		{ name: 'the root help', argv: ['--help'] },
		{ name: 'a subcommand help', argv: ['push', '--help'] }
	])('returns 0 when commander prints $name and stops', async ({ argv }) => {
		expect(await runCli(['node', 'cupboard', ...argv])).toBe(0);
	});

	it('returns a non-zero code for an unknown command', async () => {
		expect(
			await runCli(['node', 'cupboard', 'no-such-command'])
		).toBeGreaterThan(0);
	});

	// The released binary sets `process.exitCode` to the value that `runCli`
	// returns, so the failure has to be in that value.
	it('returns a non-zero code for a first deploy that stops before the claim', async () => {
		expect(
			await runCli(['node', 'cupboard', 'init', '--output-mode', 'json'])
		).toBe(1);
	});
});
