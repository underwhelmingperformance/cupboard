import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import type { S3Committer } from '@cupboard/protocol/paths';
import type { S3Principal } from '@cupboard/s3/ports';
import { describe, expect, it } from 'vitest';

import { StoredUploadOriginInvalidError } from '../errors.ts';

import { parseStoredS3Committer, renderS3Committer } from './upload-origin.ts';

const storePathHash = storePathHashSchema.parse('0'.repeat(32));

const principal = (overrides: Partial<S3Principal>): S3Principal => ({
	tenant: 'acme',
	cache: '',
	grants: ['upload:commit'],
	...overrides
});

function captureInvalidOrigin(value: string): StoredUploadOriginInvalidError {
	try {
		parseStoredS3Committer(storePathHash, value);
	} catch (error) {
		if (error instanceof StoredUploadOriginInvalidError) {
			return error;
		}

		throw error;
	}

	throw new Error('Expected the stored origin to be rejected');
}

describe('renderS3Committer', () => {
	it.each([
		{
			name: 'records the credential id and label',
			principal: principal({ credentialId: 'cred-1', label: 'nixbuild' }),
			expected: JSON.stringify({ credentialId: 'cred-1', label: 'nixbuild' })
		},
		{
			name: 'defaults a missing label to empty',
			principal: principal({ credentialId: 'cred-1' }),
			expected: JSON.stringify({ credentialId: 'cred-1', label: '' })
		},
		{
			name: 'is undefined without a credential identity',
			principal: principal({}),
			expected: undefined
		},
		{
			name: 'is undefined for an anonymous request',
			principal: undefined,
			expected: undefined
		}
	])('$name', ({ principal: input, expected }) => {
		expect(renderS3Committer(input)).toBe(expected);
	});
});

describe('parseStoredS3Committer', () => {
	it('round-trips a rendered origin', () => {
		const origin: S3Committer = {
			credentialId: 'cred-1',
			label: 'nixbuild'
		};

		expect(
			parseStoredS3Committer(storePathHash, JSON.stringify(origin))
		).toStrictEqual(origin);
	});

	it.each([
		{ name: 'malformed JSON', value: '{not json', causeName: 'SyntaxError' },
		{
			name: 'a schema mismatch',
			value: JSON.stringify({ credentialId: 1 }),
			causeName: 'ZodError'
		}
	])('throws a typed storage error for $name', ({ value, causeName }) => {
		const error = captureInvalidOrigin(value);

		expect({
			name: error.name,
			message: error.message,
			status: error.status,
			storePathHash: error.storePathHash,
			causeName: error.cause.name
		}).toStrictEqual({
			name: 'StoredUploadOriginInvalidError',
			message: 'Stored upload origin is invalid',
			status: 500,
			storePathHash,
			causeName
		});
	});
});
