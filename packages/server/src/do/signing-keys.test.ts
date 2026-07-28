import { InvalidNixPublicKeyError } from '@cupboard/nix-store/errors';
import { NixPublicKey } from '@cupboard/nix-store/public-key';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import * as schema from '../db/schema.ts';

import { signingKeyFromRow } from './signing-keys.ts';

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
		createdAt
	};
}

describe('signingKeyFromRow', () => {
	it('carries the stored public key with the name it renders', () => {
		expect(signingKeyFromRow(storedRow('cupboard-1:cHVi'))).toStrictEqual({
			id: 'active',
			privateJwk: { kty: 'OKP' },
			publicKey: new NixPublicKey('cupboard-1:cHVi'),
			signing: true,
			published: true,
			createdAt
		});
	});

	// A stored key with no separator names no signer, so the read fails here
	// rather than handing back a name clients have no reason to trust.
	it.each([
		{ name: 'no separator', publicKey: 'cupboard-1' },
		{ name: 'an empty name', publicKey: ':cHVi' },
		{ name: 'empty material', publicKey: 'cupboard-1:' }
	])('refuses a stored key with $name', ({ publicKey }) => {
		expect(() => signingKeyFromRow(storedRow(publicKey))).toThrow(
			InvalidNixPublicKeyError
		);
	});

	// An id the key contract cannot address is a key no operator could retire.
	it.each([
		{ name: 'an unknown fixed id', id: 'primary' },
		{ name: 'a truncated uuid', id: '123e4567-e89b-12d3-a456' }
	])('refuses a stored key with $name', ({ id }) => {
		expect(() => signingKeyFromRow(storedRow('cupboard-1:cHVi', id))).toThrow(
			ZodError
		);
	});
});
