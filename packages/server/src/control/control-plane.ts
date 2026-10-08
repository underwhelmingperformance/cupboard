import { type Logger } from '@cupboard/logger';
import {
	type AuthKeyId,
	type CacheScope,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import {
	type ConfiguredInstanceSummary,
	type InstanceName,
	type InstanceSummary
} from '@cupboard/protocol/instance';
import {
	issuedAccessTokenType,
	type OidcAudience,
	oidcAudienceSchema,
	type OidcIssuer,
	oidcIssuerSchema,
	type OidcSubject,
	oidcSubjectSchema,
	refreshTokenGrantRequestSchema,
	refreshTokenGrantType,
	subjectTokenTypeIdToken,
	tokenExchangeGrantRequestSchema,
	tokenExchangeGrantType,
	tokenRequestSchema,
	type TokenResponse,
	tokenRevocationRequestSchema
} from '@cupboard/protocol/oidc';
import {
	type OidcTrustAddBody,
	type OidcTrustListResponse,
	type OidcTrustRemoveResponse,
	type OidcTrustSummary,
	type TrustRuleId
} from '@cupboard/protocol/oidc';
import {
	hasMatchingOidcTrustIdentity,
	type OidcTrustRule,
	oidcTrustVerificationTarget,
	trustedAudiences,
	type VerifiedOidcClaims
} from '@cupboard/protocol/oidc-trust-match';
import {
	type OidcTrustSelection,
	selectOidcTrust
} from '@cupboard/protocol/oidc-trust-selection';
import type { ControlCheckReport } from '@cupboard/protocol/reports';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type RefreshSessionId,
	type RefreshSessionListResponseInput,
	type RefreshSessionRevokeResponseInput
} from '@cupboard/protocol/sessions';
import {
	type CacheReadCredentialResponse,
	type MembershipRebuildResponse,
	type TenantCreateBody,
	type TenantListResponse,
	type TenantMutateResponse,
	type TenantQuota,
	type TenantQuotaResponse,
	type TenantReadCredential,
	type TenantReadCredentialResponse,
	type TenantSummary
} from '@cupboard/protocol/tenants';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	type AccessClaims,
	adminJwtTtlSeconds,
	bearerToken,
	issueAccessJwt,
	verifyAccessJwt
} from '../auth/auth.ts';
import { RefreshCredential } from '../auth/refresh-credential.ts';
import {
	issueAttenuatedAccessToken,
	parseRequestedGrants,
	resolveRequestedGrants
} from '../authz/issuance.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { type AuthorizationServerMetadata } from '../do/auth-keys-service.ts';
import {
	ControlNotConfiguredError,
	ControlSubjectTokenUntrustedError,
	InvalidAccessTokenError,
	InvalidAuthorizationDetailsError,
	OidcIssuerTransportRequiredError,
	RefreshTokenRequiredError,
	SubjectTokenNotJwtError,
	SubjectTokenRequiredError,
	SubjectTokenVerificationFailedError,
	UnauthenticatedError,
	UnsupportedGrantTypeError,
	UnsupportedSubjectTokenTypeError,
	UnsupportedTokenTypeError
} from '../errors.ts';
import {
	oauthEmptyResponse,
	oauthJsonResponse
} from '../http/oauth-response.ts';
import { parseFormBody, parseFormValue } from '../http/parse.ts';
import { isAudienceBound } from '../oidc/audience-binding.ts';
import { InboundTokenVerifier } from '../oidc/inbound-verifier.ts';
import {
	canUseLoopbackHttp,
	isAllowedIssuerTransport
} from '../oidc/issuer-policy.ts';
import { decodeInboundClaims, OidcDiscoveryStore } from '../oidc/oidc.ts';
import {
	type SubjectBinding,
	subjectBinding,
	subjectTokenLimits
} from '../oidc/subject-binding.ts';
import { tenantServer } from '../routing/durable-object.ts';

