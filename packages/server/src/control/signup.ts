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
		body.subject_token
	);
	const subject = verifiedSubject(verified);

	enforceGate(env, body.claim_secret, subject);

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

// A configured claim secret must match; otherwise a configured subject must
// match the verified token. With neither binding, only local development may
// claim the first administrator.
export function enforceGate(
	env: SignupGate,
	claimSecret: string | undefined,
	subject: string
): void {
	const secret = env.CUPBOARD_SIGNUP_SECRET ?? '';

	if (secret !== '') {
		if (
			claimSecret === undefined ||
			!isConstantTimeEqual(claimSecret, secret)
		) {
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

	if (isLocalDevelopment(env)) {
		return;
	}

	throw new SignupForbiddenError();
}

async function verifySignupToken(
	issuer: OidcIssuer,
	audience: OidcAudience,
	token: string
): Promise<JWTPayload> {
	let resolved;
	try {
		resolved = await discovery.resolve(issuer);
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

function isConstantTimeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);

	if (aBytes.length !== bBytes.length) {
		return false;
	}

	let difference = 0;

	for (const [index, byte] of aBytes.entries()) {
		difference |= byte ^ (bBytes[index] ?? 0);
	}

	return difference === 0;
}

function isLocalDevelopment(env: SignupGate): boolean {
	const flag = env.CUPBOARD_LOCAL_DEV;

	return flag === '1' || flag === 'true';
}

function controlDatabase(env: Env): Database {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

// The verification half of the signup config. A hand-rolled deployment may
// omit the vars entirely, in which case the env reads as undefined; both refuse.
interface SignupVerificationConfig {
	readonly CUPBOARD_SIGNUP_ISSUER: string | undefined;
	readonly CUPBOARD_SIGNUP_AUDIENCE: string | undefined;
}

function signupIssuer(env: SignupVerificationConfig): OidcIssuer {
	// Discovery is cached per issuer identifier, so the configured value is
	// normalised here, where it enters the server, and a value that is not a
	// usable issuer URL is a deploy fault the caller cannot clear by retrying.
	const configured = IssuerUrl.parse(env.CUPBOARD_SIGNUP_ISSUER ?? '');

	if (configured === undefined) {
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
