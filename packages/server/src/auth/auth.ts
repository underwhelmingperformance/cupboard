import {
	type AuthKeyId,
	type TtlSeconds,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetails,
	grantsWithoutRetiredOperationsSchema
} from '@cupboard/protocol/grants';
import {
	type OidcAudience,
	type OidcIssuer,
	type OidcSubject,
	oidcSubjectSchema,
	type TrustRuleId,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type RefreshSessionId,
	refreshSessionIdSchema
} from '@cupboard/protocol/sessions';
import { parseAuthenticationHeader } from '@cupboard/shared/http';
import { importJWK, type JWTPayload, jwtVerify, SignJWT } from 'jose';
import { type z } from 'zod';

import { generateEd25519KeyPair } from '../crypto/crypto.ts';

import { SealedAccessIdentity } from './access-identity.ts';

// Construct this value only after Cupboard verifies the token. The grants are
// parsed from its RFC 9396 `authorization_details` claim.
export interface AccessTokenClaims {
	readonly subject: OidcSubject;
	readonly grants: AuthorizationDetails;
	// The instant in the JWT's `exp` claim. Verification tolerance does not
	// extend this value.
	readonly expiresAt: Date;
}

/**
The claims of a verified tenant access token. `identity` is the sealed OIDC
identity that the token was issued for. Verification checks only that it is
well formed; code that must select trust rules for it again opens it. `ruleId` is the trust rule that issued the
grants, and is absent when several rules together cover them. `sessionId` is
the refresh family that the token came from, and is absent for a token issued
without a refresh token.
*/
export interface AccessClaims extends AccessTokenClaims {
	readonly identity: SealedAccessIdentity;
	readonly ruleId?: TrustRuleId;
	readonly sessionId?: RefreshSessionId;
}

// Keep Cupboard access tokens distinct from both OIDC ID tokens and the RFC
// 9068 profile, whose required claims and algorithm contract differ.
export const accessTokenType = 'cupboard-access+jwt';
const authorizationDetailsClaim = 'authorization_details';
const identityClaim = 'cb_identity';
const ruleClaim = 'cb_rule';
const sessionClaim = 'cb_session';
type TenantAccessClaimName =
	typeof identityClaim | typeof ruleClaim | typeof sessionClaim;

export const adminJwtTtlSeconds = ttlSecondsSchema.parse(10 * 60);
export const writeJwtTtlSeconds = ttlSecondsSchema.parse(15 * 60);
// The oldest target-bound subject token, by its `iat`, that an exchange accepts.
export const subjectNonceMaxAgeSeconds = 5 * 60;
// Every refresh token in a family shares its original expiry. Keep each spent
// token's hash until then so a later replay can revoke the active token.
export const refreshTokenFamilyTtlSeconds = ttlSecondsSchema.parse(
	30 * 24 * 60 * 60
);
// A refreshed ID token from Cloudflare repeats the original `nonce` with a
// fresh `iat`, so it passes the age check. Keep a consumed nonce for as long as
// the session that its sign-in starts.
export const consumedSubjectNonceRetentionSeconds =
	refreshTokenFamilyTtlSeconds;
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
	readonly kid: AuthKeyId;
	readonly ttlSeconds: TtlSeconds;
	readonly auditClaims?: Readonly<Record<string, unknown>>;
}

export interface IssueTenantAccessJwtOptions extends Omit<
	IssueAccessJwtOptions,
	'auditClaims'
