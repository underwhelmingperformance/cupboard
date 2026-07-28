import {
	type SigningKeyStage,
	type SigningKeySummary
} from '@cupboard/protocol/keys';
import { z } from 'zod';

import {
	type NixKeyName,
	nixKeyNameSchema,
	parseJwk
} from '../crypto/crypto.ts';
import * as schema from '../db/schema.ts';

export const storedSignaturesSchema = z.array(z.string());

export interface SigningKey {
	readonly id: string;
	readonly name: NixKeyName;
	readonly privateJwk: JsonWebKey;
	readonly publicKey: string;
	readonly signing: boolean;
	readonly published: boolean;
	readonly createdAt: string;
}

export const bootstrapKeyName = nixKeyNameSchema.parse('cupboard-1');

export function signingKeyFromRow(
	row: typeof schema.signingKeys.$inferSelect
): SigningKey {
	return {
		id: row.id,
		name: nixKeyNameSchema.parse(
			row.publicKey.slice(0, row.publicKey.indexOf(':'))
		),
		privateJwk: parseJwk(row.privateJwkJson),
		publicKey: row.publicKey,
		signing: row.signing,
		published: row.published,
		createdAt: row.createdAt
	};
}

// A stable order keeps the rendered `/pubkey` body and the narinfo `Sig:`
// lines deterministic, so a re-materialised narinfo hashes identically.
export function byPublicKey(left: SigningKey, right: SigningKey): number {
	return left.publicKey > right.publicKey ? 1 : -1;
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
		publicKey: key.publicKey,
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
		const match = keyNamePattern.exec(key.name);

		return match === null ? [] : [Math.trunc(Number(match[1] ?? '0'))];
	});
	const next = indices.length === 0 ? 1 : Math.max(...indices) + 1;

	return nixKeyNameSchema.parse(`cupboard-${String(next)}`);
}