import {
	activeControlKey,
	type ControlKeyRotation,
	controlKeySummaries,
	type ControlKeySummary,
	controlVerificationKeys,
	didRetireControlKey,
	ensureControlKey,
	rotateControlKey
} from './control-key-store.ts';
import { ControlRefreshSessions } from './control-refresh-sessions.ts';
import { recordControlSubjectNonce } from './control-subject-nonces.ts';
import {
	addControlTrust,
	controlTrustRuleSnapshots,
	getControlTrust,
	listControlTrust,
	removeControlTrust
} from './control-trust.ts';
import {
	initialiseInstanceConfig,
	readInstanceConfig
} from './instance-config.ts';
import {
	invalidateTenantRow,
	rebuildMembershipFilter,
	refreshTenantMembership,
	writeTenantMember
} from './tenant-membership.ts';
import {
	clearCacheReadCredential,
	clearTenantReadCredential,
	ensureTenant,
	getTenantQuota,
	listTenants,
	resumeTenant,
	setCacheReadCredential,
	setTenantQuota,
	setTenantReadCredential,
	setTenantStatus
} from './tenant-registry.ts';

// Issuer discovery cached across requests in this Worker instance, distinct from
// the per-tenant Durable Object's own store: the control plane verifies inbound
// tokens against its own trust policy.
const verifier = new InboundTokenVerifier(new OidcDiscoveryStore());
const localDevelopmentVerifier = new InboundTokenVerifier(
	new OidcDiscoveryStore({ canUseLoopbackHttp: true })
);

type Database = DrizzleD1Database<typeof d1Schema>;

export async function controlInstance(env: Env): Promise<InstanceSummary> {
	return (
		(await readInstanceConfig(controlDatabase(env))) ?? {
			state: 'unconfigured'
		}
	);
}

export function controlInstanceInitialise(
	env: Env,
	name: InstanceName
): Promise<ConfiguredInstanceSummary> {
	return initialiseInstanceConfig(
		controlDatabase(env),
		name,
		isoTimestamp(new Date())
	);
}

