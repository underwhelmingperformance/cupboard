import { describe, expect, it } from 'vitest';

import { nixSystemFor } from './setting-types.ts';

describe('nixSystemFor', () => {
	it('maps Node platforms and architectures to Nix systems', () => {
		expect([
			nixSystemFor('linux', 'x64'),
			nixSystemFor('linux', 'arm64'),
			nixSystemFor('darwin', 'x64'),
			nixSystemFor('darwin', 'arm64')
		]).toStrictEqual([
			'x86_64-linux',
			'aarch64-linux',
			'x86_64-darwin',
			'aarch64-darwin'
		]);
	});

	it('does not infer a Nix system for unsupported hosts', () => {
		expect([
			nixSystemFor('win32', 'x64'),
			nixSystemFor('linux', 'riscv64')
		]).toStrictEqual([undefined, undefined]);
	});
});
