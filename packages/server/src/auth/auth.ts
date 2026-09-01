import {
	type AuthKeyId,
	type TtlSeconds,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import {
	type OidcAudience,
	oidcAudienceSchema,
	type OidcIssuer,
	oidcIssuerSchema,
	type OidcSubject,
	oidcSubjectSchema
} from '@cupboard/protocol/oidc';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { parseAuthenticationHeader } from '@cupboard/shared/http';
import { importJWK, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import { generateEd25519KeyPair } from '../crypto/crypto.ts';

// Construct this value only after Cupboard verifies the token. The grants are
// parsed from its RFC 9396 `authorization_details` claim.
export interface AccessClaims {
	readonly subject: OidcSubject;
	readonly grants: AuthorizationDetails;
	readonly principal?: AccessPrincipal;
	// The instant in the JWT's `exp` claim. Verification tolerance does not
	// extend this value.
	readonly expiresAt: Date;
}

export interface AccessPrincipal {
	readonly issuer: OidcIssuer;
	readonly audience: OidcAudience;
	readonly subject: OidcSubject;
}

// Keep Cupboard access tokens distinct from both OIDC ID tokens and the RFC
// 9068 profile, whose required claims and algorithm contract differ.
export const accessTokenType = 'cupboard-access+jwt';
const authorizationDetailsClaim = 'authorization_details';
const principalClaim = 'cupboard_principal';

export const adminJwtTtlSeconds = ttlSecondsSchema.parse(10 * 60);
export const writeJwtTtlSeconds = ttlSecondsSchema.parse(15 * 60);
// Every refresh token in a family shares its original expiry. Keep each spent
// token's hash until then so a replay can revoke the active token.
export const refreshTokenFamilyTtlSeconds = ttlSecondsSchema.parse(
	30 * 24 * 60 * 60
);
// A client can rotate twice during each access-token lifetime throughout the
// complete family lifetime. Reaching the bound ends the family instead of
// discarding a spent bearer that must still detect replay.
export const maxRefreshTokenFamilyMembers =
	1 + (refreshTokenFamilyTtlSeconds / adminJwtTtlSeconds) * 2;
export const accessJwtClockToleranceSeconds = 30;
export const accessJwtRetirementMarginSeconds = 5 * 60;

export interface AuthPublicKey {
	readonly kid: AuthKeyId;
	readonly publicJwk: JsonWebKey;
}

export function bearerToken(request: Request): string | undefined {
	return parseAuthenticationHeader(
		request.headers.get('authorization') ?? undefined,
		'Bearer'
	);
}

export interface IssueAccessJwtOptions {
	readonly issuer: OidcIssuer;
	readonly audience: OidcAudience;
	readonly subject: OidcSubject;
	readonly grants: AuthorizationDetails;
	readonly principal?: AccessPrincipal;
	readonly kid: AuthKeyId;
	readonly ttlSeconds: TtlSeconds;
	readonly auditClaims?: Readonly<Record<string, unknown>>;
}

export interface VerifyAccessJwtOptions {
	readonly issuer: OidcIssuer;
	readonly audience: OidcAudience;
}

export abstract class AccessTokenError extends Error {}

export class AccessTokenVerificationError extends AccessTokenError {
	constructor(options: { readonly cause: unknown }) {
		super(
			'Access token is malformed or its signing key, protected header, signature, issuer, audience, or required claims are invalid',
			{
				cause: options.cause
			}
		);
		this.name = 'AccessTokenVerificationError';
	}
}

export class MissingGrantsError extends AccessTokenError {
	constructor() {
		super('Access token has no authorization_details claim');
		this.name = 'MissingGrantsError';
	}
}

export class InvalidGrantsError extends AccessTokenError {
	constructor(public readonly cause: unknown) {
		super('Access token authorization_details claim is malformed');
		this.name = 'InvalidGrantsError';
	}
}

export class MissingSubjectError extends AccessTokenError {
	constructor() {
		super('Access token has no subject claim');
		this.name = 'MissingSubjectError';
	}
}

export class InvalidPrincipalError extends AccessTokenError {
	constructor() {
		super('Access token cupboard_principal claim is malformed');
		this.name = 'InvalidPrincipalError';
	}
}

export const authJwtAlgorithm = 'EdDSA';
const jwtAlgorithm = authJwtAlgorithm;
const clockToleranceSeconds = accessJwtClockToleranceSeconds;

/**
 * Keeps the outgoing key live through the longest access-token lifetime,
 * verifier clock tolerance, and retirement margin.
 */
export function scheduledAccessKeyRetireAt(rotatedAt: Date): IsoTimestamp {
	const retireAt = new Date(
		rotatedAt.getTime() +
			Math.max(adminJwtTtlSeconds, writeJwtTtlSeconds) * 1000 +
			accessJwtClockToleranceSeconds * 1000 +
			accessJwtRetirementMarginSeconds * 1000
	);
	return isoTimestamp(retireAt);
}

export async function generateAuthKeyPair(): Promise<{
	readonly privateJwk: JsonWebKey;
	readonly publicJwk: JsonWebKey;
}> {
	const keyPair = await generateEd25519KeyPair();

	return {
		privateJwk: (await crypto.subtle.exportKey(
			'jwk',
			keyPair.privateKey
		)) as JsonWebKey,
		publicJwk: (await crypto.subtle.exportKey(
			'jwk',
			keyPair.publicKey
		)) as JsonWebKey
	};
}

export async function issueAccessJwt(
	privateJwk: JsonWebKey,
	options: IssueAccessJwtOptions,
	now: Date
): Promise<string> {
	const key = await importJWK(privateJwk, jwtAlgorithm);
	const issuedAt = Math.floor(now.getTime() / 1000);

	// Spread caller-supplied audit claims first. The authoritative grants and
	// registered claims must overwrite conflicting names.
	const jwt = new SignJWT({
		...options.auditClaims,
		...(options.principal !== undefined && {
			[principalClaim]: options.principal
		}),
		[authorizationDetailsClaim]: options.grants
	});
	return jwt
		.setProtectedHeader({
			alg: jwtAlgorithm,
			typ: accessTokenType,
			kid: options.kid
		})
		.setIssuer(options.issuer)
		.setAudience(options.audience)
		.setSubject(options.subject)
		.setJti(crypto.randomUUID())
		.setIssuedAt(issuedAt)
		.setNotBefore(issuedAt)
		.setExpirationTime(issuedAt + options.ttlSeconds)
		.sign(key);
}

export async function verifyAccessJwt(
	keys: readonly AuthPublicKey[],
	token: string,
	options: VerifyAccessJwtOptions,
	now: Date
): Promise<AccessClaims> {
	let verified: Awaited<ReturnType<typeof jwtVerify>>;
	try {
		verified = await jwtVerify(
			token,
			async (header) => {
				const match = keys.find((entry) => entry.kid === header.kid);

				if (match === undefined) {
					throw new Error('no verification key for the token key id');
				}

				return importJWK(match.publicJwk, jwtAlgorithm);
			},
			{
				issuer: options.issuer,
				audience: options.audience,
				algorithms: [jwtAlgorithm],
				typ: accessTokenType,
				requiredClaims: ['exp', 'nbf'],
				clockTolerance: clockToleranceSeconds,
				currentDate: now
			}
		);
	} catch (error: unknown) {
		throw new AccessTokenVerificationError({ cause: error });
	}

	const subject = verified.payload.sub;

	if (typeof subject !== 'string' || subject === '') {
		throw new MissingSubjectError();
	}

	// jose does not narrow the payload type after `requiredClaims` enforces `exp`.
	const expiresAt = new Date((verified.payload.exp ?? 0) * 1000);
	const principal = parsePrincipal(verified.payload[principalClaim]);

	return {
		subject: oidcSubjectSchema.parse(subject),
		grants: parseGrants(verified.payload[authorizationDetailsClaim]),
		...(principal !== undefined && { principal }),
		expiresAt
	};
}

function parsePrincipal(value: unknown): AccessPrincipal | undefined {
	if (value === undefined) {
		return undefined;
	}

	const parsed = z
		.strictObject({
			issuer: oidcIssuerSchema,
			audience: oidcAudienceSchema,
			subject: oidcSubjectSchema
		})
		.safeParse(value);

	if (!parsed.success) {
		throw new InvalidPrincipalError();
	}

	return parsed.data;
}

function parseGrants(value: unknown): AuthorizationDetails {
	if (value === undefined) {
		throw new MissingGrantsError();
	}

	const parsed = authorizationDetailsSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidGrantsError(parsed.error);
	}

	return parsed.data;
}
