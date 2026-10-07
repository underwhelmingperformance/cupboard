import {
	base64ToBytes,
	bytesToBase64Url,
	bytesToHex,
	hexToBytes
} from '@cupboard/nix-store/encoding';
import { type TenantId, tenantIdSchema } from '@cupboard/nix-store/scalars';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import { type VerifiedOidcClaims } from '@cupboard/protocol/oidc-trust-match';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { z } from 'zod';

import { type PushIdSigningKey } from '../blob/push-id.ts';
import { isConstantTimeEqual, sha256Hex } from '../crypto/crypto.ts';
import { RefreshCredentialSizeLimitError } from '../errors.ts';

export const refreshCredentialMaxBytes = 64 * 1024;

const audienceValueSchema = z.string().min(1);
const audienceSchema = z.union([
	audienceValueSchema,
	z.array(audienceValueSchema).min(1)
]);

const identityClaimSchema = z.union([z.string(), z.array(z.string())]);

const identitySchema = z
	.looseObject({
		iss: z.string().min(1),
		sub: z.string().min(1),
		aud: audienceSchema
	})
	.catchall(identityClaimSchema)
	.refine((identity) => {
		const entries = Object.entries(identity);
		return entries.every(
			([key, value]) => key === 'aud' || typeof value === 'string'
		);
	});

const authoritySchema = z.strictObject({
	purpose: z.literal('cupboard-refresh'),
	version: z.union([z.literal(1), z.literal(2)]),
	tenant: tenantIdSchema,
	familyId: z.uuid(),
	memberId: z.uuid(),
	generation: z.number().int().nonnegative(),
	expiresAt: z.iso.datetime().pipe(isoTimestampSchema),
	identity: identitySchema,
	grants: authorizationDetailsSchema.min(1)
});

export type RefreshAuthority = z.output<typeof authoritySchema>;
type RefreshCredentialVersion = RefreshAuthority['version'];

