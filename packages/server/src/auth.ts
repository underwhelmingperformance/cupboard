import { importJWK, jwtVerify, SignJWT } from 'jose';

export type AccessScope = 'write' | 'admin';

export interface AccessClaims {
	readonly scope: AccessScope;
	readonly subject: string;
}

export interface MintAccessJwtOptions {
	readonly issuer: string;
	readonly audience: string;
	readonly subject: string;
	readonly scope: AccessScope;
	readonly ttlSeconds: number;
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

	return new SignJWT({ scope: options.scope })
		.setProtectedHeader({ alg: jwtAlgorithm })
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
	publicJwk: JsonWebKey,
	token: string,
	options: VerifyAccessJwtOptions,
	now: Date
): Promise<AccessClaims> {
	const key = await importJWK(publicJwk, jwtAlgorithm);

	const verified = await jwtVerify(token, key, {
		issuer: options.issuer,
		audience: options.audience,
		algorithms: [jwtAlgorithm],
		clockTolerance: clockToleranceSeconds,
		currentDate: now
	}).catch((error: unknown) => {
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

	return { scope, subject };
}