// RFC 8693 token exchange for the control plane: the unverified claims of an
// external OIDC ID token choose a configured issuer and audience, the
// signature is checked against that issuer's JWKS, a control trust rule is
// selected from the verified claims and requested grants, and only then is a
// global-admin token issued with the control signing key. An exchange
// receives a refresh token unless its verified audience is the deployment URL.
// A subject token whose signature does not verify against the configured issuer
// is refused, whatever its claims are.
// The refresh grant renews a session while the control trust rules still
// select its identity.
export async function controlTokenExchange(
	request: Request,
	env: Env,
	logger: Logger
): Promise<Response> {
	const body = await parseFormBody(tokenRequestSchema, request);

	if (body.grant_type === refreshTokenGrantType) {
		if (body.refresh_token === undefined) {
			throw new RefreshTokenRequiredError();
		}

		return oauthJsonResponse(
			await controlRefreshSessions(request, env).refresh(
				logger,
				parseFormValue(refreshTokenGrantRequestSchema, body)
			)
		);
	}

	if (body.grant_type !== tokenExchangeGrantType) {
		throw new UnsupportedGrantTypeError(body.grant_type);
	}

	if (body.subject_token === undefined) {
		throw new SubjectTokenRequiredError();
	}

	const exchange = parseFormValue(tokenExchangeGrantRequestSchema, body);

	if (
		exchange.subject_token_type !== subjectTokenTypeIdToken &&
		exchange.subject_token_type !== issuedAccessTokenType
	) {
		throw new UnsupportedSubjectTokenTypeError(exchange.subject_token_type);
	}

	const wrappingSecret = controlWrappingSecret(env);
	const audience = controlAudience(env);

	const database = controlDatabase(env);
	const now = new Date();

	// Signature verification distinguishes a self-issued access token from an
	// external subject. It can enter attenuation only when it declares the
	// access-token type, and it is never routed to a trust rule.
	const presented = await verifyControlSelfIssued(
		request,
		env,
		exchange.subject_token
	);

	if (presented !== undefined) {
		if (exchange.subject_token_type !== issuedAccessTokenType) {
			throw new UnsupportedSubjectTokenTypeError(exchange.subject_token_type);
		}

		await ensureControlKey(database, wrappingSecret, isoTimestamp(now));
		const active = await activeControlKey(database, wrappingSecret);
		const response = await issueAttenuatedAccessToken(
			{
				privateJwk: active.privateJwk,
				kid: active.kid,
				issuer: controlIssuer(request),
				audience,
				presented,
				requested: parseRequestedGrants(exchange.authorization_details)
			},
			now
		);

		return oauthJsonResponse(response);
	}

	if (exchange.subject_token_type !== subjectTokenTypeIdToken) {
		throw new UnsupportedSubjectTokenTypeError(exchange.subject_token_type);
	}

	let claims;

	try {
		claims = decodeInboundClaims(exchange.subject_token);
	} catch {
		throw new SubjectTokenNotJwtError();
	}

	const canUseHttpLoopback = canUseLoopbackHttp(env);
	const snapshots = await controlTrustRuleSnapshots(
		database,
		canUseHttpLoopback
	);
	const rules = snapshots.map(({ rule }) => rule);
	const target = oidcTrustVerificationTarget(rules, claims);

	if (target === undefined || !hasMatchingOidcTrustIdentity(rules, claims)) {
		throw new ControlSubjectTokenUntrustedError();
	}

	const verified = await (
		canUseHttpLoopback ? localDevelopmentVerifier : verifier
	).verify(
		target,
		exchange.subject_token,
		trustedAudiences(rules, target.issuer),
		subjectTokenLimits(exchange)
	);
	const binding = await subjectBinding(
		verified,
		controlIssuer(request),
		exchange
	);

	return oauthJsonResponse(
		await issueControlSession(request, env, {
			verified,
			binding,
			rules,
			requested: parseRequestedGrants(exchange.authorization_details)
		})
	);
}

interface ControlSessionRequest {
	readonly verified: VerifiedOidcClaims;
	readonly binding: SubjectBinding;
	readonly rules: readonly OidcTrustRule[];
	readonly requested: AuthorizationDetails | undefined;
}

/**
 * Issues a control access token to a verified external identity that the
 * control trust rules select, with a refresh token unless the verified
 * audience is the deployment URL. The nonce of a nonce-bound token is recorded
 * as consumed in the batch that creates the refresh family, or on its own when
 * there is no family. A later use of the same nonce-bound token is refused.
 */
export async function issueControlSession(
	request: Request,
	env: Env,
	{ verified, binding, rules, requested }: ControlSessionRequest
): Promise<TokenResponse> {
	const selection = selectOidcTrust(rules, verified, requested);

	switch (selection.outcome) {
		case 'authority-unmatched': {
			throw new InvalidAuthorizationDetailsError('not-permitted');
		}
		case 'identity-unmatched':
		case 'ambiguous': {
			throw new ControlSubjectTokenUntrustedError();
		}
		case 'selected': {
			break;
		}
	}

	const verifiedSubject =
		typeof verified.sub === 'string' && verified.sub !== ''
			? verified.sub
			: undefined;

	if (verifiedSubject === undefined) {
		throw new SubjectTokenVerificationFailedError();
	}

	if (selection.grants === undefined && selection.rule === undefined) {
		throw new ControlSubjectTokenUntrustedError();
	}

	const subject = oidcSubjectSchema.parse(verifiedSubject);
	const grants =
		selection.grants ??
		(selection.rule === undefined
			? []
			: resolveRequestedGrants(selection.rule, verified, requested));
	const accessToken = await issueControlAccessToken(
		request,
		env,
		selection.rule,
		subject,
		grants
	);

	const nonce = binding.kind === 'nonce-bound' ? binding.nonce : undefined;
	// A CI job exchanges a new token from its provider whenever it needs one,
	// so only an exchange that is not bound to this deployment's URL starts a
	// session.
	const sessions = controlRefreshSessions(request, env);
	const session = isAudienceBound(verified, controlIssuer(request))
		? undefined
		: await sessions.create(verified, subject, selection.rule, grants, nonce);

	if (session === undefined && nonce !== undefined) {
		await recordControlSubjectNonce(controlDatabase(env), nonce);
	}

	const current = await selectControlTrust(env, verified, grants);

	if (current.outcome !== 'selected') {
		if (session !== undefined) {
			await sessions.revoke(session.familyId);
		}

		throw new ControlSubjectTokenUntrustedError();
	}

	return {
		access_token: accessToken,
		token_type: 'Bearer',
		expires_in: adminJwtTtlSeconds,
		issued_token_type: issuedAccessTokenType,
		...(session !== undefined && { refresh_token: session.refreshToken }),
		authorization_details: grants
	};
}

