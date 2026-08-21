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
	type BackfillStatus,
	type SigningKey as PublicSigningKey,
	type SigningKeyEntry
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

// The key an empty object creates for itself. Rotations issue a UUID, so this
// fixed id marks the key a tenant started with.
export const bootstrapKeyId = signingKeyIdSchema.parse('active');

// The stored public key is the only record of the name its signatures carry, so
// a row that does not render as `<name>:<base64>` fails here rather than
// producing a name that no client trusts. The id is the handle the key contract
// uses to retire a key, so it is held to the same form the contract accepts.
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

// A stable order keeps the rendered `/pubkey` body and the narinfo `Sig:`
// lines deterministic, so a re-materialised narinfo hashes identically.
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
	backfill?: BackfillStatus
): SigningKeyEntry {
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
