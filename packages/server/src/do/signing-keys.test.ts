import { InvalidNixPublicKeyError } from '@cupboard/nix-store/errors';
import { NixPublicKey } from '@cupboard/nix-store/public-key';
import {
	signingKeyGenerationSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { instanceNameSchema } from '@cupboard/protocol/instance';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import * as schema from '../db/schema.ts';

import { signingKeyFromRow, signingKeyName } from './signing-keys.ts';

const createdAt = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));

function storedRow(
	publicKey: string,
	id = 'active'
): typeof schema.signingKeys.$inferSelect {
	return {
		id,
		privateJwkJson: JSON.stringify({ kty: 'OKP' }),
		publicKey,
		signing: true,
		published: true,
		generation: signingKeyGenerationSchema.parse(1),
		createdAt
	};
}

describe('signingKeyFromRow', () => {
	it('reads the key name from the stored public key', () => {
		expect(signingKeyFromRow(storedRow('cupboard-1:cHVi'))).toStrictEqual({
			id: 'active',
			privateJwk: { kty: 'OKP' },
			publicKey: new NixPublicKey('cupboard-1:cHVi'),
			signing: true,
			published: true,
			generation: signingKeyGenerationSchema.parse(1),
			createdAt
		});
	});

	it.each([
		{ name: 'no separator', publicKey: 'cupboard-1' },
		{ name: 'an empty name', publicKey: ':cHVi' },
		{ name: 'empty material', publicKey: 'cupboard-1:' }
	])('rejects a stored public key with $name', ({ publicKey }) => {
		expect(() => signingKeyFromRow(storedRow(publicKey))).toThrow(
			InvalidNixPublicKeyError
		);
	});

	it.each([
		{ name: 'an unknown fixed id', id: 'primary' },
		{ name: 'a truncated uuid', id: '123e4567-e89b-12d3-a456' }
	])('rejects a stored key identifier with $name', ({ id }) => {
		expect(() => signingKeyFromRow(storedRow('cupboard-1:cHVi', id))).toThrow(
			ZodError
		);
	});
});

describe('signingKeyName', () => {
	it('formats the instance, tenant, and generation as a Nix key name', () => {
		expect(
			signingKeyName(
				instanceNameSchema.parse('forge'),
				tenantIdSchema.parse('acme'),
				signingKeyGenerationSchema.parse(17)
			)
		).toBe('forge-acme-17');
	});

	it('escapes component separators so different splits cannot collide', () => {
		expect([
			signingKeyName(
				instanceNameSchema.parse('acme-prod'),
				tenantIdSchema.parse('cache'),
				signingKeyGenerationSchema.parse(1)
			),
			signingKeyName(
				instanceNameSchema.parse('acme'),
				tenantIdSchema.parse('prod-cache'),
				signingKeyGenerationSchema.parse(1)
			)
		]).toStrictEqual(['acme--prod-cache-1', 'acme-prod--cache-1']);
	});
});