export async function controlRevoke(
	request: Request,
	env: Env,
	logger: Logger
): Promise<Response> {
	const body = await parseFormBody(tokenRevocationRequestSchema, request);
	const presented = RefreshCredential.parse(body.token);

	if (presented !== undefined) {
		await controlRefreshSessions(request, env).revokePresented(
			logger,
			presented
		);
		return oauthEmptyResponse();
	}

	if ((await verifyControlSelfIssued(request, env, body.token)) !== undefined) {
		throw new UnsupportedTokenTypeError();
	}

	return oauthEmptyResponse();
}

export function controlSessionList(
	request: Request,
	env: Env
): Promise<RefreshSessionListResponseInput> {
	return controlRefreshSessions(request, env).list();
}

export function controlSessionRevoke(
	request: Request,
	env: Env,
	id: RefreshSessionId
): Promise<RefreshSessionRevokeResponseInput> {
	return controlRefreshSessions(request, env).revoke(id);
}

function controlRefreshSessions(
	request: Request,
	env: Env
): ControlRefreshSessions {
	const database = controlDatabase(env);

	return new ControlRefreshSessions({
		database,
		keys: { kind: 'control', wrappingSecret: controlWrappingSecret(env) },
		selectPolicy: (identity, grants) =>
			selectControlTrust(env, identity, grants),
		issueAccessToken: (rule, subject, grants) =>
			issueControlAccessToken(request, env, rule, subject, grants)
	});
}

async function selectControlTrust(
	env: Env,
	identity: VerifiedOidcClaims,
	grants: AuthorizationDetails
): Promise<OidcTrustSelection> {
	const snapshots = await controlTrustRuleSnapshots(
		controlDatabase(env),
		canUseLoopbackHttp(env)
	);

	return selectOidcTrust(
		snapshots.map(({ rule }) => rule),
		identity,
		grants
	);
}

