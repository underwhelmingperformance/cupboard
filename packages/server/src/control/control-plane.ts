import { type AuthKeyId, type TenantId } from '@cupboard/nix-store/scalars';
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
	oidcSubjectSchema,
	subjectTokenTypeIdToken,
	tokenExchangeGrantRequestSchema,
	tokenExchangeGrantType,
	tokenRequestSchema,
	type TokenResponse
} from '@cupboard/protocol/oidc';
import {
	type OidcTrustListResponse,
	type OidcTrustRemoveResponse,
	type OidcTrustSummary,
	type ParsedOidcTrustAddBody,
	type TrustRuleId
} from '@cupboard/protocol/oidc';
import {
	matchOidcTrust,
	type OidcTrustRule
} from '@cupboard/protocol/oidc-trust-match';
import type { ControlCheckReport } from '@cupboard/protocol/reports';
import { isoTimestamp } from '@cupboard/protocol/scalars';
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
	InvalidAccessTokenError,
	IssuerUnavailableError,
	OidcIssuerTransportRequiredError,
	SubjectTokenNotJwtError,
	SubjectTokenRequiredError,
	SubjectTokenVerificationFailedError,
	UnauthenticatedError,
	UnsupportedGrantTypeError,
	UnsupportedSubjectTokenTypeError
} from '../errors.ts';
import { oauthJsonResponse } from '../http/oauth-response.ts';
import { parseFormBody, parseFormValue } from '../http/parse.ts';
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
import {
	addControlTrust,
	controlTrustRuleSnapshots,
	getControlTrust,
	isControlTrustSnapshotCurrent,
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
const localDevelopmentDiscovery = new OidcDiscoveryStore({
	canUseLoopbackHttp: true
});

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

// RFC 8693 token exchange for the control plane: an external OIDC ID token is
// matched to a control trust rule on its unverified claims, the signature is then
// checked against that rule's issuer JWKS, and only then is a global-admin token
// issued with the control signing key. A subject token whose signature does not
// verify against that rule's issuer is refused, whatever claims it carries.
export async function controlTokenExchange(
	request: Request,
	env: Env
): Promise<Response> {
	const body = await parseFormBody(tokenRequestSchema, request);

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
		const granted = attenuatedGrants(
			presented.grants,
			parseRequestedGrants(exchange.authorization_details)
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

		return oauthJsonResponse({
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: writeJwtTtlSeconds,
			issued_token_type: issuedAccessTokenType,
			authorization_details: granted
		} satisfies TokenResponse);
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
	const rule = matchOidcTrust(
		snapshots.map(({ rule }) => rule),
		claims
	);

	if (rule === undefined) {
		throw new ControlSubjectTokenUntrustedError();
	}

	const snapshot = snapshots.find(({ rule: candidate }) => candidate === rule);

	if (snapshot === undefined) {
		throw new ControlSubjectTokenUntrustedError();
	}

	const verified = await verifyControlInbound(
		rule,
		exchange.subject_token,
		canUseHttpLoopback
	);
	const verifiedSubject =
		typeof verified.sub === 'string' && verified.sub !== ''
			? verified.sub
			: undefined;

	if (verifiedSubject === undefined) {
		throw new SubjectTokenVerificationFailedError();
	}

	const subject = oidcSubjectSchema.parse(verifiedSubject);

	await ensureControlKey(database, wrappingSecret, isoTimestamp(now));
	const active = await activeControlKey(database, wrappingSecret);
	const grants = resolveRequestedGrants(
		rule,
		verified,
		parseRequestedGrants(exchange.authorization_details)
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

	if (!(await isControlTrustSnapshotCurrent(database, snapshot))) {
		throw new ControlSubjectTokenUntrustedError();
	}

	return oauthJsonResponse({
		access_token: accessToken,
		token_type: 'Bearer',
		expires_in: adminJwtTtlSeconds,
		issued_token_type: issuedAccessTokenType,
		authorization_details: grants
	} satisfies TokenResponse);
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
	token: string,
	canUseHttpLoopback: boolean
): Promise<JWTPayload> {
	// Reaching the issuer is an upstream condition, not a bad token, so a discovery
	// or JWKS-fetch failure is a retryable 503.
	let issuer;
	try {
		issuer = await (
			canUseHttpLoopback ? localDevelopmentDiscovery : discovery
		).resolve(rule.issuer);
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
				algorithms: issuer.algorithms,
				requireIdTokenClaims: true
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
	body: ParsedOidcTrustAddBody
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
	body: ParsedTenantCreateBody,
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
function controlIssuer(request: Request): OidcIssuer {
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
