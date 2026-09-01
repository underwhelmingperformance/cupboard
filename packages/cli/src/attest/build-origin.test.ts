import {
	buildOriginPredicateType,
	type BuildOriginSubject,
	buildOriginSubjectSchema
} from '@cupboard/protocol/build-origin';
import type { VerifyResult } from '@cupboard/shared/sigstore';
import { describe, expect, it } from 'vitest';

import {
	buildOriginStatement,
	BuildOriginStatementInvalidError,
	describeBuildOrigin
} from './build-origin.ts';

const storePath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const otherPath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib';
const derivation = '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-app.drv';
const buildStore = 'ssh-ng://build@example.test';

function localSubject(): BuildOriginSubject {
	return buildOriginSubjectSchema.parse({
		origin: 'built',
		storePath,
		narHash: 'aa'.repeat(32),
		derivation,
		buildStore: 'auto',
		verification: 'local'
	});
}

function delegatedSubject(): BuildOriginSubject {
	return buildOriginSubjectSchema.parse({
		origin: 'built',
		storePath: otherPath,
		narHash: 'bb'.repeat(32),
		derivation,
		buildStore,
		machine: 'ssh://builder-1',
		verification: 'build-store'
	});
}

function reportedSubject(): BuildOriginSubject {
	return buildOriginSubjectSchema.parse({
		origin: 'built',
		storePath: otherPath,
		narHash: 'bb'.repeat(32),
		derivation,
		buildStore,
		verification: 'build-store'
	});
}

function storeHeldSubject(): BuildOriginSubject {
	return buildOriginSubjectSchema.parse({
		origin: 'store-held',
		storePath: otherPath,
		narHash: 'bb'.repeat(32),
		derivation,
		buildStore
	});
}

function copiedSubject(
	overrides: {
		readonly signatures?: readonly string[];
		readonly copiedFrom?: readonly string[];
	} = {}
): BuildOriginSubject {
	return buildOriginSubjectSchema.parse({
		origin: 'copied',
		storePath: otherPath,
		narHash: 'bb'.repeat(32),
		derivation,
		signatures: overrides.signatures ?? ['cache.example.org-1:c2ln'],
		...(overrides.copiedFrom !== undefined && {
			copiedFrom: overrides.copiedFrom
		})
	});
}

function verified(
	overrides: Partial<Pick<VerifyResult, 'predicateType' | 'predicate'>> = {}
): Pick<VerifyResult, 'bundle' | 'predicateType' | 'predicate'> {
	return {
		bundle: 'build-origin.sigstore.json',
		predicateType: buildOriginPredicateType,
		predicate: { subjects: [localSubject()] },
		...overrides
	};
}

