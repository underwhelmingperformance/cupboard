import {
	nixSha256HashSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	classifyKey,
	internalKeyFor,
	narinfoS3Key,
	narS3Key
} from './nix-cache-keys.ts';

const storePathHash = storePathHashSchema.parse(
	'00000000000000000000000000000000'
);
const narHash = nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`);

describe('classifyKey', () => {
	it('classifies the three cache key shapes', () => {
		expect(classifyKey('nix-cache-info')).toStrictEqual({ kind: 'cache-info' });
		expect(classifyKey(`${storePathHash}.narinfo`)).toStrictEqual({
			kind: 'narinfo',
			storePathHash
		});
		expect(classifyKey(`nar/${narHash}.nar.zst`)).toStrictEqual({
			kind: 'nar',
			narHash
		});
	});

	it('rejects keys outside the cache grammar', () => {
		expect(classifyKey('random.txt')).toBeUndefined();
		expect(classifyKey('nar/not-a-hash.nar.zst')).toBeUndefined();
		expect(classifyKey('deadbeef.narinfo')).toBeUndefined();
		expect(classifyKey(`sub/${storePathHash}.narinfo`)).toBeUndefined();
		expect(classifyKey('')).toBeUndefined();
	});
});

describe('internalKeyFor', () => {
	it('namespaces a narinfo by tenant and cache and shares the NAR', () => {
		expect(internalKeyFor({ kind: 'narinfo', storePathHash }, 'acme', '')).toBe(
			`t/acme/narinfo/${storePathHash}`
		);
		expect(
			internalKeyFor({ kind: 'narinfo', storePathHash }, 'acme', 'builds')
		).toBe(`t/acme/narinfo/builds/${storePathHash}`);
		expect(internalKeyFor({ kind: 'nar', narHash }, 'acme', '')).toBe(
			`nar/${narHash}.nar.zst`
		);
	});

	it('refuses to address nix-cache-info', () => {
		expect(() => internalKeyFor({ kind: 'cache-info' }, 'acme', '')).toThrow();
	});
});

describe('reverse S3 keys', () => {
	it('round-trips through classifyKey', () => {
		expect(classifyKey(narinfoS3Key(storePathHash))).toStrictEqual({
			kind: 'narinfo',
			storePathHash
		});
		expect(classifyKey(narS3Key(narHash))).toStrictEqual({
			kind: 'nar',
			narHash
		});
	});
});
