import {
	issuedAccessTokenType,
	subjectTokenTypeIdToken,
	subjectTokenTypeJwt,
	tokenExchangeGrantType,
	tokenExchangeRequestSchema,
	type TokenResponse
} from '@cupboard/protocol/oidc';
import type { ControlCheckReport } from '@cupboard/protocol/reports';
import {
	type ParsedTenantCreateBody,
	type TenantListResponse,
	type TenantMutateResponse,
	type TenantSummary
} from '@cupboard/protocol/tenants';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { JWTPayload } from 'jose';

import {
	adminJwtTtlSeconds,
	bearerToken,
	mintAccessJwt,
	verifyAccessJwt
} from '../auth/auth.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { type AuthorizationServerMetadata } from '../do/auth-keys-service.ts';
import {
	ControlNotConfiguredError,
	InsufficientScopeError,
	InvalidGrantError,
	InvalidRequestError,
	IssuerUnavailableError,
	UnauthenticatedError,
	UnsupportedGrantTypeError
} from '../errors.ts';
import { parseFormBody } from '../http/parse.ts';
import {
	decodeInboundClaims,
	OidcDiscoveryStore,
	OidcKeysUnreachableError,
	verifyInboundOidcToken
} from '../oidc/oidc.ts';
import { matchOidcTrust, type OidcTrustRule } from '../oidc/oidc-trust.ts';
import { tenantServer } from '../routing/durable-object.ts';

import {
	activeControlKey,
	type ControlKeyRotation,
	controlKeySummaries,
	type ControlKeySummary,
	controlVerificationKeys,
	ensureControlKey,
	retireControlKey,
	rotateControlKey
} from './control-key-store.ts';
import { controlTrustRules } from './control-trust.ts';
import {
	invalidateTenantRow,
	rebuildMembershipFilter,
	writeTenantMember
} from './tenant-membership.ts';
import {
	ensureTenant,
	listTenants,
	setTenantStatus
} from './tenant-registry.ts';

// Issuer discovery cached across requests in this Worker instance, distinct from
// the per-tenant Durable Object's own store: the control plane verifies inbound
// tokens against its own trust policy.
const discovery = new OidcDiscoveryStore();

type Database = DrizzleD1Database<typeof d1Schema>;

