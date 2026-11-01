import { Derivation } from '@cupboard/nix-store/derivation';
import { MalformedDerivationError } from '@cupboard/nix-store/errors';
import { describe, expect, it } from 'vitest';

import { canRetryBuild } from './build-retry.ts';

const sandboxed = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv';
const fixedOutput = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-src.drv';
const outputPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';

function buildStart(derivation: string, machine: string): string {
	return JSON.stringify({
		action: 'start',
		type: 105,
		fields: [derivation, machine, 1, 1]
	});
}

function builderFailure(derivation: string, note = ''): string {
	return JSON.stringify({
		action: 'msg',
		level: 0,
		msg: `error: Cannot build '${derivation}'.\nReason: builder failed with exit code 1.${note}`
	});
}

const store = {
	readDerivation: (derivation: string) =>
		Promise.resolve(
			Derivation.parse(
				derivation === fixedOutput
					? `Derive([("out","${outputPath}","r:sha256","0f2s1n0i8g6b9a3c")],[],[],"aarch64-darwin","/bin/sh",[],[])`
					: `Derive([("out","${outputPath}","","")],[],[],"aarch64-darwin","/bin/sh",[],[])`
			)
		)
};

describe('canRetryBuild', () => {
	it.each([
		{
			name: 'a local builder failure of a sandboxed derivation',
			lines: [buildStart(sandboxed, ''), builderFailure(sandboxed)],
			expected: false
		},
		{
			name: 'a local builder failure of a fixed-output derivation',
			lines: [buildStart(fixedOutput, ''), builderFailure(fixedOutput)],
			expected: true
		},
		{
			name: 'a builder failure on a remote builder',
			lines: [
				buildStart(sandboxed, 'ssh://builder'),
				builderFailure(sandboxed)
			],
			expected: true
		},
		{
			name: 'a local builder failure that Nix attributes to a full disk',
			lines: [
				buildStart(sandboxed, ''),
				builderFailure(
					sandboxed,
					'\nnote: build failure may have been caused by lack of free disk space'
				)
			],
			expected: true
		},
		{
			name: 'a builder failure without build activity',
			lines: [builderFailure(sandboxed)],
			expected: true
		},
		{
			name: 'a failure without a builder message',
			lines: [buildStart(sandboxed, '')],
			expected: true
		},
		{
			name: 'a permanent failure alongside a transient one',
			lines: [
				buildStart(sandboxed, ''),
				buildStart(fixedOutput, ''),
				builderFailure(sandboxed),
				builderFailure(fixedOutput)
			],
			expected: true
		}
	])('returns $expected after $name', async ({ lines, expected }) => {
		await expect(canRetryBuild(lines.join('\n'), store)).resolves.toBe(
			expected
		);
	});

	it.each([
		{ name: 'a missing derivation', error: new Error('not found') },
		{
			name: 'a derivation that cannot be parsed',
			error: new MalformedDerivationError('the outputs are not a list')
		}
	])(
		'returns true after a local builder failure of $name',
		async ({ error }) => {
			await expect(
				canRetryBuild(
					[buildStart(sandboxed, ''), builderFailure(sandboxed)].join('\n'),
					{ readDerivation: () => Promise.reject(error) }
				)
			).resolves.toBe(true);
		}
	);
});
