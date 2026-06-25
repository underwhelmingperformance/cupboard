import {
	nixSha256HashSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	cacheScopedKey,
	classifyKey,
	internalKeyFor,
	narinfoS3Key,
	narS3Key,
	resolveCacheTarget,
	resolveListPrefix
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
			hash: narHash
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
		expect(internalKeyFor({ kind: 'nar', hash: narHash }, 'acme', '')).toBe(
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
			hash: narHash
		});
	});
});

describe('resolveCacheTarget', () => {
	it('resolves default-cache and named-cache keys', () => {
		expect(resolveCacheTarget(`${storePathHash}.narinfo`)).toStrictEqual({
			cache: '',
			object: { kind: 'narinfo', storePathHash }
		});
		expect(resolveCacheTarget(`nar/${narHash}.nar.zst`)).toStrictEqual({
			cache: '',
			object: { kind: 'nar', hash: narHash }
		});
		expect(resolveCacheTarget(`builds/${storePathHash}.narinfo`)).toStrictEqual(
			{
				cache: 'builds',
				object: { kind: 'narinfo', storePathHash }
			}
		);
		expect(resolveCacheTarget(`builds/nar/${narHash}.nar.zst`)).toStrictEqual({
			cache: 'builds',
			object: { kind: 'nar', hash: narHash }
		});
		expect(resolveCacheTarget('builds/nix-cache-info')).toStrictEqual({
			cache: 'builds',
			object: { kind: 'cache-info' }
		});
		expect(resolveCacheTarget('builds/junk')).toBeUndefined();
	});
});

describe('resolveListPrefix and cacheScopedKey', () => {
	it('splits a list prefix into cache and object prefix', () => {
		expect(resolveListPrefix('')).toStrictEqual({
			cache: '',
			objectPrefix: ''
		});
		expect(resolveListPrefix('nar/')).toStrictEqual({
			cache: '',
			objectPrefix: 'nar/'
		});
		expect(resolveListPrefix('builds/nar/')).toStrictEqual({
			cache: 'builds',
			objectPrefix: 'nar/'
		});
	});

	it('scopes an object key under its cache', () => {
		expect(cacheScopedKey('', 'a.narinfo')).toBe('a.narinfo');
		expect(cacheScopedKey('builds', 'a.narinfo')).toBe('builds/a.narinfo');
	});
});