// RFC 8693 token exchange for the control plane: an external OIDC subject token is
// matched to a control trust rule on its unverified claims, the signature is then
// checked against that rule's issuer JWKS, and only then is a global-admin token
// minted with the control signing key. A forged claim earns no scope.
export async function controlTokenExchange(
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

/** The key set verifying control-minted admin tokens, as a JWKS document. */
export async function controlJwks(env: Env): Promise<{
	keys: (JsonWebKey & { kid: string; alg: string; use: string })[];
}> {
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

	return { keys };
}

export function controlAsMetadata(
	request: Request,
	env: Env
): AuthorizationServerMetadata {
	const { origin } = new URL(request.url);
	controlAudience(env);

	return {
		issuer: controlIssuer(request),
		token_endpoint: `${origin}/token`,
		jwks_uri: `${origin}/.well-known/jwks.json`,
		grant_types_supported: [tokenExchangeGrantType],
		scopes_supported: ['admin'],
		token_endpoint_auth_methods_supported: ['none']
	};
}

// Verifies a control admin bearer token: signed by a live control key, carrying
// the control issuer and audience and the admin scope. Anything else — a missing
// token, a tenant token, the wrong scope — is rejected, so only a control-minted
// admin token drives control operations.
export async function requireControlAdmin(
	request: Request,
	env: Env
): Promise<void> {
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

// The admin-gated deployment check: diagnostics only the deployment itself
// can perform, starting with whether its R2 credentials sign requests R2
// accepts. The credentials live on the tenant script, so a tenant's Durable
// Object answers; the bindings are script-wide, so any live tenant's object
// speaks for the deployment, and with none there is nowhere to run the probe.
// The admin-gated deployment check: diagnostics only the deployment itself
// can perform, starting with whether its R2 credentials sign requests R2
// accepts. The credentials live on the tenant script, so a tenant's Durable
// Object answers; the bindings are script-wide, so any live tenant's object
// speaks for the deployment, and with none there is nowhere to run the probe.
export async function controlCheck(env: Env): Promise<ControlCheckReport> {
	const tenants = await listTenants(controlDatabase(env));
	const live = tenants.find((tenant) => tenant.status !== 'offboarded');

	const r2 =
		live === undefined
			? ({ result: 'no-tenant' } as const)
			: await tenantServer(env, live.id).checkR2();

	return { r2 };
}

export async function controlKeys(
	env: Env
): Promise<{ keys: ControlKeySummary[] }> {
	return { keys: await controlKeySummaries(controlDatabase(env)) };
}

export function controlKeyRotate(env: Env): Promise<ControlKeyRotation> {
	return rotateControlKey(
		controlDatabase(env),
		controlWrappingSecret(env),
		new Date().toISOString()
	);
}

export async function controlKeyRetire(
	env: Env,
	kid: string
): Promise<{ kid: string; retired: boolean }> {
	const retired = await retireControlKey(
		controlDatabase(env),
		kid,
		new Date().toISOString()
	);

	return { kid, retired };
}

export async function controlTenantList(env: Env): Promise<TenantListResponse> {
	return { tenants: await listTenants(controlDatabase(env)) };
}

export async function controlTenantCreate(
	env: Env,
	body: ParsedTenantCreateBody,
	origin: string,
	rebuildFilter: (env: Env) => Promise<void> = rebuildMembershipFilter
): Promise<TenantSummary> {
	const database = controlDatabase(env);

	// Provision in order: write the authoritative row, configure the Durable Object,
	// write the tenant's membership marker, then publish the rebuilt filter. Each
	// step is idempotent, so a retry after a mid-provision failure replays cleanly
	// rather than stranding an admitted-but-unconfigured tenant.
	const summary = await ensureTenant(database, body, new Date().toISOString());
	const issuer = `${origin}/t/${summary.id}`;

	await tenantServer(env, summary.id).configure({
		tenant: summary.id,
		issuer,
		audience: issuer,
		ownerIssuer: summary.ownerIssuer,
		ownerSubject: summary.ownerSubject,
		ownerAudience: summary.ownerAudience,
		configVersion: summary.configVersion
	});
	await writeTenantMember(env.TENANT_CACHE, summary.id);
	await invalidateTenantRow(summary.id);

	// Publish the rebuilt filter so the new tenant is admittable within the filter
	// cache TTL. A filter negative is definitive, so the create must not report
	// success while leaving the tenant inadmissible until the hourly cron: if the
	// filter cannot publish, the create fails and the caller retries. The row and
	// marker already persist, so the retry (or the cron) recovers cleanly.
	await rebuildFilter(env);

	return summary;
}

export async function controlTenantSuspend(
	env: Env,
	id: string
): Promise<TenantMutateResponse> {
	const database = controlDatabase(env);
	const summary = await setTenantStatus(database, id, 'suspended');
	await invalidateTenantRow(id);

	return { id: summary.id, status: summary.status };
}

export async function controlTenantOffboard(
	env: Env,
	id: string
): Promise<TenantMutateResponse> {
	const database = controlDatabase(env);
	const summary = await setTenantStatus(database, id, 'offboarding');
	await invalidateTenantRow(id);

	// The membership marker is left in place: an offboarding tenant is still
	// `status != 'offboarded'`, so it stays admittable to the authoritative status
	// read, which stops its writes and 404s its reads. Finalisation deletes the
	// marker once the drain completes.
	//
	// Tell the Durable Object it is offboarding so an in-flight commit settling after
	// the status flip cannot re-materialise an object the drain will remove.
	if (summary.status === 'offboarding') {
		await tenantServer(env, id).beginOffboard();
	}

	return { id: summary.id, status: summary.status };
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

// The token-minting configuration. The generated Env types these as `string`,
// but a deployment that never set the var (or never put the secret) has no
// binding at all and the env reads as undefined; both spellings of "not
// configured" must refuse.
interface ControlMintConfig {
	readonly CUPBOARD_CONTROL_AUDIENCE: string | undefined;
	readonly CONTROL_KEY_WRAP_SECRET: string | undefined;
}

function controlAudience(env: ControlMintConfig): string {
	const configured = env.CUPBOARD_CONTROL_AUDIENCE ?? '';

	if (configured === '') {
		throw new ControlNotConfiguredError();
	}

	return configured;
}

function controlWrappingSecret(env: ControlMintConfig): string {
	const secret = env.CONTROL_KEY_WRAP_SECRET ?? '';

	if (secret === '') {
		throw new ControlNotConfiguredError();
	}

	return secret;
}
