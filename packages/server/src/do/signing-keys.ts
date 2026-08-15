import { NixPublicKey } from '@cupboard/nix-store/public-key';
import {
	type NixKeyName,
	nixKeyNameSchema,
	type SigningKeyId,
	signingKeyIdSchema
} from '@cupboard/nix-store/scalars';
import {
	type SigningKeyStage,
	type SigningKeySummary
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
	readonly createdAt: IsoTimestamp;
}

export const bootstrapKeyName = nixKeyNameSchema.parse('cupboard-1');

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
		createdAt: row.createdAt
	};
}

// A stable order keeps the rendered `/pubkey` body and the narinfo `Sig:`
// lines deterministic, so a re-materialised narinfo hashes identically.
export function byPublicKey(left: SigningKey, right: SigningKey): number {
	return left.publicKey.value > right.publicKey.value ? 1 : -1;
}

function keyStage(key: SigningKey): SigningKeyStage {
	if (key.signing) {
		return 'signing';
	}

	return key.published ? 'publication' : 'absent';
}

export function keySummary(key: SigningKey): SigningKeySummary {
	return {
		id: key.id,
		publicKey: key.publicKey.value,
		stage: keyStage(key),
		createdAt: key.createdAt
	};
}

const keyNamePattern = /^cupboard-(\d+)$/;

// Each key needs a distinct Nix key name so old and new keys can coexist in a
// client's trusted set during a rotation. Names follow `cupboard-<n>`; the next
// rotation takes the highest existing index plus one.
export function nextKeyName(keys: readonly SigningKey[]): NixKeyName {
	const indices = keys.flatMap((key) => {
		const match = keyNamePattern.exec(key.publicKey.name);

		return match === null ? [] : [Math.trunc(Number(match[1] ?? '0'))];
	});
	const next = indices.length === 0 ? 1 : Math.max(...indices) + 1;

	return nixKeyNameSchema.parse(`cupboard-${String(next)}`);
}
