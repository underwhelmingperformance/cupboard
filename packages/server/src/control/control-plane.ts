import { type TenantId } from '@cupboard/nix-store/scalars';
import {
	issuedAccessTokenType,
	subjectTokenTypeIdToken,
	subjectTokenTypeJwt,
	tokenExchangeGrantType,
	tokenExchangeRequestSchema,
	type TokenResponse
} from '@cupboard/protocol/oidc';
import {
	type OidcTrustListResponse,
	type OidcTrustRemoveResponse,
	type OidcTrustSummary,
	type ParsedOidcTrustAddBody
} from '@cupboard/protocol/oidc';
import type { ControlCheckReport } from '@cupboard/protocol/reports';
import {
	type MembershipRebuildResponse,
	type ParsedTenantCreateBody,
	type ParsedTenantReadCredential,
	type TenantListResponse,
	type TenantMutateResponse,
	type TenantReadModeResponse,
	type TenantSummary
} from '@cupboard/protocol/tenants';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { JWTPayload } from 'jose';

import {
	type AccessClaims,
	adminJwtTtlSeconds,
	bearerToken,
	issueAccessJwt,
	verifyAccessJwt,
	writeJwtTtlSeconds
} from '../auth/auth.ts';
import {
	attenuatedGrants,
	parseRequestedGrants,
	resolveRequestedGrants
} from '../authz/issuance.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { type AuthorizationServerMetadata } from '../do/auth-keys-service.ts';
import {
	ControlNotConfiguredError,
	ControlSubjectTokenUntrustedError,
	IssuerUnavailableError,
	SubjectTokenNotJwtError,
	SubjectTokenVerificationFailedError,
	UnauthenticatedError,
	UnsupportedGrantTypeError,
	UnsupportedSubjectTokenTypeError
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
import {
	addControlTrust,
	controlTrustRules,
	getControlTrust,
	listControlTrust,
	removeControlTrust
} from './control-trust.ts';
import {
	invalidateTenantRow,
	rebuildMembershipFilter,
	refreshTenantMembership,
	writeTenantMember
} from './tenant-membership.ts';
import {
	clearTenantReadCredential,
	ensureTenant,
	listTenants,
	resumeTenant,
	setTenantReadCredential,
	setTenantReadMode,
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
// issued with the control signing key. A forged claim earns no scope.
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

	const database = controlDatabase(env);
	const now = new Date();

	// Attenuation is detected by signature: a subject token this control plane
	// itself issued is narrowed to a requested subset of its own grants, never
	// routed to a trust rule.
	const presented = await verifyControlSelfIssued(
		request,
		env,
		body.subject_token
	);

	if (presented !== undefined) {
		await ensureControlKey(database, wrappingSecret, now.toISOString());
		const active = await activeControlKey(database, wrappingSecret);
		const granted = attenuatedGrants(
			presented.grants,
			parseRequestedGrants(body.authorization_details)
		);
		const accessToken = await issueAccessJwt(
			active.privateJwk,
			{
				issuer: controlIssuer(request),
				audience,
				subject: presented.subject,
				grants: granted,
				kid: active.kid,
				ttlSeconds: writeJwtTtlSeconds
			},
			now
		);

		return Response.json(
			{
				access_token: accessToken,
				token_type: 'Bearer',
				expires_in: writeJwtTtlSeconds,
				issued_token_type: issuedAccessTokenType,
				authorization_details: granted
			} satisfies TokenResponse,
			{ headers: { 'cache-control': 'no-store' } }
		);
	}

	if (
		body.subject_token_type !== subjectTokenTypeIdToken &&
		body.subject_token_type !== subjectTokenTypeJwt
	) {
		throw new UnsupportedSubjectTokenTypeError(body.subject_token_type);
	}

	let claims;

	try {
		claims = decodeInboundClaims(body.subject_token);
	} catch {
		throw new SubjectTokenNotJwtError();
	}

	const rule = matchOidcTrust(await controlTrustRules(database), claims);

	if (rule === undefined) {
		throw new ControlSubjectTokenUntrustedError();
	}

	const verified = await verifyControlInbound(rule, body.subject_token);
	const subject =
		typeof verified.sub === 'string' && verified.sub !== ''
			? verified.sub
			: rule.id;

	await ensureControlKey(database, wrappingSecret, now.toISOString());
	const active = await activeControlKey(database, wrappingSecret);
	const grants = resolveRequestedGrants(
		rule,
		verified,
		parseRequestedGrants(body.authorization_details)
	);
	const accessToken = await issueAccessJwt(
		active.privateJwk,
		{
			issuer: controlIssuer(request),
			audience,
			subject,
			grants,
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
			issued_token_type: issuedAccessTokenType,
			authorization_details: grants
		} satisfies TokenResponse,
		{ headers: { 'cache-control': 'no-store' } }
	);
}

// Verifies a subject token against the control plane's own keys. A token that
// verifies is one the control plane issued, so the exchange attenuates it;
// anything else returns undefined and routes to the trust-rule path, so the
// branch cannot be chosen by a client-declared type.
async function verifyControlSelfIssued(
	request: Request,
	env: Env,
	token: string
): Promise<AccessClaims | undefined> {
	const keys = await controlVerificationKeys(controlDatabase(env));

	try {
		return await verifyAccessJwt(
			keys,
			token,
			{ issuer: controlIssuer(request), audience: controlAudience(env) },
			new Date()
		);
	} catch {
		return undefined;
	}
}

async function verifyControlInbound(
	rule: OidcTrustRule,
	token: string
): Promise<JWTPayload> {
	// Reaching the issuer is an upstream condition, not a bad token, so a discovery
	// or JWKS-fetch failure is a retryable 503.
	let issuer;
	try {
		issuer = await discovery.resolve(rule.issuer);
	} catch (error: unknown) {
		throw new IssuerUnavailableError(rule.issuer, { cause: error });
	}

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

		throw new SubjectTokenVerificationFailedError();
	}
}