async function issueControlAccessToken(
	request: Request,
	env: Env,
	rule: OidcTrustRule | undefined,
	subject: OidcSubject,
	grants: AuthorizationDetails
): Promise<string> {
	const database = controlDatabase(env);
	const wrappingSecret = controlWrappingSecret(env);
	const now = new Date();

	await ensureControlKey(database, wrappingSecret, isoTimestamp(now));
	const active = await activeControlKey(database, wrappingSecret);

	return issueAccessJwt(
		active.privateJwk,
		{
			issuer: controlIssuer(request),
			audience: controlAudience(env),
			subject,
			grants,
			kid: active.kid,
			ttlSeconds: adminJwtTtlSeconds,
			auditClaims: rule === undefined ? {} : { cb_rule: rule.id }
		},
		now
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

export async function controlJwks(env: Env): Promise<{
	keys: (JsonWebKey & { kid: string; alg: string; use: string })[];
}> {
	const database = controlDatabase(env);

	const now = new Date();
	await ensureControlKey(
		database,
		controlWrappingSecret(env),
		isoTimestamp(now)
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
		response_types_supported: [],
		grant_types_supported: [tokenExchangeGrantType, refreshTokenGrantType],
		authorization_details_types_supported: [
			'cupboard_tenant',
			'cupboard_control',
			'cupboard_wildcard'
		],
		token_endpoint_auth_methods_supported: ['none'],
		revocation_endpoint: `${origin}/revoke`,
		revocation_endpoint_auth_methods_supported: ['none']
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
		throw new InvalidAccessTokenError();
	}
}

// The admin-gated deployment check covers diagnostics that only the deployment
// itself can perform. Readiness comes first: whether the control database responds, since a
// deploy cannot trust the version probe alone (a prior Worker version may serve
// it before the new version's D1 binding is live). Then whether R2 accepts
// requests signed with the configured credentials. Those credentials live on
// the tenant script, so a tenant's Durable Object runs that probe. The
// bindings are script-wide, so any live tenant's object gives the same result
// for the whole deployment, and if no tenant is live the probe cannot run.
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
		isoTimestamp(now)
	);
}

export async function controlKeyRetire(
	env: Env,
	kid: AuthKeyId
): Promise<{ kid: AuthKeyId; retired: boolean }> {
	const now = new Date();
	const isRetired = await didRetireControlKey(
		controlDatabase(env),
		kid,
		isoTimestamp(now)
	);

	return { kid, retired: isRetired };
}

export async function controlTenantList(env: Env): Promise<TenantListResponse> {
	return { tenants: await listTenants(controlDatabase(env)) };
}

// The deploy reasserts every live tenant's membership marker and rebuilds the
// filter after an admission-format change. This avoids waiting for scheduled
// maintenance before existing tenants become reachable through the new format.
export async function controlMembershipRebuild(
	env: Env
): Promise<MembershipRebuildResponse> {
	return { tenants: await refreshTenantMembership(env) };
}

export function controlOidcTrustList(env: Env): Promise<OidcTrustListResponse> {
	return listControlTrust(controlDatabase(env), canUseLoopbackHttp(env));
}

export function controlOidcTrustGet(
	env: Env,
	id: TrustRuleId
): Promise<OidcTrustSummary> {
	return getControlTrust(controlDatabase(env), id, canUseLoopbackHttp(env));
}

export function controlOidcTrustAdd(
	env: Env,
	body: OidcTrustAddBody
): Promise<OidcTrustSummary> {
	const now = new Date();
	return addControlTrust(
		controlDatabase(env),
		body,
		isoTimestamp(now),
		canUseLoopbackHttp(env)
	);
}

export function controlOidcTrustRemove(
	env: Env,
	id: TrustRuleId
): Promise<OidcTrustRemoveResponse> {
	const now = new Date();
	return removeControlTrust(controlDatabase(env), id, isoTimestamp(now));
}

