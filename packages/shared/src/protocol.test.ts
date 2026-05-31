import { describe, expect, it } from 'vitest';

import {
	CacheInfo,
	fromNixBase32,
	InvalidNixSha256HashError,
	InvalidStorePathError,
	NixConfig,
	StorePath
} from './protocol.ts';

describe('CacheInfo', () => {
	it('renders nix-cache-info', () => {
		expect(CacheInfo.default.render()).toBe(
			['StoreDir: /nix/store', 'WantMassQuery: 1', 'Priority: 40', ''].join(
				'\n'
			)
		);
	});
});

describe('StorePath', () => {
	it('extracts the basename and store path hash', () => {
		const storePath = new StorePath(
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-example'
		);

		expect({
			basename: storePath.basename,
			hash: storePath.hash
		}).toStrictEqual({
			basename: '0123456789abcdfghijklmnpqrsvwxyz-example',
			hash: '0123456789abcdfghijklmnpqrsvwxyz'
		});
	});

	it('rejects invalid store paths with a typed error', () => {
		expect(() => new StorePath('/tmp/example')).toThrow(InvalidStorePathError);
	});
});

describe('fromNixBase32', () => {
	it.each([
		{ name: 'an out-of-alphabet character', value: 'e'.repeat(52) },
		{ name: 'an empty string', value: '' },
		{ name: 'a too-short input', value: '1'.repeat(51) },
		{ name: 'a too-long input', value: '1'.repeat(53) }
	])('rejects $name', ({ value }) => {
		expect(() => fromNixBase32(value)).toThrow(InvalidNixSha256HashError);
	});
});

describe('NixConfig', () => {
	it('renders a nix.conf snippet', () => {
		expect(
			new NixConfig('https://cache.example', 'cupboard-1:key').render()
		).toBe(
			[
				'substituters = https://cache.example',
				'trusted-public-keys = cupboard-1:key',
				''
			].join('\n')
		);
	});
});
