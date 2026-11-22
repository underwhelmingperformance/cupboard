import { type VerifiedOidcClaims } from '@cupboard/protocol/oidc-trust-match';
import { z } from 'zod';

const audienceValueSchema = z.string().min(1);
const audienceSchema = z.union([
	audienceValueSchema,
	z.array(audienceValueSchema).min(1)
]);

const identityClaimSchema = z.union([z.string(), z.array(z.string())]);

/**
The claims of a verified OIDC identity that trust-rule selection reads: the
issuer, the subject, the audiences and every other string claim.
*/
export const oidcPolicyIdentitySchema = z
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
export type OidcPolicyIdentity = z.output<typeof oidcPolicyIdentitySchema>;

/**
Keeps the claims of a verified identity that a later trust-rule selection
needs, so a refresh credential, an access token or an access key can record
them.
*/
export function oidcPolicyIdentity(
	claims: VerifiedOidcClaims
): OidcPolicyIdentity {
	return oidcPolicyIdentitySchema.parse(
		Object.fromEntries(
			Object.entries(claims).filter(
				([key, value]) => typeof value === 'string' || key === 'aud'
			)
		)
	);
}

/**
Returns a recorded policy identity as verified claims. Use it only for an
identity that Cupboard recorded after a verifier accepted it, and read back
from storage, a sealed credential or a token that Cupboard signed.
*/
export function verifiedPolicyIdentity(
	identity: OidcPolicyIdentity
): VerifiedOidcClaims {
	return identity as unknown as VerifiedOidcClaims;
}

/**
Reads a policy identity that Cupboard recorded, with the same restriction as
{@link verifiedPolicyIdentity}. Returns undefined when the value is not a
policy identity.
*/
export function recordedOidcIdentity(
	value: unknown
): VerifiedOidcClaims | undefined {
	const parsed = oidcPolicyIdentitySchema.safeParse(value);

	return parsed.success ? verifiedPolicyIdentity(parsed.data) : undefined;
}
