import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
	cacheNameSchema,
	cachePrioritySchema,
	compressionSchema,
	creatableCacheNameSchema,
	DEFAULT_CACHE,
	nixSha256HashSchema,
	positiveIntSchema,
	predicateTypeSchema,
	referencesMaxLength,
	referencesSchema,
	rootNameSchema,
	sha256HexDigestSchema,
	signingKeyIdSchema,
	storeDirectoryMaxLength,
	storeDirectorySchema,
	storePathBasenameSchema,
	storePathHashSchema,
	storePathSchema,
	ttlSecondsSchema
} from './scalars.ts';

const nixHash = `sha256:${'1'.repeat(52)}`;
const storePathHash = '0'.repeat(32);
const storePath = `/nix/store/${storePathHash}-name`;
const uuid = '123e4567-e89b-12d3-a456-426614174000';

const acceptedCases: readonly {
	name: string;
	schema: z.ZodType;
	value: unknown;
}[] = [
	{
		name: 'a valid nix hash',
		schema: nixSha256HashSchema,
		value: nixHash
	},
	{
		name: 'a valid sha256 hex digest',
		schema: sha256HexDigestSchema,
		value: 'a'.repeat(64)
	},
	{
		name: 'a valid store path hash',
		schema: storePathHashSchema,
		value: storePathHash
	},
	{
		name: 'a valid store path',
		schema: storePathSchema,
		value: storePath
	},
	{
		name: 'a store path with an upper-case and punctuation name',
		schema: storePathSchema,
		value: `/nix/store/${storePathHash}-Name+._?=`
	},
	{
		name: 'a store path in a store directory under a home directory',
		schema: storePathSchema,
		value: `/home/laney/nixstore/${storePathHash}-name`
	},
	{
		name: 'a store path in a deeply nested store directory',
		schema: storePathSchema,
		value: `/var/lib/cupboard/nix/store/${storePathHash}-name`
	},
	{
		name: 'a store path whose store directory has dots inside a segment',
		schema: storePathSchema,
		value: `/nix/store.d/..foo/${storePathHash}-name`
	},
	{
		name: 'the default store directory',
		schema: storeDirectorySchema,
		value: '/nix/store'
	},
	{
		name: 'a single-segment store directory',
		schema: storeDirectorySchema,
		value: '/nixstore'
	},
	{
		name: 'a deeply nested store directory',
		schema: storeDirectorySchema,
		value: '/var/lib/cupboard/nix/store'
	},
	{
		name: 'a valid store path basename',
		schema: storePathBasenameSchema,
		value: `${storePathHash}-Name+._?=`
	},
	{
		name: 'a references array within the cap',
		schema: referencesSchema,
		value: Array.from(
			{ length: referencesMaxLength },
			() => `${storePathHash}-name`
		)
	},
	{
		name: 'a valid root name',
		schema: rootNameSchema,
		value: 'github:owner/repo/main'
	},
	{
		name: 'a valid predicate type',
		schema: predicateTypeSchema,
		value: 'https://slsa.dev/provenance/v1'
	},
	{ name: 'a valid ttl', schema: ttlSecondsSchema, value: 3600 },
	{
		name: 'a positive integer',
		schema: positiveIntSchema,
		value: 1
	},
	{
		name: 'a supported compression',
		schema: compressionSchema,
		value: 'zstd'
	},
	{
		name: 'valid references',
		schema: referencesSchema,
		value: [`${storePathHash}-a`, `${'1'.repeat(32)}-B+._?=`]
	},
	{
		name: 'the active signing key id',
		schema: signingKeyIdSchema,
		value: 'active'
	},
	{
		name: 'a uuid signing key id',
		schema: signingKeyIdSchema,
		value: uuid
	},
	{
		name: 'a simple cache name',
		schema: cacheNameSchema,
		value: 'builds'
	},
	{
		name: 'a cache name with the allowed punctuation',
		schema: cacheNameSchema,
		value: '0a.b-c_d'
	},
	{
		name: 'a 63-character cache name',
		schema: cacheNameSchema,
		value: 'a'.repeat(63)
	},
	{
		name: 'the reserved nar name in cacheNameSchema',
		schema: cacheNameSchema,
		value: 'nar'
	},
	{
		name: 'a zero cache priority',
		schema: cachePrioritySchema,
		value: 0
	},
	{
		name: 'a positive cache priority',
		schema: cachePrioritySchema,
		value: 40
	}
];

