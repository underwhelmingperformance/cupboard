import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import {
	AnonymousAccessDeniedError,
	CredentialCacheMismatchError,
	CredentialCannotWriteError
} from '@cupboard/s3/errors';
import type { S3Principal } from '@cupboard/s3/ports';
import { describe, expect, it } from 'vitest';

import { authorise, collectEntries } from './nix-cache-backend.ts';

const builds = cacheNameSchema.parse('builds');

function principal(overrides: Partial<S3Principal>): S3Principal {
	return { tenant: 'acme', cache: '', grants: [], ...overrides };
}

const byKey = (left: string, right: string): number =>
	left < right ? -1 : left > right ? 1 : 0;

describe('authorise', () => {
	it('allows an anonymous read (the front worker gates private tenants)', async () => {
		await expect(authorise('', undefined, false)).resolves.toBeUndefined();
	});

	it('rejects an anonymous write', async () => {
		await expect(authorise('', undefined, true)).rejects.toThrow(
			AnonymousAccessDeniedError
		);
	});

	it('rejects a credential scoped to a different cache', async () => {
		await expect(
			authorise(builds, principal({ cache: '' }), false)
		).rejects.toThrow(CredentialCacheMismatchError);
	});

	it('rejects a write without the upload grant', async () => {
		await expect(
			authorise('', principal({ cache: '', grants: [] }), true)
		).rejects.toThrow(CredentialCannotWriteError);
	});

	it('allows a read for the scoped cache', async () => {
		await expect(
			authorise(builds, principal({ cache: builds }), false)
		).resolves.toBeUndefined();
	});

	it('allows a write with the upload grant', async () => {
		await expect(
			authorise(
				builds,
				principal({ cache: builds, grants: ['upload:commit'] }),
				true
			)
		).resolves.toBeUndefined();
	});
});

describe('collectEntries', () => {
	const keys = [
		'nix-cache-info',
		'aaaa.narinfo',
		'nar/n1.nar.zst',
		'nar/n2.nar.zst'
	];

	it('lists every prefix-matching key when no delimiter is given', () => {
		const entries = collectEntries(keys, '', undefined);
		expect(entries.map((entry) => entry.key).toSorted(byKey)).toStrictEqual([
			'aaaa.narinfo',
			'nar/n1.nar.zst',
			'nar/n2.nar.zst',
			'nix-cache-info'
		]);
		expect(entries.every((entry) => !entry.isPrefix)).toBe(true);
	});

	it('groups NAR keys under a common prefix when a delimiter is present', () => {
		const entries = collectEntries(keys, '', '/');
		const objects = entries.filter((entry) => !entry.isPrefix);
		const prefixes = entries.filter((entry) => entry.isPrefix);
		expect(objects.map((entry) => entry.key).toSorted(byKey)).toStrictEqual([
			'aaaa.narinfo',
			'nix-cache-info'
		]);
		expect(prefixes.map((entry) => entry.key)).toStrictEqual(['nar/']);
	});

	it('restricts the listing to keys under the prefix', () => {
		const entries = collectEntries(keys, 'nar/', undefined);
		expect(entries.map((entry) => entry.key).toSorted(byKey)).toStrictEqual([
			'nar/n1.nar.zst',
			'nar/n2.nar.zst'
		]);
	});
});
