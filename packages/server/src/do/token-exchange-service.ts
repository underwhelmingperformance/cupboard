import { type Logger } from '@cupboard/logger';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import { bytesToHex, hexToBytes } from '@cupboard/nix-store/encoding';
import { type TenantId, type TtlSeconds } from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetails,
	isAuthorizationDetailCovered
} from '@cupboard/protocol/grants';
import {
	issuedAccessTokenType,
	oidcIssuerSchema,
	type OidcSubject,
	oidcSubjectSchema,
	type RefreshTokenGrantRequest,
	refreshTokenGrantRequestSchema,
	refreshTokenGrantType,
	subjectTokenTypeIdToken,
	type TokenExchangeGrantRequest,
	tokenExchangeGrantRequestSchema,
	tokenExchangeGrantType,
	tokenRequestSchema,
	type TokenResponse
} from '@cupboard/protocol/oidc';
import {
	firstClaimMismatch,
	hasMatchingOidcTrustIdentity,
	isRuleInteractive,
	type OidcClaims,
	type OidcTrustRule,
	oidcTrustVerificationTarget,
	trustedAudiences,
	type VerifiedOidcClaims
} from '@cupboard/protocol/oidc-trust-match';
import { selectOidcTrust } from '@cupboard/protocol/oidc-trust-selection';
import {
	type ReadAccessGrantRequest,
	readAccessGrantRequestSchema,
	readAccessGrantType,
	type ReadAccessResponse,
	type ReadResource,
	readResourcesSchema,
	type ReadResourceState,
	readResourceStateSchema,
	selectReadTrust
} from '@cupboard/protocol/read-access';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, sql } from 'drizzle-orm';

import {
	type AccessClaims,
	adminJwtTtlSeconds,
	issueAccessJwt,
	maxRefreshTokenFamilyMembers,
	refreshTokenFamilyTtlSeconds,
	refreshTokenRetryGraceMs,
	verifyAccessJwt,
	writeJwtTtlSeconds
} from '../auth/auth.ts';
import {
	type AuthenticatedRefreshAuthority,
	RefreshCredential,
	refreshCredentialMaxBytes,
	refreshPolicyIdentity
} from '../auth/refresh-credential.ts';
import {
	attenuatedGrants,
	issueAttenuatedAccessToken,
	parseRequestedGrants,
	resolveRequestedGrants
} from '../authz/issuance.ts';
import { pushIdSigningKey } from '../blob/push-credential.ts';
import { type PushIdSigningKey } from '../blob/push-id.ts';
import { sha256Hex } from '../crypto/crypto.ts';
import * as schema from '../db/schema.ts';
import {
	InvalidAuthorizationDetailsError,
	InvalidReadResourcesError,
	ReadResourcesNotPermittedError,
	RefreshTokenRequiredError,
	StaleRefreshTokenError,
	SubjectTokenRequiredError,
	type SubjectTokenUntrustedError,
	SubjectTokenVerificationFailedError,
	TenantSubjectTokenClaimMismatchError,
	TenantSubjectTokenUntrustedError,
	UnsupportedGrantTypeError,
	UnsupportedSubjectTokenTypeError
} from '../errors.ts';
import { oauthJsonResponse } from '../http/oauth-response.ts';
import { parseFormBody, parseFormValue } from '../http/parse.ts';

import { type AuthKeysService } from './auth-keys-service.ts';
import { type SchemaWriter, type ServerContext } from './context.ts';
import {
	type OidcTrustRuleSnapshot,
	type OidcTrustService
} from './oidc-trust-service.ts';

interface PreparedRefreshToken {
	readonly token: string;
	readonly family: typeof schema.refreshTokenFamilies.$inferInsert;
	readonly member: typeof schema.refreshTokenMembers.$inferInsert;
}

interface PreparedIssuedResponse {
	readonly body: TokenResponse;
	readonly refreshToken?: PreparedRefreshToken;
}

interface RefreshEnvelopeContext {
	readonly signingKey: PushIdSigningKey;
	readonly tenant: TenantId;
}

type IssuanceAuthority =
	| {
			readonly kind: 'external';
			readonly identity: VerifiedOidcClaims;
			readonly rule?: OidcTrustRule;
			readonly grants: AuthorizationDetails;
	  }
	| {
			readonly kind: 'refresh';
			readonly identity: VerifiedOidcClaims;
			readonly grants: AuthorizationDetails;
	  };