/** The key set verifying control-issued admin tokens, as a JWKS document. */
export async function controlJwks(env: Env): Promise<{
	keys: (JsonWebKey & { kid: string; alg: string; use: string })[];
}> {
	const database = controlDatabase(env);

	const now = new Date();
	await ensureControlKey(
		database,
		controlWrappingSecret(env),
		now.toISOString()
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
		authorization_details_types_supported: [
			'cupboard_tenant',
			'cupboard_control',
			'cupboard_wildcard'
		],
		token_endpoint_auth_methods_supported: ['none']
	};
}

// Authenticates a control bearer token: signed by a live control key and
// carrying the control issuer and audience. A missing token, a tenant token, or
// a bad signature is rejected. The grants it carries decide what it may do; the
// router authorises each operation against them.
export async function controlAuthenticate(
	request: Request,
	env: Env
): Promise<AccessClaims> {
	const token = bearerToken(request);

	if (token === undefined) {
		throw new UnauthenticatedError();
	}

	const audience = controlAudience(env);
	const keys = await controlVerificationKeys(controlDatabase(env));

	try {
		return await verifyAccessJwt(
			keys,
			token,
			{ issuer: controlIssuer(request), audience },
			new Date()
		);
	} catch {
		throw new UnauthenticatedError();
	}
}

// The admin-gated deployment check: diagnostics only the deployment itself can
// perform. Readiness comes first: whether the control database answers, since a
// deploy cannot trust the version probe alone (a prior Worker version may serve
// it before the new version's D1 binding is live). Then whether the R2
// credentials sign requests R2 accepts. The credentials live on the tenant
// script, so a tenant's Durable Object answers; the bindings are script-wide, so
// any live tenant's object speaks for the deployment, and with none there is
// nowhere to run the probe.
export async function controlCheck(env: Env): Promise<ControlCheckReport> {
	const databaseCheck = await controlDatabaseCheck(env);

	// Without a working control database there is no tenant registry to read, so
	// the R2 probe has nowhere to run; the database verdict stands alone.
	if (databaseCheck.result === 'error') {
		return { db: databaseCheck, r2: { result: 'no-tenant' } };
	}

	const tenants = await listTenants(controlDatabase(env));
	const live = tenants.find((tenant) => tenant.status !== 'offboarded');

	const r2 =
		live === undefined
			? ({ result: 'no-tenant' } as const)
			: await tenantServer(env, live.id).checkR2();

	return { db: databaseCheck, r2 };
}

// Whether the control database answers a trivial read against a core table, so a
// reachable-but-unmigrated binding reads as not ready.
async function controlDatabaseCheck(
	env: Env
): Promise<ControlCheckReport['db']> {
	try {
		await env.CUPBOARD_DB.prepare('SELECT 1 FROM global_admin LIMIT 1').first();

		return { result: 'ok' };
	} catch {
		return { result: 'error' };
	}
}

export async function controlKeys(
	env: Env
): Promise<{ keys: ControlKeySummary[] }> {
	return { keys: await controlKeySummaries(controlDatabase(env)) };
}

