import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
	cacheNameSchema,
	cachePrioritySchema,
	compressionSchema,
	DEFAULT_CACHE,
	nixSha256HashSchema,
	positiveIntSchema,
	predicateTypeSchema,
	referencesMaxLength,
	referencesSchema,
	rootNameSchema,
	sha256HexDigestSchema,
	signingKeyIdSchema,
	storePathBasenameSchema,
	storePathHashSchema,
	storePathSchema,
	ttlSecondsSchema
} from './scalars.ts';

const nixHash = `sha256:${'1'.repeat(52)}`;
const storePathHash = '0'.repeat(32);
const storePath = `/nix/store/${storePathHash}-name`;
const uuid = '123e4567-e89b-12d3-a456-426614174000';

const cases: readonly {
	name: string;
	schema: z.ZodType;
	value: unknown;
	valid: boolean;
}[] = [
	{
		name: 'a valid nix hash',
		schema: nixSha256HashSchema,
		value: nixHash,
		valid: true
	},
	{
		name: 'a too-short nix hash',
		schema: nixSha256HashSchema,
		value: 'sha256:short',
		valid: false
	},
	{
		name: 'a nix hash with an out-of-alphabet character',
		schema: nixSha256HashSchema,
		value: `sha256:${'e'.repeat(52)}`,
		valid: false
	},
	{
		name: 'a nix hash without the prefix',
		schema: nixSha256HashSchema,
		value: '1'.repeat(52),
		valid: false
	},
	{
		name: 'a valid sha256 hex digest',
		schema: sha256HexDigestSchema,
		value: 'a'.repeat(64),
		valid: true
	},
	{
		name: 'a sha256 hex digest with upper-case characters',
		schema: sha256HexDigestSchema,
		value: 'A'.repeat(64),
		valid: false
	},
	{
		name: 'a sha256 hex digest with the nix hash prefix',
		schema: sha256HexDigestSchema,
		value: `sha256:${'a'.repeat(64)}`,
		valid: false
	},
	{
		name: 'a short sha256 hex digest',
		schema: sha256HexDigestSchema,
		value: 'a'.repeat(63),
		valid: false
	},
	{
		name: 'a valid store path hash',
		schema: storePathHashSchema,
		value: storePathHash,
		valid: true
	},
	{
		name: 'a store path hash with bad characters',
		schema: storePathHashSchema,
		value: 'e'.repeat(32),
		valid: false
	},
	{
		name: 'a short store path hash',
		schema: storePathHashSchema,
		value: '0'.repeat(31),
		valid: false
	},
	{
		name: 'a valid store path',
		schema: storePathSchema,
		value: storePath,
		valid: true
	},
	{
		name: 'a store path with an upper-case and punctuation name',
		schema: storePathSchema,
		value: `/nix/store/${storePathHash}-Name+._?=`,
		valid: true
	},
	{
		name: 'a store path with a short hash',
		schema: storePathSchema,
		value: '/nix/store/short-name',
		valid: false
	},
	{
		name: 'a store path with whitespace in the name',
		schema: storePathSchema,
		value: `${storePath} with-space`,
		valid: false
	},
	{
		name: 'a store path with a newline in the name',
		schema: storePathSchema,
		value: `${storePath}\nInjected: value`,
		valid: false
	},
	{
		name: 'a path outside the store',
		schema: storePathSchema,
		value: '/etc/passwd',
		valid: false
	},
	{
		name: 'a nested path under a store path',
		schema: storePathSchema,
		value: `${storePath}/child`,
		valid: false
	},
	{
		name: 'a valid store path basename',
		schema: storePathBasenameSchema,
		value: `${storePathHash}-Name+._?=`,
		valid: true
	},
	{
		name: 'a store path basename with a slash',
		schema: storePathBasenameSchema,
		value: `${storePathHash}-name/child`,
		valid: false
	},
	{
		name: 'a store path basename with a control character',
		schema: storePathBasenameSchema,
		value: `${storePathHash}-name\u0007`,
		valid: false
	},
	{
		name: 'a store path whose name exceeds the length cap',
		schema: storePathSchema,
		value: `/nix/store/${storePathHash}-${'a'.repeat(212)}`,
		valid: false
	},
	{
		name: 'a store path basename whose name exceeds the length cap',
		schema: storePathBasenameSchema,
		value: `${storePathHash}-${'a'.repeat(212)}`,
		valid: false
	},
	{
		name: 'a references array within the cap',
		schema: referencesSchema,
		value: Array.from(
			{ length: referencesMaxLength },
			() => `${storePathHash}-name`
		),
		valid: true
	},
	{
		name: 'a references array exceeding the cap',
		schema: referencesSchema,
		value: Array.from(
			{ length: referencesMaxLength + 1 },
			() => `${storePathHash}-name`
		),
		valid: false
	},
	{
		name: 'a valid root name',
		schema: rootNameSchema,
		value: 'github:owner/repo/main',
		valid: true
	},
	{
		name: 'an empty root name',
		schema: rootNameSchema,
		value: '',
		valid: false
	},
	{
		name: 'an over-long root name',
		schema: rootNameSchema,
		value: 'a'.repeat(257),
		valid: false
	},
	{
		name: 'a root name with a control character',
		schema: rootNameSchema,
		value: 'bad\nname',
		valid: false
	},
	{
		name: 'a valid predicate type',
		schema: predicateTypeSchema,
		value: 'https://slsa.dev/provenance/v1',
		valid: true
	},
	{
		name: 'an empty predicate type',
		schema: predicateTypeSchema,
		value: '',
		valid: false
	},
	{
		name: 'a predicate type with a control character',
		schema: predicateTypeSchema,
		value: 'https://example.test/predicate\u007Fbad',
		valid: false
	},
	{
		name: 'an overlong predicate type',
		schema: predicateTypeSchema,
		value: 'a'.repeat(513),
		valid: false
	},
	{ name: 'a valid ttl', schema: ttlSecondsSchema, value: 3600, valid: true },
	{ name: 'a zero ttl', schema: ttlSecondsSchema, value: 0, valid: false },
	{
		name: 'a fractional ttl',
		schema: ttlSecondsSchema,
		value: 1.5,
		valid: false
	},
	{
		name: 'an out-of-range ttl',
		schema: ttlSecondsSchema,
		value: 315_360_001,
		valid: false
	},
	{
		name: 'a positive integer',
		schema: positiveIntSchema,
		value: 1,
		valid: true
	},
	{ name: 'a zero integer', schema: positiveIntSchema, value: 0, valid: false },
	{
		name: 'a negative integer',
		schema: positiveIntSchema,
		value: -1,
		valid: false
	},
	{
		name: 'a fractional number',
		schema: positiveIntSchema,
		value: 1.5,
		valid: false
	},
	{
		name: 'a supported compression',
		schema: compressionSchema,
		value: 'zstd',
		valid: true
	},
	{
		name: 'an unsupported compression',
		schema: compressionSchema,
		value: 'gzip',
		valid: false
	},
	{
		name: 'valid references',
		schema: referencesSchema,
		value: [`${storePathHash}-a`, `${'1'.repeat(32)}-B+._?=`],
		valid: true
	},
	{
		name: 'a reference with a newline',
		schema: referencesSchema,
		value: [`${storePathHash}-a\nInjected: value`],
		valid: false
	},
	{
		name: 'a reference without a store hash',
		schema: referencesSchema,
		value: ['name-only'],
		valid: false
	},
	{
		name: 'the active signing key id',
		schema: signingKeyIdSchema,
		value: 'active',
		valid: true
	},
	{
		name: 'a uuid signing key id',
		schema: signingKeyIdSchema,
		value: uuid,
		valid: true
	},
	{
		name: 'a signing key id that is neither active nor a uuid',
		schema: signingKeyIdSchema,
		value: 'rotated',
		valid: false
	},
	{
		name: 'a mis-cased active signing key id',
		schema: signingKeyIdSchema,
		value: 'Active',
		valid: false
	},
	{
		name: 'a simple cache name',
		schema: cacheNameSchema,
		value: 'builds',
		valid: true
	},
	{
		name: 'a cache name with the allowed punctuation',
		schema: cacheNameSchema,
		value: '0a.b-c_d',
		valid: true
	},
	{
		name: 'a 63-character cache name',
		schema: cacheNameSchema,
		value: 'a'.repeat(63),
		valid: true
	},
	{
		name: 'an empty cache name',
		schema: cacheNameSchema,
		value: '',
		valid: false
	},
	{
		name: 'a cache name starting with punctuation',
		schema: cacheNameSchema,
		value: '-builds',
		valid: false
	},
	{
		name: 'an upper-case cache name',
		schema: cacheNameSchema,
		value: 'Builds',
		valid: false
	},
	{
		name: 'a cache name with a slash',
		schema: cacheNameSchema,
		value: 'a/b',
		valid: false
	},
	{
		name: 'a 64-character cache name',
		schema: cacheNameSchema,
		value: 'a'.repeat(64),
		valid: false
	},
	{
		name: 'a zero cache priority',
		schema: cachePrioritySchema,
		value: 0,
		valid: true
	},
	{
		name: 'a positive cache priority',
		schema: cachePrioritySchema,
		value: 40,
		valid: true
	},
	{
		name: 'a negative cache priority',
		schema: cachePrioritySchema,
		value: -1,
		valid: false
	},
	{
		name: 'a fractional cache priority',
		schema: cachePrioritySchema,
		value: 1.5,
		valid: false
	}
];

describe('scalar schemas', () => {
	it.each(cases)('accepts/rejects $name', ({ schema, value, valid }) => {
		expect(schema.safeParse(value).success).toBe(valid);
	});

	it('represents the default cache as the empty string', () => {
		expect(DEFAULT_CACHE).toBe('');
	});

	it.each([
		{
			name: 'basenames',
			value: [`${storePathHash}-a`, `${'1'.repeat(32)}-b`],
			valid: true
		},
		{ name: 'an empty list', value: [], valid: true },
		{
			name: 'a reference containing a slash',
			value: ['has/slash'],
			valid: false
		}
	])('references: $name', ({ value, valid }) => {
		expect(referencesSchema.safeParse(value).success).toBe(valid);
	});
});
