import {
	buildOriginPredicateType,
	buildOriginSubjectSchema,
	type ParsedBuildOriginSubject
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

function localSubject(): ParsedBuildOriginSubject {
	return buildOriginSubjectSchema.parse({
		storePath,
		narHash: 'aa'.repeat(32),
		derivation,
		buildStore: 'auto',
		verification: 'local'
	});
}

function delegatedSubject(): ParsedBuildOriginSubject {
	return buildOriginSubjectSchema.parse({
		storePath: otherPath,
		narHash: 'bb'.repeat(32),
		derivation,
		buildStore,
		machine: 'ssh://builder-1',
		verification: 'build-store'
	});
}

// The build store reported the path and the activity log recorded no builder.
function reportedSubject(): ParsedBuildOriginSubject {
	return buildOriginSubjectSchema.parse({
		storePath: otherPath,
		narHash: 'bb'.repeat(32),
		derivation,
		buildStore,
		verification: 'build-store'
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

	// Another project's predicate may happen to carry a `subjects` array. Only
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
			name: 'a bundle carrying no predicate at all',
			predicateType: 'https://example.test/predicate/v1',
			predicate: undefined
		}
	])('reports no statement for $name', ({ predicateType, predicate }) => {
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
			name: 'a path the build store reported without a builder',
			subject: reportedSubject(),
			expected: `${buildStore} reports it as its own work, and this run did not watch the build`
		}
	])('describes $name', ({ subject, expected }) => {
		expect(describeBuildOrigin(subject)).toBe(expected);
	});
});