export async function controlTenantCreate(
	env: Env,
	body: TenantCreateBody,
	origin: string,
	rebuildFilter: (env: Env) => Promise<void> = rebuildMembershipFilter
): Promise<TenantSummary> {
	if (!isAllowedIssuerTransport(body.ownerIssuer, canUseLoopbackHttp(env))) {
		throw new OidcIssuerTransportRequiredError(body.ownerIssuer);
	}

	const database = controlDatabase(env);

	// Provision in order: write the authoritative row, configure the Durable
	// Object, write the tenant's membership marker, then publish the rebuilt
	// filter. Admission comes from the marker and the filter, so the object is
	// already configured by the time a request can reach it. Every step is
	// idempotent, so the caller can retry the whole create after a failure part
	// way through.
	const now = new Date();
	const summary = await ensureTenant(database, body, isoTimestamp(now));
	const issuer = oidcIssuerSchema.parse(`${origin}/t/${summary.id}`);

	await tenantServer(env, summary.id).configure({
		tenant: summary.id,
		issuer,
		audience: oidcAudienceSchema.parse(issuer),
		ownerIssuer: summary.ownerIssuer,
		ownerSubject: summary.ownerSubject,
		ownerAudience: summary.ownerAudience,
		configVersion: summary.configVersion
	});
	await writeTenantMember(env.TENANT_CACHE, summary.id);
	await invalidateTenantRow(summary.id);

	// Publish the rebuilt filter so the new tenant is admitted within the filter
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

// The quota is a column of the tenant's D1 usage row. Each charge reads and
// checks it in its own batch, and nothing caches it, so the change needs no
// invalidation.
export function controlTenantSetQuota(
	env: Env,
	id: TenantId,
	quota: TenantQuota
): Promise<TenantQuotaResponse> {
	return setTenantQuota(
		controlDatabase(env),
		id,
		quota,
		isoTimestamp(new Date())
	);
}

export function controlTenantGetQuota(
	env: Env,
	id: TenantId
): Promise<TenantQuotaResponse> {
	return getTenantQuota(controlDatabase(env), id);
}

export async function controlTenantRotateReadCredential(
	env: Env,
	id: TenantId,
	read: TenantReadCredential
): Promise<TenantReadCredentialResponse> {
	const summary = await setTenantReadCredential(controlDatabase(env), id, read);
	await invalidateTenantRow(id);

	return { id: summary.id, hasCredential: true };
}

export async function controlTenantClearReadCredential(
	env: Env,
	id: TenantId
): Promise<TenantReadCredentialResponse> {
	const summary = await clearTenantReadCredential(controlDatabase(env), id);
	await invalidateTenantRow(id);

	return { id: summary.id, hasCredential: false };
}

export async function controlTenantRotateCacheReadCredential(
	env: Env,
	id: TenantId,
	cache: CacheScope,
	read: TenantReadCredential
): Promise<CacheReadCredentialResponse> {
	await setCacheReadCredential(
		controlDatabase(env),
		id,
		cache,
		read,
		isoTimestamp(new Date())
	);

	return { id, cache, hasCredential: true };
}

export async function controlTenantClearCacheReadCredential(
	env: Env,
	id: TenantId,
	cache: CacheScope
): Promise<CacheReadCredentialResponse> {
	await clearCacheReadCredential(controlDatabase(env), id, cache);

	return { id, cache, hasCredential: false };
}

export async function controlTenantOffboard(
	env: Env,
	id: TenantId
): Promise<TenantMutateResponse> {
	const database = controlDatabase(env);
	const summary = await setTenantStatus(database, id, 'offboarding');
	await invalidateTenantRow(id);

	// Leave the membership marker in place while offboarding. Admission must still
	// reach the authoritative status row, which refuses writes and returns 404 for
	// reads. Finalisation deletes the marker after the drain completes.
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
export function controlIssuer(request: Request): OidcIssuer {
	const url = new URL(request.url);
	return oidcIssuerSchema.parse(url.origin);
}

// The token-issuing configuration. The generated Env types these as `string`,
// but a deployment that never set the var (or never put the secret) has no
// binding at all and the env reads as undefined; both spellings of "not
// configured" must refuse.
interface ControlIssueConfig {
	readonly CUPBOARD_CONTROL_AUDIENCE: string | undefined;
	readonly CONTROL_KEY_WRAP_SECRET: string | undefined;
}

function controlAudience(env: ControlIssueConfig): OidcAudience {
	const configured = env.CUPBOARD_CONTROL_AUDIENCE ?? '';

	if (configured === '') {
		throw new ControlNotConfiguredError();
	}

	return oidcAudienceSchema.parse(configured);
}

function controlWrappingSecret(env: ControlIssueConfig): string {
	const secret = env.CONTROL_KEY_WRAP_SECRET ?? '';

	if (secret === '') {
		throw new ControlNotConfiguredError();
	}

	return secret;
}
