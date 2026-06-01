import { importJWK, jwtVerify, SignJWT } from 'jose';

export type AccessScope = 'write' | 'admin';

// Admin tokens (owner) are unconstrained; a write token (CI) may carry
// `cbRoots`, the retention roots — exact names or `<prefix>` patterns — it is
// permitted to mutate.
export interface AccessClaims {
	readonly scope: AccessScope;
	readonly subject: string;
	readonly cbRoots?: readonly string[];
}

// The minted-token type per RFC 9068, set in the header and verified on the way
// back in.
const accessTokenType = 'at+jwt';
const callbackRootsClaim = 'cb_roots';

export const adminJwtTtlSeconds = 10 * 60;
export const writeJwtTtlSeconds = 15 * 60;

// A public key in the verification set, addressed by its `kid` so a rotated key
// set can hold several at once.
export interface AuthPublicKey {
	readonly kid: string;
	readonly publicJwk: JsonWebKey;
}

export interface MintAccessJwtOptions {
	readonly issuer: string;
	readonly audience: string;
	readonly subject: string;
	readonly scope: AccessScope;
	readonly kid: string;
	readonly ttlSeconds: number;
	readonly cbRoots?: readonly string[];
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

export class MissingScopeError extends AccessTokenError {
	constructor() {
		super('Access token has no scope claim');
		this.name = 'MissingScopeError';
	}
}

export class InvalidScopeError extends AccessTokenError {
	constructor(public readonly scope: unknown) {
		super(`Access token scope is not a known scope: ${String(scope)}`);
		this.name = 'InvalidScopeError';
	}
}

export class MissingSubjectError extends AccessTokenError {
	constructor() {
		super('Access token has no subject claim');
		this.name = 'MissingSubjectError';
	}
}

export class InvalidRootConstraintError extends AccessTokenError {
	constructor() {
		super('Access token cb_roots claim is not an array of strings');
		this.name = 'InvalidRootConstraintError';
	}
}

const jwtAlgorithm = 'EdDSA';
const clockToleranceSeconds = 30;

export async function generateAuthKeyPair(): Promise<{
	readonly privateJwk: JsonWebKey;
	readonly publicJwk: JsonWebKey;
}> {
	const keyPair = (await crypto.subtle.generateKey('Ed25519', true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;

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

export async function mintAccessJwt(
	privateJwk: JsonWebKey,
	options: MintAccessJwtOptions,
	now: Date
): Promise<string> {
	const key = await importJWK(privateJwk, jwtAlgorithm);
	const issuedAt = Math.floor(now.getTime() / 1000);

	// Audit claims are spread first so the registered claims and scope/cb_roots
	// below always win; the registered claims set via the builder cannot be
	// clobbered by them either.
	return new SignJWT({
		...options.auditClaims,
		scope: options.scope,
		...(options.cbRoots === undefined
			? {}
			: { [callbackRootsClaim]: options.cbRoots })
	})
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
	const verified = await jwtVerify(
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
	).catch((error: unknown) => {
		throw new AccessTokenVerificationError({ cause: error });
	});

	const scope = verified.payload.scope;

	if (scope === undefined) {
		throw new MissingScopeError();
	}

	if (scope !== 'write' && scope !== 'admin') {
		throw new InvalidScopeError(scope);
	}

	const subject = verified.payload.sub;

	if (typeof subject !== 'string' || subject === '') {
		throw new MissingSubjectError();
	}

	return {
		scope,
		subject,
		...parseCallbackRoots(verified.payload[callbackRootsClaim])
	};
}

function parseCallbackRoots(value: unknown): { cbRoots?: readonly string[] } {
	if (value === undefined) {
		return {};
	}

	if (
		!Array.isArray(value) ||
		!value.every((entry) => typeof entry === 'string')
	) {
		throw new InvalidRootConstraintError();
	}

	return { cbRoots: value };
}