type RefreshTokenFamily = typeof schema.refreshTokenFamilies.$inferSelect;
type RefreshTokenMember = typeof schema.refreshTokenMembers.$inferSelect;
type RefreshTokenDatabase = SchemaWriter;
type RefreshTokenRotationOutcome =
	'rotated' | 'policy-changed' | 'stale-member';

export class TokenExchangeService {
	constructor(
		private readonly context: ServerContext,
		private readonly authKeys: AuthKeysService,
		private readonly oidcTrust: OidcTrustService,
		private readonly refreshStateChanged?: () => Promise<void>
	) {}

	private async exchange(
		logger: Logger,
		body: TokenExchangeGrantRequest | ReadAccessGrantRequest
	): Promise<Response> {
		if (
			body.subject_token_type !== subjectTokenTypeIdToken &&
			body.subject_token_type !== issuedAccessTokenType
		) {
			throw new UnsupportedSubjectTokenTypeError(body.subject_token_type);
		}

		// Verify the signature before deciding whether this is a self-issued access
		// token. The declared type cannot route a self-issued token through external
		// trust or make an external token eligible for attenuation.
		const presented = await this.verifySelfIssued(body.subject_token);

		if (presented !== undefined) {
			if (body.subject_token_type !== issuedAccessTokenType) {
				throw new UnsupportedSubjectTokenTypeError(body.subject_token_type);
			}

			return this.attenuatedResponse(
				presented,
				parseRequestedGrants(
					'authorization_details' in body
						? body.authorization_details
						: undefined
				)
			);
		}

		if (body.subject_token_type !== subjectTokenTypeIdToken) {
			throw new UnsupportedSubjectTokenTypeError(body.subject_token_type);
		}

		// Decode only to choose a configured issuer and audience for verification
		// and to refuse a token when its claims match no rule. Policy selection
		// below uses only verified claims.
		const decoded = this.oidcTrust.decodeInbound(body.subject_token);
		const enabled = this.oidcTrust.enabledOidcTrustRuleSnapshots(logger);
		const rules = enabled.rules;
		const target = oidcTrustVerificationTarget(rules, decoded);

		if (target === undefined || !hasMatchingOidcTrustIdentity(rules, decoded)) {
			throw await this.untrustedRefusal(rules, decoded, body.subject_token);
		}

		let verified: VerifiedOidcClaims;

		try {
			verified = await this.oidcTrust.verifyInbound(
				target,
				body.subject_token,
				trustedAudiences(rules, target.issuer)
			);
		} catch (error) {
			// Expose claim-mismatch diagnostics only after successful verification,
			// even if the decoded claims identify a configured repository.
			// Token-verification failures therefore remain generic. Propagate
			// issuer-availability errors unchanged because they are retryable and
			// do not indicate invalid tokens.
			if (
				error instanceof SubjectTokenVerificationFailedError &&
				this.repositoryPinnedCandidate(rules, decoded) !== undefined
			) {
				throw new TenantSubjectTokenUntrustedError();
			}

			throw error;
		}

		enabled.requireReadableFor(verified);

		if (body.grant_type === readAccessGrantType) {
			return this.readAccessResponse(logger, enabled.snapshots, verified, body);
		}

		const requested = parseRequestedGrants(body.authorization_details);
		const selection = selectOidcTrust(rules, verified, requested);

		switch (selection.outcome) {
			case 'authority-unmatched': {
				throw new InvalidAuthorizationDetailsError('not-permitted');
			}
			case 'identity-unmatched':
			case 'ambiguous': {
				throw this.verifiedUntrustedRefusal(rules, verified);
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

		const subject = oidcSubjectSchema.parse(verifiedSubject);

		const grants =
			selection.grants ??
			this.implicitGrants(selection.rule, verified, requested);
		return this.issuedResponse(
			logger,
			verified,
			selection.rule,
			subject,
			grants,
			{
				issued_token_type: issuedAccessTokenType
			}
		);
	}

	private implicitGrants(
		rule: OidcTrustRule | undefined,
		verified: VerifiedOidcClaims,
		requested: AuthorizationDetails | undefined
	): AuthorizationDetails {
		if (rule === undefined) {
			throw new TenantSubjectTokenUntrustedError();
		}
		return resolveRequestedGrants(rule, verified, requested);
	}

	private resourceState(resource: ReadResource): ReadResourceState {
		if (resource.type === 'cupboard_view') {
			const view = this.context.db
				.select({
					access: schema.reuseViews.access,
					priority: schema.reuseViews.priority
				})
				.from(schema.reuseViews)
				.where(eq(schema.reuseViews.name, resource.view))
				.get();

			return readResourceStateSchema.parse({
				...resource,
				state:
					view === undefined
						? { kind: 'absent' }
						: { kind: 'existing', ...view }
			});
		}

		const cache = this.context.cacheRepository.resolve(resource.cache);

		if (cache === undefined) {
			const defaults =
				resource.cache.kind === 'named'
					? this.context.cacheRepository.require({ kind: 'default' })
					: undefined;

			return readResourceStateSchema.parse({
				...resource,
				state: {
					kind: 'absent',
					...(defaults !== undefined && {
						firstWrite: {
							access: defaults.access,
							priority: CacheInfo.default.priority
						}
					})
				}
			});
		}

		const row = this.context.db
			.select({ priority: schema.cacheIdentities.priority })
			.from(schema.cacheIdentities)
			.where(eq(schema.cacheIdentities.id, cache.id))
			.get();

		return readResourceStateSchema.parse({
			...resource,
			state: { kind: 'existing', access: cache.access, priority: row?.priority }
		});
	}

	private async readAccessResponse(
		logger: Logger,
		snapshots: readonly OidcTrustRuleSnapshot[],
		verified: VerifiedOidcClaims,
		body: ReadAccessGrantRequest
	): Promise<Response> {
		let resources: ReadResource[];

		try {
			resources = readResourcesSchema.parse(JSON.parse(body.read_resources));
		} catch {
			throw new InvalidReadResourcesError();
		}

		const facts = resources.map((resource) => this.resourceState(resource));
		const selection = selectReadTrust(
			snapshots.map(({ rule }) => rule),
			verified,
			facts
		);

		if (selection.outcome === 'authority-unmatched') {
			throw new ReadResourcesNotPermittedError(selection.uncovered);
		}

		if (selection.outcome !== 'selected') {
			throw new TenantSubjectTokenUntrustedError();
		}

		if (typeof verified.sub !== 'string' || verified.sub === '') {
			throw new TenantSubjectTokenUntrustedError();
		}

		const token = await this.issueRuleToken(
			selection.rule,
			oidcSubjectSchema.parse(verified.sub),
			selection.grants,
			writeJwtTtlSeconds
		);

		const currentRules = this.oidcTrust.enabledOidcTrustRulesFor(
			logger,
			verified
		);
		const currentFacts = resources.map((resource) =>
			this.resourceState(resource)
		);
		const current = selectReadTrust(
			currentRules,
			verified,
			currentFacts,
			selection.grants
		);
		if (current.outcome === 'authority-unmatched') {
			throw new ReadResourcesNotPermittedError(current.uncovered);
		}
		if (current.outcome !== 'selected') {
			throw new TenantSubjectTokenUntrustedError();
		}
		const exact = selectOidcTrust(currentRules, verified, selection.grants);
		if (
			selection.grants.length > 0 &&
			exact.outcome === 'authority-unmatched'
		) {
			throw new ReadResourcesNotPermittedError(exact.uncovered);
		}
		if (selection.grants.length > 0 && exact.outcome !== 'selected') {
			throw new TenantSubjectTokenUntrustedError();
		}

		logger.debug('read access acquired', { resources: facts.length });

		return oauthJsonResponse({
			access_token: token,
			token_type: 'Bearer',
			issued_token_type: issuedAccessTokenType,
			expires_in: writeJwtTtlSeconds,
			authorization_details: selection.grants,
			read_resources: currentFacts
		} satisfies ReadAccessResponse);
	}

	// Return a generic refusal unless both claimed repository IDs exactly match an
	// enabled rule and the token passes signature, issuer, and audience verification
	// for that rule. The caller then receives the first binding mismatch. This
	// allows a caller from that repository to diagnose stale branch or workflow
	// claims. Forged tokens and tokens from other repositories receive no details
	// about the rule.
	private async untrustedRefusal(
		rules: readonly OidcTrustRule[],
		claims: OidcClaims,
		subjectToken: string
	): Promise<SubjectTokenUntrustedError> {
		const candidate = this.repositoryPinnedCandidate(rules, claims);

		if (candidate === undefined) {
			return new TenantSubjectTokenUntrustedError();
		}

		let verified: VerifiedOidcClaims;
		try {
			verified = await this.oidcTrust.verifyInbound(
				candidate,
				subjectToken,
				trustedAudiences(rules, candidate.issuer)
			);
		} catch {
			// Collapse signature failures and issuer outages to the same generic
			// refusal. Neither failure can expose a claim value. Candidate verification
			// adds latency, so callers can infer whether the claimed repository IDs
			// selected a rule. PLAN.md records this diagnostic timing leak as accepted.
			return new TenantSubjectTokenUntrustedError();
		}

		return this.claimRefusal(candidate, verified);
	}

	private verifiedUntrustedRefusal(
		rules: readonly OidcTrustRule[],
		claims: OidcClaims
	): SubjectTokenUntrustedError {
		const candidate = this.repositoryPinnedCandidate(rules, claims);

		return candidate === undefined
			? new TenantSubjectTokenUntrustedError()
			: this.claimRefusal(candidate, claims);
	}

	private claimRefusal(
		candidate: OidcTrustRule,
		claims: OidcClaims
	): SubjectTokenUntrustedError {
		const mismatch = firstClaimMismatch(candidate, claims);

		return mismatch === undefined
			? new TenantSubjectTokenUntrustedError()
			: new TenantSubjectTokenClaimMismatchError(candidate.id, mismatch);
	}

	// Prefer the rule with more claim bindings so a broad repository rule cannot
	// hide a narrower branch or workflow mismatch. Rule IDs make ties deterministic.
	private repositoryPinnedCandidate(
		rules: readonly OidcTrustRule[],
		claims: OidcClaims
	): OidcTrustRule | undefined {
		const pins = ['repository_id', 'repository_owner_id'];

		return rules
			.filter((rule) =>
				pins.every((name) => {
					const expected = rule.claims[name];

					return typeof expected === 'string' && expected === claims[name];
				})
			)
			.toSorted(
				(left, right) =>
					Object.keys(right.claims).length - Object.keys(left.claims).length ||
					left.id.localeCompare(right.id)
			)
			.at(0);
	}

	private async verifySelfIssued(
		token: string
	): Promise<AccessClaims | undefined> {
		const keys = await this.authKeys.authVerificationKeys();

		try {
			return await verifyAccessJwt(
				keys,
				token,
				{
					issuer: this.authKeys.authIssuer(),
					audience: this.authKeys.authAudience()
				},
				new Date()
			);
		} catch {
			return undefined;
		}
	}

	// Attenuation creates no refresh token because the presented token already
	// authenticates an existing session.
	private async attenuatedResponse(
		presented: AccessClaims,
		requested: AuthorizationDetails | undefined
	): Promise<Response> {
		const key = await this.authKeys.activeAuthKey();
		const response = await issueAttenuatedAccessToken(
			{
				privateJwk: key.privateJwk,
				kid: key.kid,
				issuer: this.authKeys.authIssuer(),
				audience: this.authKeys.authAudience(),
				presented,
				requested
			},
			new Date()
		);

		return oauthJsonResponse(response);
	}

	private currentRefreshPolicy(
		logger: Logger,
		authority: AuthenticatedRefreshAuthority,
		grants: AuthorizationDetails
	) {
		return selectOidcTrust(
			this.oidcTrust.enabledOidcTrustRulesFor(logger, authority.identity),
			authority.identity,
			grants
		);
	}

	private async refresh(
		logger: Logger,
		body: RefreshTokenGrantRequest
	): Promise<Response> {
		const presented = RefreshCredential.parse(body.refresh_token);
		if (presented === undefined) {
			throw new StaleRefreshTokenError();
		}
		const member = this.context.db
			.select()
			.from(schema.refreshTokenMembers)
			.where(eq(schema.refreshTokenMembers.id, presented.id))
			.get();
		if (member === undefined) {
			throw new StaleRefreshTokenError();
		}
		const authority = await presented.authenticate(
			member.credentialHash,
			this.context.requireTenant()
		);
		const family = this.context.db
			.select()
			.from(schema.refreshTokenFamilies)
			.where(eq(schema.refreshTokenFamilies.id, member.familyId))
			.get();
		if (authority === undefined || family === undefined) {
			throw new StaleRefreshTokenError();
		}
		if (family.expiresAt <= isoTimestamp(new Date())) {
			this.revokeFamily(family.id);
			throw new StaleRefreshTokenError();
		}
		if (!isRefreshStateMatching(authority, family, member)) {
			throw new StaleRefreshTokenError();
		}
		if (
			family.activeMemberId !== member.id ||
			family.generation !== member.generation
		) {
			return this.retryConsumedToken(logger, presented, member, body);
		}
		const grants = attenuatedGrants(
			authority.grants,
			parseRequestedGrants(body.authorization_details)
		);
		const selection = this.currentRefreshPolicy(logger, authority, grants);
		if (selection.outcome !== 'selected') {
			this.revokeFamily(family.id);
			throw new StaleRefreshTokenError();
		}
		if (family.generation >= maxRefreshTokenFamilyMembers - 1) {
			this.revokeFamily(family.id);
			this.logFamilyRevocation(logger, 'member-limit');
			throw new StaleRefreshTokenError();
		}
		const prepared = await this.prepareIssuedResponse(
			selection.rule,
			oidcSubjectSchema.parse(authority.identity.sub),
			{ kind: 'refresh', identity: authority.identity, grants },
			undefined,
			{},
			family
		);
		if (prepared.refreshToken === undefined) {
			throw new StaleRefreshTokenError();
		}
		const successor = RefreshCredential.parse(prepared.refreshToken.token);
		if (successor === undefined) {
			throw new StaleRefreshTokenError();
		}
		const envelope = await sealRefreshSuccessor(
			this.refreshEnvelopeContext(),
			presented,
			successor
		);
		const rotation = this.rotateFamily(
			logger,
			authority,
			grants,
			family,
			member,
			prepared.refreshToken,
			envelope
		);
		if (rotation === 'stale-member') {
			return this.retryConsumedToken(logger, presented, member, body);
		}
		if (rotation === 'policy-changed') {
			throw new StaleRefreshTokenError();
		}
		await this.refreshStateChanged?.();
		return oauthJsonResponse(prepared.body);
	}

	private async retryConsumedToken(
		logger: Logger,
		presented: RefreshCredential,
		member: RefreshTokenMember,
		body: RefreshTokenGrantRequest
	): Promise<Response> {
		const family = this.context.db
			.select()
			.from(schema.refreshTokenFamilies)
			.where(eq(schema.refreshTokenFamilies.id, member.familyId))
			.get();
		if (family === undefined) {
			throw new StaleRefreshTokenError();
		}
		const successor = this.context.db
			.select()
			.from(schema.refreshTokenMembers)
			.where(eq(schema.refreshTokenMembers.id, family.activeMemberId))
			.get();
		const spent = this.context.db
			.select()
			.from(schema.refreshTokenMembers)
			.where(eq(schema.refreshTokenMembers.id, member.id))
			.get();
		const nowIso = isoTimestamp(new Date());
		if (
			family.expiresAt <= nowIso ||
			spent?.familyId !== family.id ||
			spent.credentialHash !== member.credentialHash ||
			successor?.familyId !== family.id ||
			successor.generation !== member.generation + 1 ||
			family.generation !== successor.generation ||
			!isWithinRefreshRetryGrace(successor.createdAt, nowIso)
		) {
			this.revokeFamily(family.id);
			this.logFamilyRevocation(logger, 'replay');
			throw new StaleRefreshTokenError();
		}
		const value = await openRefreshSuccessor(
			this.refreshEnvelopeContext(),
			presented,
			successor.id,
			spent.successorEnvelope
		);
		const credential =
			value === undefined ? undefined : RefreshCredential.parse(value);
		const authority = await credential?.authenticate(
			successor.credentialHash,
			this.context.requireTenant()
		);
		if (
			authority === undefined ||
			credential === undefined ||
			!isRefreshStateMatching(authority, family, successor)
		) {
			throw new StaleRefreshTokenError();
		}
		const requested = parseRequestedGrants(body.authorization_details);
		if (
			requested !== undefined &&
			!hasSameAuthority(requested, authority.grants)
		) {
			throw new StaleRefreshTokenError();
		}
		const selection = this.currentRefreshPolicy(
			logger,
			authority,
			authority.grants
		);
		if (selection.outcome !== 'selected') {
			this.revokeFamily(family.id);
			throw new StaleRefreshTokenError();
		}
		const accessToken = await this.issueRuleToken(
			selection.rule,
			oidcSubjectSchema.parse(authority.identity.sub),
			authority.grants,
			adminJwtTtlSeconds
		);
		const isCurrent = this.context.db.transaction((transaction) => {
			const active = transaction
				.select()
				.from(schema.refreshTokenFamilies)
				.where(
					and(
						eq(schema.refreshTokenFamilies.id, family.id),
						eq(schema.refreshTokenFamilies.activeMemberId, successor.id),
						eq(schema.refreshTokenFamilies.generation, successor.generation)
					)
				)
				.get();
			const transactionTime = isoTimestamp(new Date());
			if (
				active === undefined ||
				active.expiresAt <= transactionTime ||
				!isWithinRefreshRetryGrace(successor.createdAt, transactionTime) ||
				this.currentRefreshPolicy(logger, authority, authority.grants)
					.outcome !== 'selected'
			) {
				this.revokeFamily(family.id, transaction);
				return false;
			}
			return true;
		});
		if (!isCurrent) {
			throw new StaleRefreshTokenError();
		}
		return oauthJsonResponse({
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: adminJwtTtlSeconds,
			refresh_token: credential.value,
			authorization_details: authority.grants
		} satisfies TokenResponse);
	}

	private async issuedResponse(
		logger: Logger,
		verified: VerifiedOidcClaims,
		rule: OidcTrustRule | undefined,
		subject: OidcSubject,
		grants: AuthorizationDetails,
		extra: Pick<TokenResponse, 'issued_token_type'>
	): Promise<Response> {
		const prepared = await this.prepareIssuedResponse(
			rule,
			subject,
			{ kind: 'external', identity: verified, rule, grants },
			undefined,
			extra
		);

		const hasIssuedRefresh = this.context.db.transaction((transaction) => {
			const currentRules = this.oidcTrust.enabledOidcTrustRulesFor(
				logger,
				verified
			);
			const current = selectOidcTrust(currentRules, verified, grants);
			if (current.outcome !== 'selected') {
				throw new TenantSubjectTokenUntrustedError();
			}

			const refreshToken = prepared.refreshToken;

			if (
				refreshToken === undefined ||
				current.rule === undefined ||
				!isRuleInteractive(current.rule)
			) {
				return false;
			}

			transaction
				.insert(schema.refreshTokenFamilies)
				.values(refreshToken.family)
				.run();
			transaction
				.insert(schema.refreshTokenMembers)
				.values(refreshToken.member)
				.run();
			return true;
		});

		if (hasIssuedRefresh) {
			await this.refreshStateChanged?.();
		}
		return oauthJsonResponse({
			...prepared.body,
			refresh_token: hasIssuedRefresh ? prepared.body.refresh_token : undefined
		});
	}

	private async prepareIssuedResponse(
		rule: OidcTrustRule | undefined,
		subject: OidcSubject,
		authority: IssuanceAuthority,
		requested: AuthorizationDetails | undefined,
		extra: Pick<TokenResponse, 'issued_token_type'>,
		family?: RefreshTokenFamily
	): Promise<PreparedIssuedResponse> {
		const granted =
			authority.kind === 'external'
				? authority.grants
				: attenuatedGrants(authority.grants, requested);
		const isContentReadOnly =
			granted.length > 0 &&
			granted.every(
				(detail) =>
					(detail.type === 'cupboard_cache' &&
						detail.actions.every(
							(action) => action === 'cache:content-read'
						)) ||
					detail.type === 'cupboard_view'
			);
		const isInteractive =
			authority.kind === 'refresh' ||
			(rule !== undefined && isRuleInteractive(rule) && !isContentReadOnly);
		const ttlSeconds = isInteractive ? adminJwtTtlSeconds : writeJwtTtlSeconds;
		const accessToken = await this.issueRuleToken(
			rule,
			subject,
			granted,
			ttlSeconds
		);

		// Issue refresh tokens only for interactive rules. CI exchanges authenticate
		// each run with a fresh external subject token. A refresh token would turn one
		// federated CI exchange into a persistent session.
		const refreshToken = isInteractive
			? await this.prepareRefreshToken(
					authority.identity,
					subject,
					rule,
					granted,
					family
				)
			: undefined;

		return {
			body: {
				access_token: accessToken,
				token_type: 'Bearer',
				expires_in: ttlSeconds,
				...extra,
				...(refreshToken !== undefined && {
					refresh_token: refreshToken.token
				}),
				authorization_details: granted
			} satisfies TokenResponse,
			refreshToken
		};
	}

	private async prepareRefreshToken(
		identity: VerifiedOidcClaims,
		subject: OidcSubject,
		rule: OidcTrustRule | undefined,
		grants: AuthorizationDetails,
		current?: RefreshTokenFamily
	): Promise<PreparedRefreshToken> {
		const familyId = current?.id ?? crypto.randomUUID();
		const generation = current === undefined ? 0 : current.generation + 1;
		const id = crypto.randomUUID();
		const now = new Date();
		const createdAt = isoTimestamp(now);
		const expiresAt =
			current?.expiresAt ??
			isoTimestamp(
				new Date(now.getTime() + refreshTokenFamilyTtlSeconds * 1000)
			);

		const policyIdentity = refreshPolicyIdentity(identity);
		const credential = RefreshCredential.issue({
			purpose: 'cupboard-refresh',
			version: 1,
			tenant: this.context.requireTenant(),
			familyId,
			memberId: id,
			generation,
			expiresAt,
			identity: policyIdentity,
			grants
		});
		return {
			token: credential.value,
			family: {
				id: familyId,
				activeMemberId: id,
				generation,
				createdAt: current?.createdAt ?? createdAt,
				expiresAt,
				issuer: oidcIssuerSchema.parse(policyIdentity.iss),
				subject,
				...(rule !== undefined && { rule: rule.id })
			},
			member: {
				id,
				familyId,
				generation,
				credentialHash: await sha256Hex(credential.value),
				createdAt
			}
		};
	}

	private rotateFamily(
		logger: Logger,
		authority: AuthenticatedRefreshAuthority,
		grants: AuthorizationDetails,
		family: RefreshTokenFamily,
		member: RefreshTokenMember,
		successor: PreparedRefreshToken,
		envelope: string
	): RefreshTokenRotationOutcome {
		return this.context.db.transaction((transaction) => {
			if (
				family.expiresAt <= isoTimestamp(new Date()) ||
				this.currentRefreshPolicy(logger, authority, grants).outcome !==
					'selected'
			) {
				this.revokeFamily(family.id, transaction);
				return 'policy-changed';
			}

			const advancedRows = transaction
				.update(schema.refreshTokenFamilies)
				.set({
					activeMemberId: successor.family.activeMemberId,
					generation: successor.family.generation,
					issuer: successor.family.issuer,
					subject: successor.family.subject,
					rule: successor.family.rule ?? sql`NULL`
				})
				.where(
					and(
						eq(schema.refreshTokenFamilies.id, family.id),
						eq(schema.refreshTokenFamilies.activeMemberId, member.id),
						eq(schema.refreshTokenFamilies.generation, member.generation)
					)
				)
				.returning({ id: schema.refreshTokenFamilies.id })
				.all();
			const [advanced] = advancedRows;

			if (advanced === undefined) {
				return 'stale-member';
			}

			transaction
				.insert(schema.refreshTokenMembers)
				.values(successor.member)
				.run();
			const successorDeadline = new Date(
				Date.parse(successor.member.createdAt) + refreshTokenRetryGraceMs
			);
			transaction
				.update(schema.refreshTokenMembers)
				.set({
					successorEnvelope: envelope,
					successorExpiresAt: isoTimestamp(successorDeadline)
				})
				.where(eq(schema.refreshTokenMembers.id, member.id))
				.run();
			transaction
				.update(schema.refreshTokenMembers)
				.set({ successorEnvelope: sql`NULL`, successorExpiresAt: sql`NULL` })
				.where(
					and(
						eq(schema.refreshTokenMembers.familyId, family.id),
						eq(schema.refreshTokenMembers.generation, member.generation - 1)
					)
				)
				.run();

			return 'rotated';
		});
	}

	private revokeFamily(
		familyId: string,
		database?: RefreshTokenDatabase
	): void {
		const revoke = (transaction: RefreshTokenDatabase): void => {
			transaction
				.delete(schema.refreshTokenMembers)
				.where(eq(schema.refreshTokenMembers.familyId, familyId))
				.run();
			transaction
				.delete(schema.refreshTokenFamilies)
				.where(eq(schema.refreshTokenFamilies.id, familyId))
				.run();
		};

		if (database !== undefined) {
			revoke(database);
			return;
		}

		this.context.db.transaction(revoke);
	}

	private logFamilyRevocation(
		logger: Logger,
		reason: 'member-limit' | 'replay'
	): void {
		logger.warn('refresh-token family revoked', { reason });
	}

	private async issueRuleToken(
		rule: OidcTrustRule | undefined,
		subject: OidcSubject,
		grants: AuthorizationDetails,
		ttlSeconds: TtlSeconds
	): Promise<string> {
		const key = await this.authKeys.activeAuthKey();

		return issueAccessJwt(
			key.privateJwk,
			{
				issuer: this.authKeys.authIssuer(),
				audience: this.authKeys.authAudience(),
				subject,
				grants,
				kid: key.kid,
				ttlSeconds,
				auditClaims: rule === undefined ? {} : { cb_rule: rule.id }
			},
			new Date()
		);
	}

	private refreshEnvelopeContext(): RefreshEnvelopeContext {
		return {
			signingKey: pushIdSigningKey(this.context.env),
			tenant: this.context.requireTenant()
		};
	}

	async handleToken(logger: Logger, request: Request): Promise<Response> {
		const body = await parseFormBody(tokenRequestSchema, request);

		if (body.grant_type === readAccessGrantType) {
			return this.exchange(
				logger,
				parseFormValue(readAccessGrantRequestSchema, body)
			);
		}

		if (body.grant_type === tokenExchangeGrantType) {
			if (body.subject_token === undefined) {
				throw new SubjectTokenRequiredError();
			}

			return this.exchange(
				logger,
				parseFormValue(tokenExchangeGrantRequestSchema, body)
			);
		}

		if (body.grant_type === refreshTokenGrantType) {
			if (body.refresh_token === undefined) {
				throw new RefreshTokenRequiredError();
			}

			return this.refresh(
				logger,
				parseFormValue(refreshTokenGrantRequestSchema, body)
			);
		}

		throw new UnsupportedGrantTypeError(body.grant_type);
	}
}

function hasSameAuthority(
	left: AuthorizationDetails,
	right: AuthorizationDetails
): boolean {
	return (
		left.every((detail) => isAuthorizationDetailCovered(right, detail)) &&
		right.every((detail) => isAuthorizationDetailCovered(left, detail))
	);
}

function isWithinRefreshRetryGrace(
	createdAt: IsoTimestamp,
	now: IsoTimestamp
): boolean {
	const elapsedMs = Date.parse(now) - Date.parse(createdAt);

	return elapsedMs >= 0 && elapsedMs <= refreshTokenRetryGraceMs;
}

function isRefreshStateMatching(
	authority: AuthenticatedRefreshAuthority,
	family: RefreshTokenFamily,
	member: RefreshTokenMember
): boolean {
	return (
		authority.familyId === family.id &&
		member.familyId === family.id &&
		authority.memberId === member.id &&
		authority.generation === member.generation &&
		authority.expiresAt === family.expiresAt
	);
}

async function refreshEnvelopeKey(
	context: RefreshEnvelopeContext,
	presented: RefreshCredential,
	successorId: string
): Promise<CryptoKey> {
	const encoder = new TextEncoder();
	const material = await crypto.subtle.importKey(
		'raw',
		encoder.encode(context.signingKey),
		'HKDF',
		false,
		['deriveKey']
	);

	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: encoder.encode(presented.secret),
			info: encoder.encode(
				JSON.stringify([
					'cupboard/refresh-envelope/v3',
					context.tenant,
					presented.id,
					successorId
				])
			)
		},
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

async function sealRefreshSuccessor(
	context: RefreshEnvelopeContext,
	presented: RefreshCredential,
	successor: RefreshCredential
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await refreshEnvelopeKey(context, presented, successor.id);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		new TextEncoder().encode(successor.value)
	);

	return `${bytesToHex(iv)}.${bytesToHex(new Uint8Array(ciphertext))}`;
}

async function openRefreshSuccessor(
	context: RefreshEnvelopeContext,
	presented: RefreshCredential,
	successorId: string,
	envelope: string | null
): Promise<string | undefined> {
	if (envelope === null) {
		return undefined;
	}

	const [ivHex, ciphertextHex, extra] = envelope.split('.', 3);

	if (
		ivHex === undefined ||
		ciphertextHex === undefined ||
		extra !== undefined ||
		!/^[\da-f]{24}$/iu.test(ivHex) ||
		ciphertextHex.length > (refreshCredentialMaxBytes + 16) * 2 ||
		!/^(?:[\da-f]{2}){17,}$/u.test(ciphertextHex)
	) {
		return undefined;
	}

	const key = await refreshEnvelopeKey(context, presented, successorId);
	let secret: ArrayBuffer;

	try {
		secret = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: hexToBytes(ivHex) },
			key,
			hexToBytes(ciphertextHex)
		);
	} catch (error) {
		if (error instanceof DOMException && error.name === 'OperationError') {
			return undefined;
		}

		throw error;
	}

	return new TextDecoder().decode(secret);
}
