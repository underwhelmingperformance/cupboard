import {
	issuedAccessTokenType,
	subjectTokenTypeIdToken,
	subjectTokenTypeJwt,
	tokenExchangeGrantType,
	tokenExchangeRequestSchema,
	type TokenResponse
} from '@cupboard/protocol/oidc';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { JWTPayload } from 'jose';

import {
	adminJwtTtlSeconds,
	bearerToken,
	mintAccessJwt,
	verifyAccessJwt
} from '../auth/auth.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	ControlNotConfiguredError,
	InsufficientScopeError,
	InvalidGrantError,
	InvalidRequestError,
	IssuerUnavailableError,
	UnauthenticatedError,
	UnsupportedGrantTypeError
} from '../errors.ts';
import { serverErrorResponse } from '../http/error-response.ts';
import { parseFormBody } from '../http/parse.ts';
import {
	decodeInboundClaims,
	OidcDiscoveryStore,
	OidcKeysUnreachableError,
	verifyInboundOidcToken
} from '../oidc/oidc.ts';
import { matchOidcTrust, type OidcTrustRule } from '../oidc/oidc-trust.ts';

import {
	activeControlKey,
	controlKeySummaries,
	controlVerificationKeys,
	ensureControlKey,
	retireControlKey,
	rotateControlKey
} from './control-key-store.ts';
import { controlTrustRules } from './control-trust.ts';
import { handleSignup } from './signup.ts';

// Issuer discovery cached across requests in this Worker instance, distinct from
// the per-tenant Durable Object's own store: the control plane verifies inbound
// tokens against its own trust policy.
const discovery = new OidcDiscoveryStore();

type Database = DrizzleD1Database<typeof d1Schema>;

// The bare-host control surface: the control plane's own OAuth issuer, entirely
// separate from every tenant (I3). It mints global-admin tokens and publishes the
// keys that verify them. Returns undefined for a path it does not own, so the
// Worker falls through to a 404.
export async function handleControl(
	request: Request,
	env: Env
): Promise<Response | undefined> {
	const { pathname } = new URL(request.url);
	const read = request.method === 'GET' || request.method === 'HEAD';

	if (request.method === 'POST' && pathname === '/token') {
		return serverErrorResponse(controlTokenExchange(request, env));
	}

	if (request.method === 'POST' && pathname === '/signup') {
		return serverErrorResponse(handleSignup(request, env));
	}

	if (read && pathname === '/.well-known/jwks.json') {
		return serverErrorResponse(controlJwks(env));
	}

	if (read && pathname === '/.well-known/oauth-authorization-server') {
		// Deferred into a promise so a configuration error reaches
		// `serverErrorResponse` as a 503, the same way the exchange fails, rather
		// than advertising an issuer it cannot mint for.
		return serverErrorResponse(
			Promise.resolve().then(() => controlAsMetadata(request, env))
		);
	}

	if (read && pathname === '/control/keys') {
		return serverErrorResponse(controlKeyList(request, env));
	}

	if (request.method === 'POST' && pathname === '/control/keys/rotate') {
		return serverErrorResponse(controlKeyRotate(request, env));
	}

	const retirePrefix = '/control/keys/retire/';

	if (request.method === 'POST' && pathname.startsWith(retirePrefix)) {
		const kid = decodeURIComponent(pathname.slice(retirePrefix.length));

		return serverErrorResponse(controlKeyRetire(request, env, kid));
	}

	return undefined;
}

// RFC 8693 token exchange for the control plane: an external OIDC subject token is
// matched to a control trust rule on its unverified claims, the signature is then
// checked against that rule's issuer JWKS, and only then is a global-admin token
// minted with the control signing key. A forged claim earns no scope.
async function controlTokenExchange(
	request: Request,
	env: Env
): Promise<Response> {
	const wrappingSecret = controlWrappingSecret(env);
	const audience = controlAudience(env);
	const body = await parseFormBody(tokenExchangeRequestSchema, request);

	if (body.grant_type !== tokenExchangeGrantType) {
		throw new UnsupportedGrantTypeError(body.grant_type);
	}

	if (
		body.subject_token_type !== subjectTokenTypeIdToken &&
		body.subject_token_type !== subjectTokenTypeJwt
	) {
		throw new InvalidRequestError(
			`Unsupported subject_token_type: ${body.subject_token_type}`
		);
	}

	const database = controlDatabase(env);

	let claims;

	try {
		claims = decodeInboundClaims(body.subject_token);
	} catch {
		throw new InvalidGrantError('Subject token is not a JWT');
	}

	const rule = matchOidcTrust(await controlTrustRules(database), claims);

	if (rule === undefined) {
		throw new InvalidGrantError(
			'No control trust rule matches the subject token'
		);
	}

	const verified = await verifyControlInbound(rule, body.subject_token);
	const subject =
		typeof verified.sub === 'string' && verified.sub !== ''
			? verified.sub
			: rule.id;
	const now = new Date();

	await ensureControlKey(database, wrappingSecret, now.toISOString());
	const active = await activeControlKey(database, wrappingSecret);
	const accessToken = await mintAccessJwt(
		active.privateJwk,
		{
			issuer: controlIssuer(request),
			audience,
			subject,
			scope: 'admin',
			kid: active.kid,
			ttlSeconds: adminJwtTtlSeconds
		},
		now
	);

	return Response.json(
		{
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: adminJwtTtlSeconds,
			scope: 'admin',
			issued_token_type: issuedAccessTokenType
		} satisfies TokenResponse,
		{ headers: { 'cache-control': 'no-store' } }
	);
}

