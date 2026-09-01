import { NixPublicKey } from '@cupboard/nix-store/public-key';
import {
	type NixKeyName,
	nixKeyNameSchema,
	type SigningKeyGeneration,
	type SigningKeyId,
	signingKeyIdSchema
} from '@cupboard/nix-store/scalars';
import type { InstanceName } from '@cupboard/protocol/instance';
import {
	type BackfillStatusInput,
	type SigningKeyEntryInput,
	type SigningKeyInput as PublicSigningKey
} from '@cupboard/protocol/keys';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { z } from 'zod';

import { parseJwk } from '../crypto/crypto.ts';
import * as schema from '../db/schema.ts';

export const storedSignaturesSchema = z.array(z.string());

export interface SigningKey {
	readonly id: SigningKeyId;
	readonly privateJwk: JsonWebKey;
	readonly publicKey: NixPublicKey;
	readonly signing: boolean;
	readonly published: boolean;
	readonly generation: SigningKeyGeneration;
	readonly createdAt: IsoTimestamp;
}

// An empty tenant key store creates generation 1 with this contract-defined
// identifier. Later rotations use UUIDs, while retirement continues to address
// the bootstrap key as `active`.
export const bootstrapKeyId = signingKeyIdSchema.parse('active');

// Parse persisted key material at the storage boundary. The rendered public key
// contains the Nix name used for signatures, so malformed material must fail
// before the key is published or used for signing. Parse the identifier through
// the retirement API's schema so every loaded key remains addressable.
export function signingKeyFromRow(
	row: typeof schema.signingKeys.$inferSelect
): SigningKey {
	return {
		id: signingKeyIdSchema.parse(row.id),
		privateJwk: parseJwk(row.privateJwkJson),
		publicKey: new NixPublicKey(row.publicKey),
		signing: row.signing,
		published: row.published,
		generation: row.generation,
		createdAt: row.createdAt
	};
}

// Sort by the rendered public-key value before serving or signing. This keeps
// `/pubkey` lines and narinfo `Sig:` lines deterministic, so rematerialising a
// narinfo produces the same body.
export function byPublicKey(left: SigningKey, right: SigningKey): number {
	return left.publicKey.value > right.publicKey.value ? 1 : -1;
}

export function publicSigningKey(key: SigningKey): PublicSigningKey {
	return {
		id: key.id,
		publicKey: key.publicKey.value,
		createdAt: key.createdAt
	};
}

export function keyEntry(
	key: SigningKey,
	backfill?: BackfillStatusInput
): SigningKeyEntryInput {
	const publicKey = publicSigningKey(key);

	if (key.signing) {
		return {
			state: 'signing',
			key: publicKey,
			...(backfill !== undefined && { backfill })
		};
	}

	return { state: 'published-only', key: publicKey };
}

export function signingKeyName(
	instance: InstanceName,
	tenant: string,
	generation: SigningKeyGeneration
): NixKeyName {
	const encodedInstance = instance.replaceAll('-', '--');
	const encodedTenant = tenant.replaceAll('-', '--');

	return nixKeyNameSchema.parse(
		`${encodedInstance}-${encodedTenant}-${String(generation)}`
	);
}
