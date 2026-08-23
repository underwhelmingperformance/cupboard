import { describe, expect, it } from 'vitest';

import {
	type BuildOriginPredicate,
	buildOriginPredicateSchema,
	buildOriginSubjectSchema
} from './build-origin.ts';

const storePath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const otherPath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib';
const derivation = '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-app.drv';
const narHash = 'aa'.repeat(32);

function localSubject(): BuildOriginPredicate['subjects'][number] {
	return {
		origin: 'built',
		storePath,
		narHash,
		derivation,
		buildStore: 'auto',
		verification: 'local'
	};
}

describe('buildOriginPredicateSchema', () => {
	it('accepts a statement containing the accepted receipt subjects', () => {
		const predicate: BuildOriginPredicate = {
			subjects: [
				localSubject(),
				{
					origin: 'built',
					storePath: otherPath,
					narHash: 'bb'.repeat(32),
					derivation,
					buildStore: 'ssh-ng://build@example.test',
					machine: 'ssh://builder-1',
					verification: 'build-store'
				}
			]
		};

		expect(buildOriginPredicateSchema.parse(predicate)).toStrictEqual(
			predicate
		);
	});

	it.each([
		{ name: 'an empty subject list', value: { subjects: [] } },
		{
			name: 'a subject list that is not an array',
			value: { subjects: localSubject() }
		},
		{
			name: 'an unknown statement field',
			value: { subjects: [localSubject()], attempt: 1 }
		}
	])('rejects $name', ({ value }) => {
		expect(buildOriginPredicateSchema.safeParse(value).success).toBe(false);
	});
});

describe('buildOriginSubjectSchema', () => {
	it('accepts a subject with a recorded builder', () => {
		const subject = {
			origin: 'built' as const,
			storePath,
			narHash,
			derivation,
			buildStore: 'ssh-ng://build@example.test',
			machine: 'ssh://builder-1',
			verification: 'build-store' as const
		};

		expect(buildOriginSubjectSchema.parse(subject)).toStrictEqual(subject);
	});

	it.each([
		{
			name: 'a store-held path',
			subject: {
				origin: 'store-held' as const,
				storePath,
				narHash,
				derivation,
				buildStore: 'auto'
			}
		},
		{
			name: 'a copied path with an observed source',
			subject: {
				origin: 'copied' as const,
				storePath,
				narHash,
				derivation,
				signatures: ['cache.nixos.org-1:c2ln'],
				copiedFrom: ['https://cache.nixos.org']
			}
		},
		{
			name: 'a path republished from another cache',
			subject: {
				origin: 'republished' as const,
				storePath,
				narHash,
				derivation,
				signatures: ['cache.example.org-1:c2ln'],
				metadataSource: 'https://cache.example.test/t/acme'
			}
		},
		{
			name: 'a copied path without signatures or an observed source',
			subject: {
				origin: 'copied' as const,
				storePath,
				narHash,
				signatures: []
			}
		}
	])('accepts $name', ({ subject }) => {
		expect(buildOriginSubjectSchema.parse(subject)).toStrictEqual(subject);
	});

	it.each([
		{
			name: 'an output path in place of the derivation',
			value: { ...localSubject(), derivation: storePath }
		},
		{
			name: 'a NAR hash that is not a sha256 digest',
			value: { ...localSubject(), narHash: 'sha256:not-hex' }
		},
		{
			name: 'an unsupported verification method',
			value: { ...localSubject(), verification: 'substituted' }
		},
		{
			name: 'an unsupported origin',
			value: { ...localSubject(), origin: 'substituted' }
		},
		{
			name: 'a built subject with no origin',
			value: {
				storePath,
				narHash,
				derivation,
				buildStore: 'auto',
				verification: 'local'
			}
		},
		{
			name: 'a store-held subject with signatures',
			value: {
				origin: 'store-held',
				storePath,
				narHash,
				buildStore: 'auto',
				signatures: []
			}
		},
		{
			name: 'an empty build store',
			value: { ...localSubject(), buildStore: '' }
		},
		{
			name: 'an empty builder name',
			value: { ...localSubject(), machine: '' }
		},
		{
			name: 'attempt fields on a receipt subject',
			value: { ...localSubject(), attempt: 1, attemptId: 'attempt-1' }
		}
	])('rejects $name', ({ value }) => {
		expect(buildOriginSubjectSchema.safeParse(value).success).toBe(false);
	});
});
