import {
	type OidcAudience,
	oidcAudienceSchema,
	type OidcIssuer,
	oidcIssuerSchema
} from '@cupboard/protocol/oidc';
import { IssuerUrl } from '@cupboard/protocol/oidc-issuer';
import {
	type OidcClaims,
	type VerifiedOidcClaims
} from '@cupboard/protocol/oidc-trust-match';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	signupRequestSchema,
	type SignupResponseInput
} from '@cupboard/protocol/signup';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import { isConstantTimeEqual, sha256Hex } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	IssuerUnavailableError,
	SignupForbiddenError,
	SubjectTokenAudienceInvalidError,
	SubjectTokenIssuerInvalidError,
	SubjectTokenNotJwtError,
	SubjectTokenSubjectMissingError,
	SubjectTokenVerificationFailedError
} from '../errors.ts';
import { parseFormBody } from '../http/parse.ts';
import {
	canUseLoopbackHttp,
	isAllowedIssuerTransport
} from '../oidc/issuer-policy.ts';
import {
	decodeInboundClaims,
	OidcDiscoveryStore,
	OidcKeysUnreachableError,
	verifyInboundOidcToken
} from '../oidc/oidc.ts';

import { claimGlobalAdmin } from './global-admin.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

// Issuer discovery cached across requests in this Worker instance, with the
// same shape as the store that the token exchange uses. Here it resolves the
// issuer in the presented token's `iss`.
const discovery = new OidcDiscoveryStore();
const localDevelopmentDiscovery = new OidcDiscoveryStore({
	canUseLoopbackHttp: true
});

// The first-admin claim. The deploy sets a claim secret on the Worker for one
// claim and presents it with an id_token from any OIDC issuer. The issuer
// comes from the unverified token's `iss`, so discovery fetches from a URL that
// the caller chooses. The secret is checked before the token is decoded, so a
// caller without it cannot make the Worker fetch anything.
//
// The token's `iss` and `sub` identify the principal, which becomes the global
// admin. The seeded control trust rule pins `iss`, `sub` and the single `aud`,
// and lets the principal obtain admin tokens at `/token`.
export async function handleSignup(
	request: Request,
	env: Env
): Promise<Response> {
	const body = await parseFormBody(signupRequestSchema, request);

	await enforceClaimSecret(env, body.claim_secret);

	let claims: OidcClaims;

	try {
		claims = decodeInboundClaims(body.subject_token);
	} catch {
		throw new SubjectTokenNotJwtError();
	}

	const isLoopbackAllowed = canUseLoopbackHttp(env);
	const issuer = tokenIssuer(claims, isLoopbackAllowed);
	const audience = tokenAudience(claims);
	const verified = await verifySignupToken(
		issuer,
		audience,
		body.subject_token,
		isLoopbackAllowed
	);
	const subject = verifiedSubject(verified);

	const now = new Date();
	const { claimed: isClaimed } = await claimGlobalAdmin(
		controlDatabase(env),
		{ issuer, subject, audience },
		isoTimestamp(now)
	);

	return Response.json(
		{
			issuer,
			subject,
			audience,
			claimed: isClaimed
		} satisfies SignupResponseInput,
		{
			headers: { 'cache-control': 'no-store' }
		}
	);
}

// In a hand-written deployment, the binding can be absent. It then reads as
// undefined, and every claim is refused.
export interface ClaimSecretEnvironment {
	readonly CUPBOARD_SIGNUP_SECRET: string | undefined;
}

// The presented claim secret must match the secret on the Worker. Without a
// secret on the Worker, nobody can claim the first administrator.
export async function enforceClaimSecret(
	env: ClaimSecretEnvironment,
	claimSecret: string | undefined
): Promise<void> {
	const secret = env.CUPBOARD_SIGNUP_SECRET ?? '';

	// Both values are hashed and compared before any refusal, so the response
	// time does not show whether the Worker has a secret.
	const [presentedHash, expectedHash] = await Promise.all([
		sha256Hex(claimSecret ?? ''),
		sha256Hex(secret)
	]);
	const isMatch = await isConstantTimeEqual(presentedHash, expectedHash, 64);

	if (secret === '' || claimSecret === undefined || !isMatch) {
		throw new SignupForbiddenError();
	}
}

// The issuer comes from the unverified token. Verification then requires the
// signed `iss` to match it, so a forged `iss` fails verification.
function tokenIssuer(
	claims: OidcClaims,
	isLoopbackAllowed: boolean
): OidcIssuer {
	const parsed =
		typeof claims.iss === 'string' ? IssuerUrl.parse(claims.iss) : undefined;

	if (
		parsed === undefined ||
		!isAllowedIssuerTransport(parsed.value, isLoopbackAllowed)
	) {
		throw new SubjectTokenIssuerInvalidError();
	}

	return oidcIssuerSchema.parse(parsed.value);
}

// The claims are decoded but not yet verified, so `aud` can have any JSON
// shape here despite its declared type.
const inboundAudienceSchema = z.union([
	oidcAudienceSchema,
	z.array(oidcAudienceSchema)
]);

// The seeded trust rule pins one audience, so a token must contain exactly one.
function tokenAudience(claims: OidcClaims): OidcAudience {
	const parsed = inboundAudienceSchema.safeParse(claims.aud);

	if (!parsed.success) {
		throw new SubjectTokenAudienceInvalidError();
	}

	const audiences = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
	const [audience, ...others] = audiences;

	if (audience === undefined || audience === '' || others.length > 0) {
		throw new SubjectTokenAudienceInvalidError();
	}

	return audience;
}

async function verifySignupToken(
	issuer: OidcIssuer,
	audience: OidcAudience,
	token: string,
	canUseHttpLoopback: boolean
): Promise<VerifiedOidcClaims> {
	let resolved;
	try {
		resolved = await (
			canUseHttpLoopback ? localDevelopmentDiscovery : discovery
		).resolve(issuer);
	} catch (error: unknown) {
		throw new IssuerUnavailableError(issuer, { cause: error });
	}

	try {
		return await verifyInboundOidcToken(
			resolved.resolver,
			token,
			{
				issuer,
				audience,
				trustedAudiences: new Set(),
				algorithms: resolved.algorithms,
				requireIdTokenClaims: true
			},
			new Date()
		);
	} catch (error) {
		if (error instanceof OidcKeysUnreachableError) {
			throw new IssuerUnavailableError(issuer, { cause: error });
		}

		throw new SubjectTokenVerificationFailedError();
	}
}

function verifiedSubject(verified: VerifiedOidcClaims): string {
	if (typeof verified.sub !== 'string' || verified.sub === '') {
		throw new SubjectTokenSubjectMissingError();
	}

	return verified.sub;
}

function controlDatabase(env: Env): Database {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}
