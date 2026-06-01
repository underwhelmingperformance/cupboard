import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
	cacheNameSchema,
	cachePrioritySchema,
	compressionSchema,
	DEFAULT_CACHE,
	isAllowedIssuerUrl,
	IssuerUrl,
	nixSha256HashSchema,
	positiveIntSchema,
	referencesSchema,
	rootNameSchema,
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

	it.each([
		{
			name: 'an https issuer',
			value: 'https://issuer.example.com',
			allowed: true
		},
		{
			name: 'an https issuer with a path',
			value: 'https://issuer.example.com/realm',
			allowed: true
		},
		{
			name: 'a plain http issuer',
			value: 'http://issuer.example.com',
			allowed: false
		},
		{
			name: 'http on localhost',
			value: 'http://localhost:8788',
			allowed: true
		},
		{
			name: 'http on 127.0.0.1',
			value: 'http://127.0.0.1:8788',
			allowed: true
		},
		{
			name: 'http on the IPv6 loopback',
			value: 'http://[::1]:8788',
			allowed: true
		},
		{
			name: 'http on a host that merely starts with localhost',
			value: 'http://localhost.evil.com',
			allowed: false
		},
		{ name: 'a non-URL string', value: 'not a url', allowed: false }
	])('isAllowedIssuerUrl: $name', ({ value, allowed }) => {
		expect(isAllowedIssuerUrl(value)).toBe(allowed);
	});
});

describe('IssuerUrl', () => {
	it.each([
		{ name: 'an https issuer', raw: 'https://issuer.example.com' },
		{
			name: 'an https issuer with a trailing slash',
			raw: 'https://issuer.example.com/'
		},
		{ name: 'an http loopback issuer', raw: 'http://127.0.0.1:8788' }
	])('parses, normalises and builds the discovery URL for $name', ({ raw }) => {
		const issuerUrl = IssuerUrl.parse(raw);
		const normalised = raw.replace(/\/$/, '');

		expect({
			value: issuerUrl?.value,
			discoveryUrl: issuerUrl?.discoveryUrl
		}).toStrictEqual({
			value: normalised,
			discoveryUrl: `${normalised}/.well-known/openid-configuration`
		});
	});

	it.each([
		{ name: 'plain http', raw: 'http://issuer.example.com' },
		{ name: 'a non-URL string', raw: 'not a url' },
		{ name: 'an issuer with a query', raw: 'https://issuer.example.com?t=a' },
		{ name: 'an issuer with a fragment', raw: 'https://issuer.example.com#a' },
		{ name: 'an issuer with userinfo', raw: 'https://user@issuer.example.com' }
	])('refuses to parse $name', ({ raw }) => {
		expect(IssuerUrl.parse(raw)).toBeUndefined();
	});

	it('matches another issuer slash-insensitively', () => {
		const issuerUrl = IssuerUrl.parse('https://issuer.example.com/');

		expect({
			exact: issuerUrl?.matches('https://issuer.example.com'),
			slashed: issuerUrl?.matches('https://issuer.example.com/'),
			other: issuerUrl?.matches('https://issuer.evil.com')
		}).toStrictEqual({ exact: true, slashed: true, other: false });
	});
});
