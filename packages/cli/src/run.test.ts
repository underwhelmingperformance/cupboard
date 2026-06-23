import { describe, expect, it } from 'vitest';

import { runCli } from './run.ts';

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
});
