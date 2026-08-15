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
		storePath,
		narHash,
		derivation,
		buildStore: 'auto',
		verification: 'local'
	};
}

describe('buildOriginPredicateSchema', () => {
	it('round-trips a statement covering every subject of a run', () => {
		const predicate: BuildOriginPredicate = {
			subjects: [
				localSubject(),
				{
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
		{ name: 'no subject at all', value: { subjects: [] } },
		{
			name: 'a subject list that is not an array',
			value: { subjects: localSubject() }
		},
		{
			name: 'a field the statement does not define',
			value: { subjects: [localSubject()], attempt: 1 }
		}
	])('rejects $name', ({ value }) => {
		expect(buildOriginPredicateSchema.safeParse(value).success).toBe(false);
	});
});

describe('buildOriginSubjectSchema', () => {
	it('round-trips a subject with a recorded builder', () => {
		const subject = {
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
			name: 'an output path in place of the derivation',
			value: { ...localSubject(), derivation: storePath }
		},
		{
			name: 'a NAR hash that is not a sha256 digest',
			value: { ...localSubject(), narHash: 'sha256:not-hex' }
		},
		{
			name: 'a producer the receipt never records',
			value: { ...localSubject(), verification: 'substituted' }
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
			name: 'the attempt fields a receipt subject carries',
			value: { ...localSubject(), attempt: 1, attemptId: 'attempt-1' }
		}
	])('rejects $name', ({ value }) => {
		expect(buildOriginSubjectSchema.safeParse(value).success).toBe(false);
	});
});
