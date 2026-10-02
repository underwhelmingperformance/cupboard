import {
	base64ToBytes,
	bytesToBase64Url,
	bytesToHex
} from '@cupboard/nix-store/encoding';
import { type TenantId, tenantIdSchema } from '@cupboard/nix-store/scalars';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import { type VerifiedOidcClaims } from '@cupboard/protocol/oidc-trust-match';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { z } from 'zod';

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
	version: z.literal(1),
	tenant: tenantIdSchema,
	familyId: z.uuid(),
	memberId: z.uuid(),
	generation: z.number().int().nonnegative(),
	expiresAt: z.iso.datetime().pipe(isoTimestampSchema),
	identity: identitySchema,
	grants: authorizationDetailsSchema.min(1)
});

export type RefreshAuthority = z.output<typeof authoritySchema>;
export type AuthenticatedRefreshAuthority = Omit<
	RefreshAuthority,
	'identity'
> & {
	readonly identity: VerifiedOidcClaims;
};

/**
 * A bounded opaque credential whose complete value is authenticated by member state.
 */
export class RefreshCredential {
	static issue(authority: RefreshAuthority): RefreshCredential {
		const validated = authoritySchema.parse(authority);
		const json = JSON.stringify(validated);

		if (json.length > refreshCredentialMaxBytes) {
			throw new RefreshCredentialSizeLimitError();
		}

		const encoded = bytesToBase64Url(new TextEncoder().encode(json));
		const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
		const value = `${authority.memberId}.${secret}.${encoded}`;

		if (value.length > refreshCredentialMaxBytes) {
			throw new RefreshCredentialSizeLimitError();
		}

		return new RefreshCredential(value, authority.memberId, secret, encoded);
	}

	static parse(value: string): RefreshCredential | undefined {
		if (value.length > refreshCredentialMaxBytes) {
			return undefined;
		}

		const match =
			/^(?<id>[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.(?<secret>[\da-f]{64})\.(?<authority>[\w-]+)$/u.exec(
				value
			);
		const { id, secret, authority } = match?.groups ?? {};

		if (id === undefined || secret === undefined || authority === undefined) {
			return undefined;
		}

		return new RefreshCredential(value, id, secret, authority);
	}

	private constructor(
		readonly value: string,
		readonly id: string,
		readonly secret: string,
		private readonly encodedAuthority: string
	) {}

	async authenticate(
		credentialHash: string,
		tenant: TenantId
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

		try {
			const encoded = this.encodedAuthority
				.replaceAll('-', '+')
				.replaceAll('_', '/');
			const bytes = base64ToBytes(encoded);
			const json = new TextDecoder('utf-8', {
				fatal: true,
				ignoreBOM: true
			}).decode(bytes);
			const authority: unknown = JSON.parse(json);
			const parsed = authoritySchema.safeParse(authority);

			if (
				!parsed.success ||
				parsed.data.tenant !== tenant ||
				parsed.data.memberId !== this.id
			) {
				return undefined;
			}

			return {
				...parsed.data,
				identity: parsed.data.identity as unknown as VerifiedOidcClaims
			};
		} catch {
			return undefined;
		}
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
