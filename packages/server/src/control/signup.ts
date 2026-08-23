import {
	type OidcAudience,
	oidcAudienceSchema,
	type OidcIssuer,
	oidcIssuerSchema
} from '@cupboard/protocol/oidc';
import { IssuerUrl } from '@cupboard/protocol/oidc-issuer';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	signupRequestSchema,
	type SignupResponse
} from '@cupboard/protocol/signup';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { JWTPayload } from 'jose';

import { isConstantTimeEqual, sha256Hex } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	ControlNotConfiguredError,
	IssuerUnavailableError,
	SignupForbiddenError,
	SubjectTokenNotJwtError,
	SubjectTokenSubjectMissingError,
	SubjectTokenVerificationFailedError
} from '../errors.ts';
import { parseFormBody } from '../http/parse.ts';
import {
	canUseLoopbackHttp,
	isAllowedIssuerTransport,
	type LocalDevelopmentEnvironment
} from '../oidc/issuer-policy.ts';
import {
	decodeInboundClaims,
	OidcDiscoveryStore,
	OidcKeysUnreachableError,
	verifyInboundOidcToken
} from '../oidc/oidc.ts';

import { claimGlobalAdmin } from './global-admin.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

// Issuer discovery cached across requests in this Worker instance, the same shape
// the token exchange uses, here against the single deploy-configured signup issuer.
const discovery = new OidcDiscoveryStore();
const localDevelopmentDiscovery = new OidcDiscoveryStore({
	canUseLoopbackHttp: true
});

// The gated first-signup claim: a caller presents an external OIDC subject token,
// it is verified against the deploy-configured signup issuer, the deployment gate
// is enforced, and only then is the principal claimed as global admin (which also
// seeds the control trust rule that lets it issue admin tokens). The gate is checked
// after verification, so only an authenticated principal can probe it.
export async function handleSignup(
	request: Request,
	env: Env
): Promise<Response> {
	const issuer = signupIssuer(env);
	const audience = signupAudience(env);
	const body = await parseFormBody(signupRequestSchema, request);

	try {
		decodeInboundClaims(body.subject_token);
	} catch {
		throw new SubjectTokenNotJwtError();
	}

	const verified = await verifySignupToken(
		issuer,
		audience,
		body.subject_token,
		canUseLoopbackHttp(env)
	);
	const subject = verifiedSubject(verified);

	await enforceGate(env, body.claim_secret, subject);

	const now = new Date();
	const { claimed: isClaimed } = await claimGlobalAdmin(
		controlDatabase(env),
		{ issuer, subject, audience },
		isoTimestamp(now)
	);

	return Response.json(
		{ issuer, subject, claimed: isClaimed } satisfies SignupResponse,
		{
			headers: { 'cache-control': 'no-store' }
		}
	);
}

// Bindings can be absent in a hand-written deployment. Read each value as
// optional so a missing gate fails closed outside local development.
export interface SignupGate {
	readonly CUPBOARD_SIGNUP_SECRET: string | undefined;
	readonly CUPBOARD_SIGNUP_SUBJECT: string | undefined;
	readonly CUPBOARD_LOCAL_DEV: string | undefined;
}

// A configured single-use claim secret must match. Without a secret, a
// configured subject must match the verified token. With neither binding, only
// local development may claim the first administrator.
export async function enforceGate(
	env: SignupGate,
	claimSecret: string | undefined,
	subject: string
): Promise<void> {
	const secret = env.CUPBOARD_SIGNUP_SECRET ?? '';

	if (secret !== '') {
		if (claimSecret === undefined) {
			throw new SignupForbiddenError();
		}

		const [presentedHash, expectedHash] = await Promise.all([
			sha256Hex(claimSecret),
			sha256Hex(secret)
		]);

		if (!(await isConstantTimeEqual(presentedHash, expectedHash, 64))) {
			throw new SignupForbiddenError();
		}

		return;
	}

	const pinnedSubject = env.CUPBOARD_SIGNUP_SUBJECT ?? '';

	if (pinnedSubject !== '') {
		if (subject !== pinnedSubject) {
			throw new SignupForbiddenError();
		}

		return;
	}

	if (canUseLoopbackHttp(env)) {
		return;
	}

	throw new SignupForbiddenError();
}

async function verifySignupToken(
	issuer: OidcIssuer,
	audience: OidcAudience,
	token: string,
	canUseHttpLoopback: boolean
): Promise<JWTPayload> {
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

function verifiedSubject(verified: JWTPayload): string {
	if (typeof verified.sub !== 'string' || verified.sub === '') {
		throw new SubjectTokenSubjectMissingError();
	}

	return verified.sub;
}

function controlDatabase(env: Env): Database {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

// The verification half of the signup config. A hand-rolled deployment may
// omit the vars entirely, in which case the env reads as undefined; both refuse.
interface SignupVerificationConfig extends LocalDevelopmentEnvironment {
	readonly CUPBOARD_SIGNUP_ISSUER: string | undefined;
	readonly CUPBOARD_SIGNUP_AUDIENCE: string | undefined;
}

function signupIssuer(env: SignupVerificationConfig): OidcIssuer {
	// Parse the configured value at ingress so discovery and token verification
	// use the same exact issuer identifier. An unusable value is a deployment
	// fault which the caller cannot clear by retrying.
	const configured = IssuerUrl.parse(env.CUPBOARD_SIGNUP_ISSUER ?? '');

	if (
		configured === undefined ||
		!isAllowedIssuerTransport(configured.value, canUseLoopbackHttp(env))
	) {
		throw new ControlNotConfiguredError();
	}

	return oidcIssuerSchema.parse(configured.value);
}

function signupAudience(env: SignupVerificationConfig): OidcAudience {
	const configured = env.CUPBOARD_SIGNUP_AUDIENCE ?? '';

	if (configured === '') {
		throw new ControlNotConfiguredError();
	}

	return oidcAudienceSchema.parse(configured);
}
