import {
	signupRequestSchema,
	type SignupResponse
} from '@cupboard/protocol/signup';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { JWTPayload } from 'jose';

import * as d1Schema from '../db/d1-schema.ts';
import {
	ControlNotConfiguredError,
	InvalidGrantError,
	IssuerUnavailableError,
	SignupForbiddenError
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
// seeds the control trust rule that lets it mint admin tokens). The gate is checked
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
		throw new InvalidGrantError('Subject token is not a JWT');
	}

	const verified = await verifySignupToken(
		issuer,
		audience,
		body.subject_token
	);
	const subject = verifiedSubject(verified);

	enforceGate(env, body.claim_secret, subject);

	const { claimed } = await claimGlobalAdmin(
		controlDatabase(env),
		{ issuer, subject, audience },
		new Date().toISOString()
	);

	return Response.json({ issuer, subject, claimed } satisfies SignupResponse, {
		headers: { 'cache-control': 'no-store' }
	});
}

// The deployment gate configuration the claim consults: a single-use claim secret,
// a pinned subject, and the local-development relaxation flag. A secret never put
// (and a var a hand-rolled deploy omitted) is an absent binding, so each member
// reads as undefined rather than the empty string.
export interface SignupGate {
	readonly CUPBOARD_SIGNUP_SECRET: string | undefined;
	readonly CUPBOARD_SIGNUP_SUBJECT: string | undefined;
	readonly CUPBOARD_LOCAL_DEV: string | undefined;
}

// Enforces the deployment gate that decides who may claim global admin. A
// configured single-use claim secret must be presented and match; otherwise a
// configured pinned subject must equal the verified subject; otherwise the claim is
// refused unless local development explicitly relaxes it. Exported for direct
// testing of the gate matrix.
export function enforceGate(
	env: SignupGate,
	claimSecret: string | undefined,
	subject: string
): void {
	const secret = env.CUPBOARD_SIGNUP_SECRET ?? '';

	if (secret !== '') {
		if (claimSecret === undefined || !constantTimeEquals(claimSecret, secret)) {
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
	issuer: string,
	audience: string,
	token: string
): Promise<JWTPayload> {
	const resolved = await discovery.resolve(issuer).catch((error: unknown) => {
		throw new IssuerUnavailableError(issuer, { cause: error });
	});

	try {
		return await verifyInboundOidcToken(
			resolved.resolver,
			token,
			{ issuer, audience, algorithms: resolved.algorithms },
			new Date()
		);
	} catch (error) {
		if (error instanceof OidcKeysUnreachableError) {
			throw new IssuerUnavailableError(issuer, { cause: error });
		}

		throw new InvalidGrantError('Subject token failed verification');
	}
}

function verifiedSubject(verified: JWTPayload): string {
	if (typeof verified.sub !== 'string' || verified.sub === '') {
		throw new InvalidGrantError('Subject token has no subject');
	}

	return verified.sub;
}

function constantTimeEquals(a: string, b: string): boolean {
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
// omit the vars entirely, in which case the env reads as undefined rather
// than the empty string; both refuse.
interface SignupVerificationConfig {
	readonly CUPBOARD_SIGNUP_ISSUER: string | undefined;
	readonly CUPBOARD_SIGNUP_AUDIENCE: string | undefined;
}

function signupIssuer(env: SignupVerificationConfig): string {
	const configured = env.CUPBOARD_SIGNUP_ISSUER ?? '';

	if (configured === '') {
		throw new ControlNotConfiguredError();
	}

	return configured;
}

function signupAudience(env: SignupVerificationConfig): string {
	const configured = env.CUPBOARD_SIGNUP_AUDIENCE ?? '';

	if (configured === '') {
		throw new ControlNotConfiguredError();
	}

	return configured;
}