const credentialPattern =
	/^(?<id>[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.(?<secret>[\da-f]{64})\.(?<authority>[\w-]+(?:\.[\w-]+)?)$/u;

export type AuthenticatedRefreshAuthority = Omit<
	RefreshAuthority,
	'identity'
> & {
	readonly identity: VerifiedOidcClaims;
};

export interface RefreshKeyContext {
	readonly signingKey: PushIdSigningKey;
	readonly tenant: TenantId;
}

/**
 * A bounded opaque credential whose complete value is authenticated by member
 * state. Version 2 seals the authority with AES-GCM, so a client cannot read
 * the identity or the grants. Version 1 contains the authority as readable
 * JSON. The server still accepts version 1 but issues only version 2.
 */
export class RefreshCredential {
	static async issue(
		authority: Omit<RefreshAuthority, 'version'>,
		context: RefreshKeyContext
	): Promise<RefreshCredential> {
		const validated = authoritySchema.parse({ ...authority, version: 2 });
		const json = JSON.stringify(validated);

		if (json.length > refreshCredentialMaxBytes) {
			throw new RefreshCredentialSizeLimitError();
		}

		const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const key = await refreshAuthorityKey(context, validated.memberId, secret);
		const ciphertext = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv },
			key,
			new TextEncoder().encode(json)
		);
		const sealed = `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
		const value = `${validated.memberId}.${secret}.${sealed}`;

		if (value.length > refreshCredentialMaxBytes) {
			throw new RefreshCredentialSizeLimitError();
		}

		return new RefreshCredential(value, validated.memberId, secret, 2, sealed);
	}

	static parse(value: string): RefreshCredential | undefined {
		if (value.length > refreshCredentialMaxBytes) {
			return undefined;
		}

		const match = credentialPattern.exec(value);
		const { id, secret, authority } = match?.groups ?? {};

		if (id === undefined || secret === undefined || authority === undefined) {
			return undefined;
		}

		const version = authority.includes('.') ? 2 : 1;

		return new RefreshCredential(value, id, secret, version, authority);
	}

	private constructor(
		readonly value: string,
		readonly id: string,
		readonly secret: string,
		private readonly version: RefreshCredentialVersion,
		private readonly encodedAuthority: string
	) {}

	private async authorityBytes(
		context: RefreshKeyContext
	): Promise<Uint8Array | undefined> {
		if (this.version === 1) {
			return base64UrlToBytes(this.encodedAuthority);
		}

		const [iv, ciphertext] = this.encodedAuthority
			.split('.', 2)
			.map((segment) => base64UrlToBytes(segment));

		if (iv === undefined || ciphertext === undefined) {
			return undefined;
		}

		const key = await refreshAuthorityKey(context, this.id, this.secret);

		return decryptOrUndefined(key, iv, ciphertext);
	}

	async authenticate(
		credentialHash: string,
		context: RefreshKeyContext
	): Promise<AuthenticatedRefreshAuthority | undefined> {
		if (
			!(await isConstantTimeEqual(
				credentialHash,
				await sha256Hex(this.value),
				64
			))
		) {
			return undefined;
		}

		const bytes = await this.authorityBytes(context);

		if (bytes === undefined) {
			return undefined;
		}

		let authority: unknown;

		try {
			const json = new TextDecoder('utf-8', {
				fatal: true,
				ignoreBOM: true
			}).decode(bytes);
			authority = JSON.parse(json);
		} catch {
			return undefined;
		}

		const parsed = authoritySchema.safeParse(authority);

		if (
			!parsed.success ||
			parsed.data.version !== this.version ||
			parsed.data.tenant !== context.tenant ||
			parsed.data.memberId !== this.id
		) {
			return undefined;
		}

		return {
			...parsed.data,
			identity: parsed.data.identity as unknown as VerifiedOidcClaims
		};
	}
}

export function refreshPolicyIdentity(
	claims: VerifiedOidcClaims
): RefreshAuthority['identity'] {
	return identitySchema.parse(
		Object.fromEntries(
			Object.entries(claims).filter(
				([key, value]) => typeof value === 'string' || key === 'aud'
			)
		)
	);
}

function base64UrlToBytes(value: string): Uint8Array | undefined {
	try {
		return base64ToBytes(value.replaceAll('-', '+').replaceAll('_', '/'));
	} catch {
		return undefined;
	}
}

async function deriveRefreshKey(
	context: RefreshKeyContext,
	salt: string,
	info: readonly string[]
): Promise<CryptoKey> {
	const encoder = new TextEncoder();
	const material = await crypto.subtle.importKey(
		'raw',
		encoder.encode(context.signingKey),
		'HKDF',
		false,
		['deriveKey']
	);

	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: encoder.encode(salt),
			info: encoder.encode(JSON.stringify(info))
		},
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

function refreshAuthorityKey(
	context: RefreshKeyContext,
	memberId: string,
	secret: string
): Promise<CryptoKey> {
	return deriveRefreshKey(context, secret, [
		'cupboard/refresh-authority/v1',
		context.tenant,
		memberId
	]);
}

function refreshEnvelopeKey(
	context: RefreshKeyContext,
	presented: RefreshCredential,
	successorId: string
): Promise<CryptoKey> {
	return deriveRefreshKey(context, presented.secret, [
		'cupboard/refresh-envelope/v3',
		context.tenant,
		presented.id,
		successorId
	]);
}

async function decryptOrUndefined(
	key: CryptoKey,
	iv: Uint8Array,
	ciphertext: Uint8Array
): Promise<Uint8Array | undefined> {
	try {
		return new Uint8Array(
			await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
		);
	} catch (error) {
		if (error instanceof DOMException && error.name === 'OperationError') {
			return undefined;
		}

		throw error;
	}
}

/**
 * Encrypts a successor credential for the spent member that it replaces. A
 * retry that presents the spent credential within the grace window can then
 * recover the successor.
 */
export async function sealRefreshSuccessor(
	context: RefreshKeyContext,
	presented: RefreshCredential,
	successor: RefreshCredential
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await refreshEnvelopeKey(context, presented, successor.id);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		new TextEncoder().encode(successor.value)
	);

	return `${bytesToHex(iv)}.${bytesToHex(new Uint8Array(ciphertext))}`;
}

/**
 * Decrypts a successor envelope with the spent credential that sealed it.
 * Returns undefined for a missing, malformed or unauthenticated envelope.
 */
export async function openRefreshSuccessor(
	context: RefreshKeyContext,
	presented: RefreshCredential,
	successorId: string,
	envelope: string | null
): Promise<string | undefined> {
	if (envelope === null) {
		return undefined;
	}

	const [ivHex, ciphertextHex, extra] = envelope.split('.', 3);

	if (
		ivHex === undefined ||
		ciphertextHex === undefined ||
		extra !== undefined ||
		!/^[\da-f]{24}$/iu.test(ivHex) ||
		ciphertextHex.length > (refreshCredentialMaxBytes + 16) * 2 ||
		!/^(?:[\da-f]{2}){17,}$/u.test(ciphertextHex)
	) {
		return undefined;
	}

	const key = await refreshEnvelopeKey(context, presented, successorId);
	const secret = await decryptOrUndefined(
		key,
		hexToBytes(ivHex),
		hexToBytes(ciphertextHex)
	);

	return secret === undefined ? undefined : new TextDecoder().decode(secret);
}