async function verifyControlInbound(
	rule: OidcTrustRule,
	token: string
): Promise<JWTPayload> {
	// Reaching the issuer is an upstream condition, not a bad token, so a discovery
	// or JWKS-fetch failure is a retryable 503 rather than a permanent
	// `invalid_grant`.
	const issuer = await discovery
		.resolve(rule.issuer)
		.catch((error: unknown) => {
			throw new IssuerUnavailableError(rule.issuer, { cause: error });
		});

	try {
		return await verifyInboundOidcToken(
			issuer.resolver,
			token,
			{
				issuer: rule.issuer,
				audience: rule.audience,
				algorithms: issuer.algorithms
			},
			new Date()
		);
	} catch (error) {
		if (error instanceof OidcKeysUnreachableError) {
			throw new IssuerUnavailableError(rule.issuer, { cause: error });
		}

		throw new InvalidGrantError('Subject token failed verification');
	}
}

async function controlJwks(env: Env): Promise<Response> {
	const database = controlDatabase(env);

	await ensureControlKey(
		database,
		controlWrappingSecret(env),
		new Date().toISOString()
	);

	const verificationKeys = await controlVerificationKeys(database);
	const keys = verificationKeys.map((key) => ({
		...key.publicJwk,
		kid: key.kid,
		alg: 'EdDSA',
		use: 'sig'
	}));

	// Served uncached so a key rotation is visible across colos at once.
	return Response.json({ keys }, { headers: { 'cache-control': 'no-cache' } });
}

function controlAsMetadata(request: Request, env: Env): Response {
	const { origin } = new URL(request.url);
	controlAudience(env);

	return Response.json({
		issuer: controlIssuer(request),
		token_endpoint: `${origin}/token`,
		jwks_uri: `${origin}/.well-known/jwks.json`,
		grant_types_supported: [tokenExchangeGrantType],
		scopes_supported: ['admin'],
		token_endpoint_auth_methods_supported: ['none']
	});
}

// Verifies a control admin bearer token: signed by a live control key, carrying
// the control issuer and audience and the admin scope. Anything else — a missing
// token, a tenant token, the wrong scope — is rejected, so only a control-minted
// admin token drives control operations.
async function requireControlAdmin(request: Request, env: Env): Promise<void> {
	const token = bearerToken(request);

	if (token === undefined) {
		throw new UnauthenticatedError();
	}

	const audience = controlAudience(env);
	const keys = await controlVerificationKeys(controlDatabase(env));
	let scope: string;

	try {
		({ scope } = await verifyAccessJwt(
			keys,
			token,
			{ issuer: controlIssuer(request), audience },
			new Date()
		));
	} catch {
		throw new UnauthenticatedError();
	}

	if (scope !== 'admin') {
		throw new InsufficientScopeError();
	}
}

async function controlKeyList(request: Request, env: Env): Promise<Response> {
	await requireControlAdmin(request, env);
	const keys = await controlKeySummaries(controlDatabase(env));

	return Response.json({ keys }, { headers: { 'cache-control': 'no-store' } });
}

async function controlKeyRotate(request: Request, env: Env): Promise<Response> {
	await requireControlAdmin(request, env);
	const kid = await rotateControlKey(
		controlDatabase(env),
		controlWrappingSecret(env),
		new Date().toISOString()
	);

	return Response.json({ kid }, { headers: { 'cache-control': 'no-store' } });
}

async function controlKeyRetire(
	request: Request,
	env: Env,
	kid: string
): Promise<Response> {
	await requireControlAdmin(request, env);
	const retired = await retireControlKey(
		controlDatabase(env),
		kid,
		new Date().toISOString()
	);

	return Response.json(
		{ kid, retired },
		{ headers: { 'cache-control': 'no-store' } }
	);
}

function controlDatabase(env: Env): Database {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

// The control issuer is the bare-host origin: a real URL, distinct from every
// tenant's path-based issuer, so a control token can never cross-verify as a
// tenant token or the reverse.
function controlIssuer(request: Request): string {
	return new URL(request.url).origin;
}

function controlAudience(env: Env): string {
	const configured: string = env.CUPBOARD_CONTROL_AUDIENCE;

	if (configured === '') {
		throw new ControlNotConfiguredError();
	}

	return configured;
}

function controlWrappingSecret(env: Env): string {
	const secret: string = env.CONTROL_KEY_WRAP_SECRET;

	if (secret === '') {
		throw new ControlNotConfiguredError();
	}

	return secret;
}