> {
	readonly identity: SealedAccessIdentity;
	readonly ruleId?: TrustRuleId;
	readonly sessionId?: RefreshSessionId;
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

export class MissingIdentityError extends AccessTokenError {
	constructor() {
		super(`Access token has no ${identityClaim} claim`);
		this.name = 'MissingIdentityError';
	}
}

export class InvalidAccessClaimError extends AccessTokenError {
	constructor(readonly claim: TenantAccessClaimName) {
		super(`Access token ${claim} claim is malformed`);
		this.name = 'InvalidAccessClaimError';
	}
}

export const authJwtAlgorithm = 'EdDSA';
const jwtAlgorithm = authJwtAlgorithm;
const clockToleranceSeconds = accessJwtClockToleranceSeconds;

/**
Keeps the outgoing key live through the longest access-token lifetime,
verifier clock tolerance, and retirement margin.
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

/**
Issues a tenant access token. The token contains the sealed identity, and
the rule and session that it came from when they are given. Seal the
identity for the token's subject.
*/
export function issueTenantAccessJwt(
	privateJwk: JsonWebKey,
	options: IssueTenantAccessJwtOptions,
	now: Date
): Promise<string> {
	const { identity, ruleId, sessionId, ...signing } = options;

	return signAccessJwt(
		privateJwk,
		signing,
		{
			[identityClaim]: identity.value,
			...(ruleId !== undefined && { [ruleClaim]: ruleId }),
			...(sessionId !== undefined && { [sessionClaim]: sessionId })
		},
		now
	);
}

export function issueAccessJwt(
	privateJwk: JsonWebKey,
	options: IssueAccessJwtOptions,
	now: Date
): Promise<string> {
	const { auditClaims, ...signing } = options;

	return signAccessJwt(privateJwk, signing, auditClaims ?? {}, now);
}

async function signAccessJwt(
	privateJwk: JsonWebKey,
	options: Omit<IssueAccessJwtOptions, 'auditClaims'>,
	claims: Readonly<Record<string, unknown>>,
	now: Date
): Promise<string> {
	const key = await importJWK(privateJwk, jwtAlgorithm);
	const issuedAt = Math.floor(now.getTime() / 1000);

	// Spread the other claims first. The authoritative grants and registered
	// claims must overwrite conflicting names.
	const jwt = new SignJWT({
		...claims,
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
): Promise<AccessTokenClaims> {
	const { claims } = await verifySignedAccessJwt(keys, token, options, now);

	return claims;
}

/**
Verifies a tenant access token and reads the sealed identity, the rule and
the session that it was issued for. A token without a well-formed sealed
identity is refused. The identity stays sealed.
*/
export async function verifyTenantAccessJwt(
	keys: readonly AuthPublicKey[],
	token: string,
	options: VerifyAccessJwtOptions,
	now: Date
): Promise<AccessClaims> {
	const { claims, payload } = await verifySignedAccessJwt(
		keys,
		token,
		options,
		now
	);
	const recorded = payload[identityClaim];

	if (recorded === undefined) {
		throw new MissingIdentityError();
	}

	const identity = SealedAccessIdentity.parse(recorded, claims.subject);

	if (identity === undefined) {
		throw new InvalidAccessClaimError(identityClaim);
	}

	const ruleId = optionalClaim(payload, ruleClaim, trustRuleIdSchema);
	const sessionId = optionalClaim(
		payload,
		sessionClaim,
		refreshSessionIdSchema
	);

	return {
		...claims,
		identity,
		...(ruleId !== undefined && { ruleId }),
		...(sessionId !== undefined && { sessionId })
	};
}

function optionalClaim<Schema extends z.ZodType>(
	payload: JWTPayload,
	claim: typeof ruleClaim | typeof sessionClaim,
	schema: Schema
): z.output<Schema> | undefined {
	const value = payload[claim];

	if (value === undefined) {
		return undefined;
	}

	const parsed = schema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidAccessClaimError(claim);
	}

	return parsed.data;
}

async function verifySignedAccessJwt(
	keys: readonly AuthPublicKey[],
	token: string,
	options: VerifyAccessJwtOptions,
	now: Date
): Promise<{
	readonly claims: AccessTokenClaims;
	readonly payload: JWTPayload;
}> {
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

	return {
		claims: {
			subject: oidcSubjectSchema.parse(subject),
			grants: parseGrants(verified.payload[authorizationDetailsClaim]),
			expiresAt
		},
		payload: verified.payload
	};
}

function parseGrants(value: unknown): AuthorizationDetails {
	if (value === undefined) {
		throw new MissingGrantsError();
	}

	const parsed = grantsWithoutRetiredOperationsSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidGrantsError(parsed.error);
	}

	return parsed.data;
}
