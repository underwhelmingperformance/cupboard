import { type AuthKeyId } from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import { importJWK, jwtVerify, SignJWT } from 'jose';

import { generateEd25519KeyPair } from '../crypto/crypto.ts';

// A token's authority is its grant set, carried as RFC 9396
// `authorization_details`. The owner holds a single wildcard grant; a CI token
// holds the concrete grants its trust rule permitted.
export interface AccessClaims {
	readonly subject: string;
	readonly grants: AuthorizationDetails;
	// When the bearer token itself expires. Any credential derived from this
	// token is capped at this instant, so it cannot outlive the token.
	readonly expiresAt: Date;
}

// The issued-token type per RFC 9068, set in the header and verified on the way
// back in. The grants are carried in the RFC 9396 claim.
const accessTokenType = 'at+jwt';
const authorizationDetailsClaim = 'authorization_details';

export const adminJwtTtlSeconds = 10 * 60;
export const writeJwtTtlSeconds = 15 * 60;
// Each refresh rotates the token with a fresh window, so a session lives as
// long as it is used at least this often; an idle one lapses to `cupboard
// login`.
export const refreshTokenTtlSeconds = 30 * 24 * 60 * 60;
export const accessJwtClockToleranceSeconds = 30;
export const accessJwtRetirementMarginSeconds = 5 * 60;

// A public key in the verification set, addressed by its `kid` so a rotated key
// set can hold several at once.
export interface AuthPublicKey {
	readonly kid: AuthKeyId;
	readonly publicJwk: JsonWebKey;
}

// The bearer token from an `Authorization: Bearer <token>` header, or undefined
// when the header is absent or not a bearer credential.
export function bearerToken(request: Request): string | undefined {
	const header = request.headers.get('authorization');

	if (header?.startsWith('Bearer ') !== true) {
		return undefined;
	}

	return header.slice('Bearer '.length);
}

export interface IssueAccessJwtOptions {
	readonly issuer: string;
	readonly audience: string;
	readonly subject: string;
	readonly grants: AuthorizationDetails;
	readonly kid: AuthKeyId;
	readonly ttlSeconds: number;
	readonly auditClaims?: Readonly<Record<string, unknown>>;
}

export interface VerifyAccessJwtOptions {
	readonly issuer: string;
	readonly audience: string;
}

export abstract class AccessTokenError extends Error {}

export class AccessTokenVerificationError extends AccessTokenError {
	constructor(options: { readonly cause: unknown }) {
		super('Access token signature, issuer, audience, or expiry is invalid', {
			cause: options.cause
		});
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

// cupboard signs its own access tokens with EdDSA; the same value labels the
// public key published in the JWKS.
export const authJwtAlgorithm = 'EdDSA';
const jwtAlgorithm = authJwtAlgorithm;
const clockToleranceSeconds = accessJwtClockToleranceSeconds;

export function scheduledAccessKeyRetireAt(rotatedAt: Date): string {
	const retireAt = new Date(
		rotatedAt.getTime() +
			Math.max(adminJwtTtlSeconds, writeJwtTtlSeconds) * 1000 +
			accessJwtClockToleranceSeconds * 1000 +
			accessJwtRetirementMarginSeconds * 1000
	);
	return retireAt.toISOString();
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

	// Audit claims are spread first so the grants claim below always wins; the
	// registered claims set via the builder cannot be clobbered by them either.
	const jwt = new SignJWT({
		...options.auditClaims,
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

	// `exp` is a required claim above, so a verified token always carries one.
	const expiresAt = new Date((verified.payload.exp ?? 0) * 1000);

	return {
		subject,
		grants: parseGrants(verified.payload[authorizationDetailsClaim]),
		expiresAt
	};
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
