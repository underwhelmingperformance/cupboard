import { describe, expect, it } from 'vitest';

import { nixSystems, nixSystemSchema } from './nix-systems.ts';
import { nixSystemFor } from './setting-types.ts';

describe('nixSystems', () => {
	it('lists the systems in nix-systems.json in the order of the schema', () => {
		expect(nixSystems).toStrictEqual(nixSystemSchema.options);
	});
});

describe('nixSystemFor', () => {
	it('maps Node platforms and architectures to Nix systems', () => {
		expect([
			nixSystemFor('linux', 'x64'),
			nixSystemFor('linux', 'arm64'),
			nixSystemFor('darwin', 'arm64')
		]).toStrictEqual(['x86_64-linux', 'aarch64-linux', 'aarch64-darwin']);
	});

	it('does not infer a Nix system for unsupported hosts', () => {
		expect([
			nixSystemFor('win32', 'x64'),
			nixSystemFor('linux', 'riscv64'),
			nixSystemFor('darwin', 'x64')
		]).toStrictEqual([undefined, undefined, undefined]);
	});
});
