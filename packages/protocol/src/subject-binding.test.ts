import { describe, expect, it } from 'vitest';

import {
	subjectTokenTypeIdToken,
	tokenExchangeGrantRequestSchema,
	tokenExchangeGrantType
} from './oidc.ts';
import {
	readAccessGrantRequestSchema,
	readAccessGrantType
} from './read-access.ts';
import { signupRequestSchema } from './signup.ts';
import { isCanonicalTarget, subjectBindingNonce } from './subject-binding.ts';

const seed = 'A'.repeat(43);
const targets = [
	'https://cupboard.example.workers.dev',
	'https://cupboard.example.workers.dev/t/acme'
];

describe('subjectBindingNonce', () => {
	// The SHA-256 hash of the UTF-8 JSON
	// `["cupboard/subject-binding/v1",[...targets],seed]`, computed outside
	// TypeScript.
	it('hashes the version label, the targets and the seed', async () => {
		expect(await subjectBindingNonce(targets, seed)).toBe(
			'ovfZEc_VlvjHaOtFI9yYEy_iRv7qz6P7GkPLumhObCQ'
		);
	});
});

describe('isCanonicalTarget', () => {
	it.each([
		{ target: 'https://cupboard.example.workers.dev', canonical: true },
		{ target: 'https://cupboard.example.workers.dev/t/acme', canonical: true },
		{ target: 'https://cupboard.example.workers.dev/', canonical: false },
		{
			target: 'https://cupboard.example.workers.dev/t/acme/',
			canonical: false
		},
		{ target: 'https://Cupboard.example.workers.dev', canonical: false },
		{ target: 'https://cupboard.example.workers.dev:443', canonical: false },
		{ target: 'cupboard', canonical: false }
	])('returns $canonical for $target', ({ target, canonical }) => {
		expect(isCanonicalTarget(target)).toBe(canonical);
	});
});

const exchange = {
	grant_type: tokenExchangeGrantType,
	subject_token: 'inbound.jwt.value',
	subject_token_type: subjectTokenTypeIdToken
};
const readAccess = {
	grant_type: readAccessGrantType,
	subject_token: 'inbound.jwt.value',
	subject_token_type: subjectTokenTypeIdToken,
	read_resources: '[]'
};
const signup = { subject_token: 'inbound.jwt.value' };
const binding = {
	cupboard_binding_seed: seed,
	cupboard_binding_targets: JSON.stringify(targets)
};
const parsedBinding = {
	cupboard_binding_seed: seed,
	cupboard_binding_targets: targets
};

describe('binding parameters', () => {
	it.each([
		{
			name: 'token exchange',
			schema: tokenExchangeGrantRequestSchema,
			form: exchange
		},
		{
			name: 'read access',
			schema: readAccessGrantRequestSchema,
			form: readAccess
		},
		{ name: 'signup', schema: signupRequestSchema, form: signup }
	])('parses the seed and targets of a $name request', ({ schema, form }) => {
		expect(schema.parse({ ...form, ...binding })).toStrictEqual({
			...form,
			...parsedBinding
		});
	});

	it.each([
		{
			name: 'a seed of 42 characters',
			field: { cupboard_binding_seed: 'A'.repeat(42) }
		},
		{
			name: 'a seed with padding',
			field: { cupboard_binding_seed: `${'A'.repeat(42)}=` }
		},
		{
			name: 'targets that are not JSON',
			field: {
				cupboard_binding_targets: 'https://cupboard.example.workers.dev'
			}
		},
		{ name: 'an empty target list', field: { cupboard_binding_targets: '[]' } },
		{
			name: 'five targets',
			field: {
				cupboard_binding_targets: JSON.stringify(
					Array.from(
						{ length: 5 },
						(_, index) =>
							`https://cupboard-${String(index)}.example.workers.dev`
					)
				)
			}
		},
		{
			name: 'a target that is not a string',
			field: { cupboard_binding_targets: '[1]' }
		}
	])('refuses $name', ({ field }) => {
		expect(
			tokenExchangeGrantRequestSchema.safeParse({
				...exchange,
				...binding,
				...field
			}).success
		).toBe(false);
	});
});