export function controlKeyRotate(env: Env): Promise<ControlKeyRotation> {
	const now = new Date();
	return rotateControlKey(
		controlDatabase(env),
		controlWrappingSecret(env),
		now.toISOString()
	);
}

export async function controlKeyRetire(
	env: Env,
	kid: string
): Promise<{ kid: string; retired: boolean }> {
	const now = new Date();
	const isRetired = await retireControlKey(
		controlDatabase(env),
		kid,
		now.toISOString()
	);

	return { kid, retired: isRetired };
}

export async function controlTenantList(env: Env): Promise<TenantListResponse> {
	return { tenants: await listTenants(controlDatabase(env)) };
}

// Reasserts every live tenant's admission marker and rebuilds the filter from the
// registry, reporting how many tenants the gate now carries. The deploy runs this
// so a change to the admission representation does not leave existing tenants
// inadmissible until the hourly cron; it is the membership half of a cron tick,
// with none of the tick's data-touching reclamation.
export async function controlMembershipRebuild(
	env: Env
): Promise<MembershipRebuildResponse> {
	return { tenants: await refreshTenantMembership(env) };
}

export function controlOidcTrustList(env: Env): Promise<OidcTrustListResponse> {
	return listControlTrust(controlDatabase(env));
}

export function controlOidcTrustGet(
	env: Env,
	id: string
): Promise<OidcTrustSummary> {
	return getControlTrust(controlDatabase(env), id);
}

export function controlOidcTrustAdd(
	env: Env,
	body: ParsedOidcTrustAddBody
): Promise<OidcTrustSummary> {
	const now = new Date();
	return addControlTrust(controlDatabase(env), body, now.toISOString());
}

export function controlOidcTrustRemove(
	env: Env,
	id: string
): Promise<OidcTrustRemoveResponse> {
	const now = new Date();
	return removeControlTrust(controlDatabase(env), id, now.toISOString());
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
	// avoiding an admitted-but-unconfigured tenant.
	const now = new Date();
	const summary = await ensureTenant(database, body, now.toISOString());
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
	id: TenantId
): Promise<TenantMutateResponse> {
	const database = controlDatabase(env);
	const summary = await setTenantStatus(database, id, 'suspended');
	await invalidateTenantRow(id);

	return { id: summary.id, status: summary.status };
}

export async function controlTenantResume(
	env: Env,
	id: TenantId
): Promise<TenantMutateResponse> {
	const summary = await resumeTenant(controlDatabase(env), id);
	await invalidateTenantRow(id);

	return { id: summary.id, status: summary.status };
}

export async function controlTenantSetReadMode(
	env: Env,
	id: TenantId,
	readMode: 'public' | 'private'
): Promise<TenantReadModeResponse> {
	const summary = await setTenantReadMode(controlDatabase(env), id, readMode);
	await invalidateTenantRow(id);

	return { id: summary.id, readMode: summary.readMode };
}

export async function controlTenantRotateReadCredential(
	env: Env,
	id: TenantId,
	read: ParsedTenantReadCredential
): Promise<TenantReadModeResponse> {
	const summary = await setTenantReadCredential(controlDatabase(env), id, read);
	await invalidateTenantRow(id);

	return { id: summary.id, readMode: summary.readMode };
}

export async function controlTenantClearReadCredential(
	env: Env,
	id: TenantId
): Promise<TenantReadModeResponse> {
	const summary = await clearTenantReadCredential(controlDatabase(env), id);
	await invalidateTenantRow(id);

	return { id: summary.id, readMode: summary.readMode };
}

export async function controlTenantOffboard(
	env: Env,
	id: TenantId
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
	const url = new URL(request.url);
	return url.origin;
}

// The token-issuing configuration. The generated Env types these as `string`,
// but a deployment that never set the var (or never put the secret) has no
// binding at all and the env reads as undefined; both spellings of "not
// configured" must refuse.
interface ControlIssueConfig {
	readonly CUPBOARD_CONTROL_AUDIENCE: string | undefined;
	readonly CONTROL_KEY_WRAP_SECRET: string | undefined;
}

function controlAudience(env: ControlIssueConfig): string {
	const configured = env.CUPBOARD_CONTROL_AUDIENCE ?? '';

	if (configured === '') {
		throw new ControlNotConfiguredError();
	}

	return configured;
}

function controlWrappingSecret(env: ControlIssueConfig): string {
	const secret = env.CONTROL_KEY_WRAP_SECRET ?? '';

	if (secret === '') {
		throw new ControlNotConfiguredError();
	}

	return secret;
}
