import { bytesToBase64Url } from '@cupboard/nix-store/encoding';
import { type TenantId } from '@cupboard/nix-store/scalars';
import { type OidcSubject } from '@cupboard/protocol/oidc';
import { type VerifiedOidcClaims } from '@cupboard/protocol/oidc-trust-match';

import { type PushIdSigningKey } from '../blob/push-id.ts';

import { oidcPolicyIdentity, recordedOidcIdentity } from './oidc-identity.ts';
import {
	base64UrlToBytes,
	decryptOrUndefined,
	deriveSealingKey
} from './sealing.ts';

/**
The secret and tenant that seal the identity in a tenant's access tokens.
Changing `PUSH_ID_SIGNING_KEY` makes the identity in every earlier token
unreadable.
*/
export interface AccessIdentityKeyContext {
	readonly signingKey: PushIdSigningKey;
	readonly tenant: TenantId;
}

/**
The longest sealed identity that a token can contain. A refresh credential
limits its identity to 64 KiB, and base64url encoding adds a third.
*/
export const sealedAccessIdentityMaxLength = 96 * 1024;

const sealedPattern =
	/^(?<salt>[\w-]{22})\.(?<iv>[\w-]{16})\.(?<ciphertext>[\w-]{22,})$/u;

/**
The verified OIDC identity that a tenant access token was issued for,
encrypted with AES-GCM so a holder of the token cannot read it. HKDF derives
the key from `PUSH_ID_SIGNING_KEY` with a random salt for each token and an
`info` label of its own that includes the tenant. The token's subject is the
additional authenticated data, so the sealed value opens only in a token
with the same subject. Attenuation copies the sealed value without opening
it.
*/
export class SealedAccessIdentity {
	static async seal(
		identity: VerifiedOidcClaims,
		subject: OidcSubject,
		context: AccessIdentityKeyContext
	): Promise<SealedAccessIdentity> {
		const salt = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const key = await identityKey(context, salt);
		const plaintext = JSON.stringify(oidcPolicyIdentity(identity));
		const ciphertext = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv, additionalData: subjectBinding(subject) },
			key,
			new TextEncoder().encode(plaintext)
		);
		const value = `${salt}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;

		return new SealedAccessIdentity(value, subject);
	}

	/**
	Reads a sealed identity from a token without opening it. Returns
	undefined for a value that is not a well-formed sealed identity.
	*/
	static parse(
		value: unknown,
		subject: OidcSubject
	): SealedAccessIdentity | undefined {
		if (
			typeof value !== 'string' ||
			value.length > sealedAccessIdentityMaxLength ||
			!sealedPattern.test(value)
		) {
			return undefined;
		}

		return new SealedAccessIdentity(value, subject);
	}

	private constructor(
		readonly value: string,
		private readonly subject: OidcSubject
	) {}

	/**
	Decrypts the identity. Returns undefined when the key context, the
	subject or the ciphertext does not match.
	*/
	async open(
		context: AccessIdentityKeyContext
	): Promise<VerifiedOidcClaims | undefined> {
		const { salt, iv, ciphertext } =
			sealedPattern.exec(this.value)?.groups ?? {};
		const ivBytes = iv === undefined ? undefined : base64UrlToBytes(iv);
		const ciphertextBytes =
			ciphertext === undefined ? undefined : base64UrlToBytes(ciphertext);

		if (
			salt === undefined ||
			ivBytes === undefined ||
			ciphertextBytes === undefined
		) {
			return undefined;
		}

		const plaintext = await decryptOrUndefined(
			await identityKey(context, salt),
			ivBytes,
			ciphertextBytes,
			subjectBinding(this.subject)
		);

		if (plaintext === undefined) {
			return undefined;
		}

		try {
			return recordedOidcIdentity(
				JSON.parse(new TextDecoder().decode(plaintext))
			);
		} catch {
			return undefined;
		}
	}
}

function identityKey(
	context: AccessIdentityKeyContext,
	salt: string
): Promise<CryptoKey> {
	return deriveSealingKey(context.signingKey, salt, [
		'cupboard/access-identity/v1',
		context.tenant
	]);
}

function subjectBinding(subject: OidcSubject): Uint8Array {
	return new TextEncoder().encode(subject);
}
