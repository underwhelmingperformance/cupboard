import { authKeyIdSchema } from '@cupboard/nix-store/scalars';
import { asc, gt } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';

import { isConstantTimeEqual, parseJwk, sha256Hex } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	ControlDatabaseInvalidError,
	UnauthenticatedError
} from '../errors.ts';

import { unwrapControlPrivateJwk } from './control-key.ts';

const privateMembers = ['d', 'k', 'dp', 'dq', 'p', 'q', 'qi', 'oth'] as const;
const keyPageSize = 100;
const keyChallenge = new TextEncoder().encode(
	'cupboard/control-database-key-validation/v1'
);

/**
Verifies the temporary secret that an authorised deploy installs.
*/
export async function enforceControlDatabaseValidationSecret(
	env: { readonly CONTROL_DATABASE_VALIDATION_SECRET: string | undefined },
	secret: string
): Promise<void> {
	const expected = env.CONTROL_DATABASE_VALIDATION_SECRET ?? '';
	const [presentedHash, expectedHash] = await Promise.all([
		sha256Hex(secret),
		sha256Hex(expected)
	]);
	const isMatch = await isConstantTimeEqual(presentedHash, expectedHash, 64);

	if (expected === '' || !isMatch) {
		throw new UnauthenticatedError();
	}
}

function isEd25519(jwk: JsonWebKey): boolean {
	return (
		jwk.kty === 'OKP' &&
		jwk.crv === 'Ed25519' &&
		(jwk.alg === undefined || jwk.alg === 'EdDSA')
	);
}

async function validateKey(
	row: typeof d1Schema.controlAuthKey.$inferSelect,
	wrappingSecret: string
): Promise<void> {
	try {
		authKeyIdSchema.parse(row.kid);
		const publicJwk = parseJwk(row.publicJwkJson);
		const privateJwk = await unwrapControlPrivateJwk(
			wrappingSecret,
			row.wrappedPrivateJwk
		);

		if (
			!isEd25519(publicJwk) ||
			!isEd25519(privateJwk) ||
			privateMembers.some((member) => Object.hasOwn(publicJwk, member))
		) {
			throw new Error('unsupported key material');
		}

		const signingKey = await crypto.subtle.importKey(
			'jwk',
			privateJwk,
			'Ed25519',
			false,
			['sign']
		);
		const verificationKey = await crypto.subtle.importKey(
			'jwk',
			publicJwk,
			'Ed25519',
			false,
			['verify']
		);
		const signature = await crypto.subtle.sign(
			'Ed25519',
			signingKey,
			keyChallenge
		);

		if (
			!(await crypto.subtle.verify(
				'Ed25519',
				verificationKey,
				signature,
				keyChallenge
			))
		) {
			throw new Error('key halves do not match');
		}
	} catch {
		throw new ControlDatabaseInvalidError(
			`signing key '${row.id}' has invalid or mismatched key material`
		);
	}
}

/**
Checks every copied key without returning decrypted key material.
*/
export async function validateControlDatabase(
	env: Pick<Env, 'CONTROL_DB' | 'CONTROL_KEY_WRAP_SECRET'>
): Promise<{ valid: true }> {
	const session = env.CONTROL_DB.withSession('first-primary');
	const client = new Proxy(env.CONTROL_DB, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return session.prepare.bind(session);
			}

			if (property === 'batch') {
				return session.batch.bind(session);
			}

			const value: unknown = Reflect.get(target, property, receiver);
			return value;
		}
	});
	const database = drizzleD1(client, { schema: d1Schema });
	const kids = new Set<string>();
	let after: string | undefined;
	let rows: (typeof d1Schema.controlAuthKey.$inferSelect)[];

	do {
		rows = await database
			.select()
			.from(d1Schema.controlAuthKey)
			.where(
				after === undefined ? undefined : gt(d1Schema.controlAuthKey.id, after)
			)
			.orderBy(asc(d1Schema.controlAuthKey.id))
			.limit(keyPageSize);

		for (const row of rows) {
			if (kids.has(row.kid)) {
				throw new ControlDatabaseInvalidError(
					`signing key '${row.id}' repeats a key ID`
				);
			}

			kids.add(row.kid);
			await validateKey(row, env.CONTROL_KEY_WRAP_SECRET);
			after = row.id;
		}
	} while (rows.length === keyPageSize);

	return { valid: true };
}
