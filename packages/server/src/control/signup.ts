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
import { z } from 'zod';

import { isConstantTimeEqual, sha256Hex } from '../crypto/crypto.ts';
import {
	SignupForbiddenError,
	SubjectTokenAudienceInvalidError,
	SubjectTokenIssuerInvalidError,
	SubjectTokenNotJwtError,
	SubjectTokenSubjectMissingError
} from '../errors.ts';
import { oauthJsonResponse } from '../http/oauth-response.ts';
import { parseFormBody } from '../http/parse.ts';
import {
	type InboundTokenLimits,
	InboundTokenVerifier
} from '../oidc/inbound-verifier.ts';
import {
	canUseLoopbackHttp,
	isAllowedIssuerTransport
} from '../oidc/issuer-policy.ts';
import { decodeInboundClaims, OidcDiscoveryStore } from '../oidc/oidc.ts';
import { subjectBinding, subjectTokenLimits } from '../oidc/subject-binding.ts';

import { controlIssuer, issueControlSession } from './control-plane.ts';
import { controlTrustRules } from './control-trust.ts';
import { writableControlDatabase } from './database.ts';
import { claimGlobalAdmin } from './global-admin.ts';

// Issuer discovery cached across requests in this Worker instance. Here the
// verifier resolves the issuer in the presented token's `iss`.
const verifier = new InboundTokenVerifier(new OidcDiscoveryStore());
const localDevelopmentVerifier = new InboundTokenVerifier(
	new OidcDiscoveryStore({ canUseLoopbackHttp: true })
);

// The first-admin claim. The deploy sets a claim secret on the Worker for one
// claim and presents it with an id_token from any OIDC issuer. The issuer
// comes from the unverified token's `iss`, so discovery fetches from a URL that
// the caller chooses. The secret is checked before the token is decoded, so a
// caller without it cannot make the Worker fetch anything.
//
// The token's `iss` and `sub` identify the principal, which becomes the global
// admin. The seeded control trust rule pins `iss`, `sub` and the single `aud`,
// and lets the principal obtain admin tokens at `/token`. The response also
// includes a control session issued through that rule, because a nonce-bound
// ID token is consumed here and `/token` would refuse it.
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
		isLoopbackAllowed,
		subjectTokenLimits(body)
	);
	const subject = verifiedSubject(verified);
	const binding = await subjectBinding(verified, controlIssuer(request), body);
	const database = await writableControlDatabase(env);

	const now = new Date();
	const { claimed: isClaimed } = await claimGlobalAdmin(
		database,
		{ issuer, subject, audience },
		isoTimestamp(now)
	);
	const session = await issueControlSession(request, env, {
		verified,
		binding,
		rules: await controlTrustRules(database, isLoopbackAllowed),
		requested: undefined
	});

	return oauthJsonResponse({
		...session,
		issuer,
		subject,
		audience,
		claimed: isClaimed
	} satisfies SignupResponseInput);
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
	canUseHttpLoopback: boolean,
	limits: InboundTokenLimits
): Promise<VerifiedOidcClaims> {
	return (canUseHttpLoopback ? localDevelopmentVerifier : verifier).verify(
		{ issuer, audience },
		token,
		new Set(),
		limits
	);
}

function verifiedSubject(verified: VerifiedOidcClaims): string {
	if (typeof verified.sub !== 'string' || verified.sub === '') {
		throw new SubjectTokenSubjectMissingError();
	}

	return verified.sub;
}
