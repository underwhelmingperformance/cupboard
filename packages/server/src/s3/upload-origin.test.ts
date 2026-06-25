import type { UploadOrigin } from '@cupboard/protocol/paths';
import type { S3Principal } from '@cupboard/s3/ports';
import { describe, expect, it } from 'vitest';

import { parseUploadOrigin, renderUploadOrigin } from './upload-origin.ts';

const principal = (overrides: Partial<S3Principal>): S3Principal => ({
	tenant: 'acme',
	cache: '',
	grants: ['upload:commit'],
	...overrides
});

describe('renderUploadOrigin', () => {
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
		expect(renderUploadOrigin(input)).toBe(expected);
	});
});

describe('parseUploadOrigin', () => {
	it('round-trips a rendered origin', () => {
		const origin: UploadOrigin = { credentialId: 'cred-1', label: 'nixbuild' };

		expect(parseUploadOrigin(JSON.stringify(origin))).toStrictEqual(origin);
	});

	it.each([
		{ name: 'undefined', value: undefined },
		{ name: 'malformed json', value: '{not json' },
		{ name: 'the wrong shape', value: JSON.stringify({ credentialId: 1 }) }
	])('returns undefined for $name', ({ value }) => {
		expect(parseUploadOrigin(value)).toBeUndefined();
	});
});