describe('buildOriginStatement', () => {
	it('reads every subject of a statement of the build-origin type', () => {
		const statement = buildOriginStatement(
			verified({
				predicate: { subjects: [localSubject(), delegatedSubject()] }
			})
		);

		expect(statement).toStrictEqual({
			subjects: [localSubject(), delegatedSubject()]
		});
	});

	// Another project's predicate may happen to contain a `subjects` array. Only
	// the predicate type selects the build-origin schema, so such a bundle is
	// neither read as a statement nor refused.
	it.each([
		{
			name: 'a predicate of another type shaped like a statement',
			predicateType: 'https://example.test/predicate/v1',
			predicate: { subjects: [localSubject()] }
		},
		{
			name: 'a SLSA provenance predicate',
			predicateType: 'https://slsa.dev/provenance/v1',
			predicate: { buildDefinition: {} }
		},
		{
			name: 'a bundle with no predicate at all',
			predicateType: 'https://example.test/predicate/v1',
			predicate: undefined
		}
	])('returns undefined for $name', ({ predicateType, predicate }) => {
		expect(
			buildOriginStatement(verified({ predicateType, predicate }))
		).toBeUndefined();
	});

	it.each([
		{
			name: 'a subject missing the store it was built in',
			predicate: {
				subjects: [{ ...localSubject(), buildStore: undefined }]
			},
			fields: ['subjects.0.buildStore']
		},
		{
			name: 'a producer the receipt never records',
			predicate: {
				subjects: [{ ...localSubject(), verification: 'substituted' }]
			},
			fields: ['subjects.0.verification']
		},
		{
			name: 'an output path in place of the derivation',
			predicate: { subjects: [{ ...localSubject(), derivation: storePath }] },
			fields: ['subjects.0.derivation']
		},
		{
			name: 'no subject at all',
			predicate: { subjects: [] },
			fields: ['subjects']
		},
		{
			name: 'a predicate that is not an object',
			predicate: 'nope',
			fields: ['']
		}
	])('refuses a statement with $name', ({ predicate, fields }) => {
		let error: unknown;

		try {
			buildOriginStatement(verified({ predicate }));
		} catch (error_: unknown) {
			error = error_;
		}

		expect({
			isStatementError: error instanceof BuildOriginStatementInvalidError,
			bundle:
				error instanceof BuildOriginStatementInvalidError
					? error.bundle
					: undefined,
			fields:
				error instanceof BuildOriginStatementInvalidError
					? error.fields
					: undefined
		}).toStrictEqual({
			isStatementError: true,
			bundle: 'build-origin.sigstore.json',
			fields
		});
	});
});

describe('describeBuildOrigin', () => {
	it.each([
		{
			name: 'a path the coordinating machine built',
			subject: localSubject(),
			expected: 'the coordinating machine built it under supervision'
		},
		{
			name: 'a path a named builder produced',
			subject: delegatedSubject(),
			expected: `ssh://builder-1 built it, and ${buildStore} reported the build`
		},
		{
			name: 'a path reported without an observed builder',
			subject: reportedSubject(),
			expected: `${buildStore} reported that it built the path, but this run did not observe which machine performed the build`
		},
		{
			name: 'a locally built path without an observed build time',
			subject: storeHeldSubject(),
			expected: `${buildStore} reported the path as locally built, but the receipt does not record when it was built`
		},
		{
			name: 'a copied path with an observed source attempt',
			subject: copiedSubject({ copiedFrom: ['https://cache.example.org'] }),
			expected:
				'this run observed copy attempts from https://cache.example.org; the build-store metadata lists unverified Nix signatures for cache.example.org-1'
		},
		{
			name: 'a copied path without an observed source',
			subject: copiedSubject(),
			expected:
				'the build store reported a copied path, but this run did not observe the source; the build-store metadata lists unverified Nix signatures for cache.example.org-1'
		},
		{
			name: 'a path whose narinfo came from another cache',
			subject: buildOriginSubjectSchema.parse({
				origin: 'republished',
				storePath: otherPath,
				narHash: 'bb'.repeat(32),
				derivation,
				signatures: ['cache.example.org-1:c2ln'],
				metadataSource: 'https://cache.example.test/t/acme'
			}),
			expected:
				'this run read its narinfo from https://cache.example.test/t/acme; the narinfo lists unverified Nix signatures for cache.example.org-1'
		},
		{
			name: 'a republished path whose source narinfo has no signatures',
			subject: buildOriginSubjectSchema.parse({
				origin: 'republished',
				storePath: otherPath,
				narHash: 'bb'.repeat(32),
				signatures: [],
				metadataSource: 'https://cache.example.test/t/acme'
			}),
			expected:
				'this run read its narinfo from https://cache.example.test/t/acme; the narinfo lists no Nix signatures'
		},
		{
			name: 'a copied path whose build-store metadata has no signatures',
			subject: copiedSubject({ signatures: [] }),
			expected:
				'the build store reported a copied path, but this run did not observe the source; the build-store metadata lists no Nix signatures'
		}
	])('describes $name', ({ subject, expected }) => {
		expect(describeBuildOrigin(subject)).toBe(expected);
	});
});