const rejectedCases: readonly {
	name: string;
	schema: z.ZodType;
	value: unknown;
}[] = [
	{
		name: 'a too-short nix hash',
		schema: nixSha256HashSchema,
		value: 'sha256:short'
	},
	{
		name: 'a nix hash with an out-of-alphabet character',
		schema: nixSha256HashSchema,
		value: `sha256:${'e'.repeat(52)}`
	},
	{
		name: 'a nix hash without the prefix',
		schema: nixSha256HashSchema,
		value: '1'.repeat(52)
	},
	{
		name: 'a sha256 hex digest with upper-case characters',
		schema: sha256HexDigestSchema,
		value: 'A'.repeat(64)
	},
	{
		name: 'a sha256 hex digest with the nix hash prefix',
		schema: sha256HexDigestSchema,
		value: `sha256:${'a'.repeat(64)}`
	},
	{
		name: 'a short sha256 hex digest',
		schema: sha256HexDigestSchema,
		value: 'a'.repeat(63)
	},
	{
		name: 'a store path hash with bad characters',
		schema: storePathHashSchema,
		value: 'e'.repeat(32)
	},
	{
		name: 'a short store path hash',
		schema: storePathHashSchema,
		value: '0'.repeat(31)
	},
	{
		name: 'a store path with a short hash',
		schema: storePathSchema,
		value: '/nix/store/short-name'
	},
	{
		name: 'a store path with whitespace in the name',
		schema: storePathSchema,
		value: `${storePath} with-space`
	},
	{
		name: 'a store path with a newline in the name',
		schema: storePathSchema,
		value: `${storePath}\nInjected: value`
	},
	{
		name: 'a path whose basename is not a store-path basename',
		schema: storePathSchema,
		value: '/etc/passwd'
	},
	{
		name: 'a store path with no store directory in front of it',
		schema: storePathSchema,
		value: `/${storePathHash}-name`
	},
	{
		name: 'a relative store path',
		schema: storePathSchema,
		value: `nix/store/${storePathHash}-name`
	},
	{
		name: 'a store path whose store directory is longer than the cap',
		schema: storePathSchema,
		value: `/${'d'.repeat(storeDirectoryMaxLength)}/${storePathHash}-name`
	},
	{
		name: 'a store path whose store directory walks up a level',
		schema: storePathSchema,
		value: `/nix/../etc/${storePathHash}-name`
	},
	{
		name: 'a store path whose store directory names the current level',
		schema: storePathSchema,
		value: `/nix/./store/${storePathHash}-name`
	},
	{
		name: 'a store path walking up out of the store directory',
		schema: storePathSchema,
		value: `/nix/store/../${storePathHash}-name`
	},
	{
		name: 'a relative store directory',
		schema: storeDirectorySchema,
		value: 'nix/store'
	},
	{
		name: 'a store directory that walks up a level',
		schema: storeDirectorySchema,
		value: '/nix/../etc'
	},
	{
		name: 'a store directory ending in a current-level segment',
		schema: storeDirectorySchema,
		value: '/nix/.'
	},
	{
		name: 'the filesystem root as a store directory',
		schema: storeDirectorySchema,
		value: '/'
	},
	{
		name: 'a store directory with a trailing separator',
		schema: storeDirectorySchema,
		value: '/nix/store/'
	},
	{
		name: 'a store directory with a newline',
		schema: storeDirectorySchema,
		value: '/nix/store\nStoreDir: /elsewhere'
	},
	{
		name: 'a store directory longer than the cap',
		schema: storeDirectorySchema,
		value: `/${'d'.repeat(storeDirectoryMaxLength)}`
	},
	{
		name: 'a nested path under a store path',
		schema: storePathSchema,
		value: `${storePath}/child`
	},
	{
		name: 'a store path basename with a slash',
		schema: storePathBasenameSchema,
		value: `${storePathHash}-name/child`
	},
	{
		name: 'a store path basename with a control character',
		schema: storePathBasenameSchema,
		value: `${storePathHash}-name`
	},
	{
		name: 'a store path whose name exceeds the length cap',
		schema: storePathSchema,
		value: `/nix/store/${storePathHash}-${'a'.repeat(212)}`
	},
	{
		name: 'a store path basename whose name exceeds the length cap',
		schema: storePathBasenameSchema,
		value: `${storePathHash}-${'a'.repeat(212)}`
	},
	{
		name: 'a references array exceeding the cap',
		schema: referencesSchema,
		value: Array.from(
			{ length: referencesMaxLength + 1 },
			() => `${storePathHash}-name`
		)
	},
	{
		name: 'an empty root name',
		schema: rootNameSchema,
		value: ''
	},
	{
		name: 'an over-long root name',
		schema: rootNameSchema,
		value: 'a'.repeat(257)
	},
	{
		name: 'a root name with a control character',
		schema: rootNameSchema,
		value: 'bad\nname'
	},
	{
		name: 'an empty predicate type',
		schema: predicateTypeSchema,
		value: ''
	},
	{
		name: 'a predicate type with a control character',
		schema: predicateTypeSchema,
		value: 'https://example.test/predicatebad'
	},
	{
		name: 'an overlong predicate type',
		schema: predicateTypeSchema,
		value: 'a'.repeat(513)
	},
	{
		name: 'a zero ttl',
		schema: ttlSecondsSchema,
		value: 0
	},
	{
		name: 'a fractional ttl',
		schema: ttlSecondsSchema,
		value: 1.5
	},
	{
		name: 'an out-of-range ttl',
		schema: ttlSecondsSchema,
		value: 315_360_001
	},
	{
		name: 'a zero integer',
		schema: positiveIntSchema,
		value: 0
	},
	{
		name: 'a negative integer',
		schema: positiveIntSchema,
		value: -1
	},
	{
		name: 'a fractional number',
		schema: positiveIntSchema,
		value: 1.5
	},
	{
		name: 'an unsupported compression',
		schema: compressionSchema,
		value: 'gzip'
	},
	{
		name: 'a reference with a newline',
		schema: referencesSchema,
		value: [`${storePathHash}-a\nInjected: value`]
	},
	{
		name: 'a reference without a store hash',
		schema: referencesSchema,
		value: ['name-only']
	},
	{
		name: 'a signing key id that is neither active nor a uuid',
		schema: signingKeyIdSchema,
		value: 'rotated'
	},
	{
		name: 'a mis-cased active signing key id',
		schema: signingKeyIdSchema,
		value: 'Active'
	},
	{
		name: 'an empty cache name',
		schema: cacheNameSchema,
		value: ''
	},
	{
		name: 'a cache name starting with punctuation',
		schema: cacheNameSchema,
		value: '-builds'
	},
	{
		name: 'an upper-case cache name',
		schema: cacheNameSchema,
		value: 'Builds'
	},
	{
		name: 'a cache name with a slash',
		schema: cacheNameSchema,
		value: 'a/b'
	},
	{
		name: 'a 64-character cache name',
		schema: cacheNameSchema,
		value: 'a'.repeat(64)
	},
	{
		name: 'the reserved nar name in creatableCacheNameSchema',
		schema: creatableCacheNameSchema,
		value: 'nar'
	},
	{
		name: 'a negative cache priority',
		schema: cachePrioritySchema,
		value: -1
	},
	{
		name: 'a fractional cache priority',
		schema: cachePrioritySchema,
		value: 1.5
	}
];

describe('scalar schemas', () => {
	it.each(acceptedCases)('accepts $name', ({ schema, value }) => {
		expect(schema.parse(value)).toStrictEqual(value);
	});

	it.each(rejectedCases)('rejects $name', ({ schema, value }) => {
		expect(schema.safeParse(value).success).toBe(false);
	});

	it('represents the default cache as the empty string', () => {
		expect(DEFAULT_CACHE).toBe('');
	});

	it.each([
		{
			name: 'basenames',
			value: [`${storePathHash}-a`, `${'1'.repeat(32)}-b`],
			accepted: true
		},
		{ name: 'an empty list', value: [], accepted: true },
		{
			name: 'a reference containing a slash',
			value: ['has/slash'],
			accepted: false
		}
	])('references: $name', ({ value, accepted }) => {
		expect(referencesSchema.safeParse(value).success).toBe(accepted);
	});
});
