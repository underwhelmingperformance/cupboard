import { type Logger } from '@cupboard/logger';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import { hexToBytes } from '@cupboard/nix-store/encoding';
import { type TenantId, type TtlSeconds } from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetails,
	isAuthorizationDetailCovered,
	storedAuthorizationDetailsSchema
} from '@cupboard/protocol/grants';
import {
	issuedAccessTokenType,
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
	type TokenResponse,
	type TrustRuleId
} from '@cupboard/protocol/oidc';
import {
	firstClaimMismatch,
	hasMatchingOidcTrustIdentity,
	isRuleInteractive,
	type OidcClaims,
	type OidcTrustRule,
	oidcTrustVerificationTarget,
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
import { and, eq, inArray, sql } from 'drizzle-orm';

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
	attenuatedGrants,
	issueAttenuatedAccessToken,
	parseRequestedGrants,
	resolveRequestedGrants
} from '../authz/issuance.ts';
import { pushIdSigningKey } from '../blob/push-credential.ts';
import { type PushIdSigningKey } from '../blob/push-id.ts';
import { isConstantTimeEqual } from '../crypto/crypto.ts';
import * as schema from '../db/schema.ts';
import {
	InvalidAuthorizationDetailsError,
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
import { StoredGrantSpelling } from './stored-grant-spelling.ts';

interface PreparedRefreshToken {
	readonly token: string;
	readonly family: Omit<
		typeof schema.refreshTokenFamilies.$inferInsert,
		'grantsJson'
	> & { readonly grantsJson: string };
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
			readonly claims: VerifiedOidcClaims;
	  }
	| {
			readonly kind: 'refresh';
			readonly grants: AuthorizationDetails;
	  };

interface RefreshToken {
	readonly id: string;
	readonly secret: string;
}

type RefreshTokenFamily = typeof schema.refreshTokenFamilies.$inferSelect;
type RefreshTokenMember = typeof schema.refreshTokenMembers.$inferSelect;
type RefreshTokenDatabase = SchemaWriter;
type RefreshTokenRotationOutcome = 'rotated' | 'rule-changed' | 'stale-member';

export class TokenExchangeService {
	private readonly grantSpelling: StoredGrantSpelling;

	constructor(
		private readonly context: ServerContext,
		private readonly authKeys: AuthKeysService,
		private readonly oidcTrust: OidcTrustService
	) {
		this.grantSpelling = new StoredGrantSpelling(context);
	}

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
		const snapshots = this.oidcTrust.enabledOidcTrustRuleSnapshots(logger);
		const rules = snapshots.map((snapshot) => snapshot.rule);
		const target = oidcTrustVerificationTarget(rules, decoded);

		if (target === undefined || !hasMatchingOidcTrustIdentity(rules, decoded)) {
			throw await this.untrustedRefusal(rules, decoded, body.subject_token);
		}

		let verified: VerifiedOidcClaims;

		try {
			verified = await this.oidcTrust.verifyInbound(
				target,
				body.subject_token,
				configuredAudiences(rules)
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

		if (body.grant_type === readAccessGrantType) {
			return this.readAccessResponse(logger, snapshots, verified, body);
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

		const { rule } = selection;

		const snapshot = snapshots.find((candidate) => candidate.rule === rule);

		if (snapshot === undefined) {
			throw new TenantSubjectTokenUntrustedError();
		}

		const verifiedSubject =
			typeof verified.sub === 'string' && verified.sub !== ''
				? verified.sub
				: undefined;

		if (verifiedSubject === undefined) {
			throw new SubjectTokenVerificationFailedError();
		}

		const subject = oidcSubjectSchema.parse(verifiedSubject);

		return this.issuedResponse(snapshot, subject, verified, requested, {
			issued_token_type: issuedAccessTokenType
		});
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
			throw new InvalidAuthorizationDetailsError('not-permitted');
		}

		const facts = resources.map((resource) => this.resourceState(resource));
		const selection = selectReadTrust(
			snapshots.map(({ rule }) => rule),
			verified,
			facts
		);

		if (selection.outcome === 'authority-unmatched') {
			throw new InvalidAuthorizationDetailsError('not-permitted');
		}

		if (selection.outcome !== 'selected') {
			throw new TenantSubjectTokenUntrustedError();
		}

		const snapshot = snapshots.find(({ rule }) => rule === selection.rule);

		if (
			snapshot === undefined ||
			typeof verified.sub !== 'string' ||
			verified.sub === ''
		) {
			throw new TenantSubjectTokenUntrustedError();
		}

		const token = await this.issueRuleToken(
			selection.rule,
			oidcSubjectSchema.parse(verified.sub),
			selection.grants,
			writeJwtTtlSeconds
		);

		if (!this.oidcTrust.isEnabledSnapshotCurrent(snapshot, this.context.db)) {
			throw new TenantSubjectTokenUntrustedError();
		}

		logger.debug('read access acquired', { resources: facts.length });

		return oauthJsonResponse({
			access_token: token,
			token_type: 'Bearer',
			issued_token_type: issuedAccessTokenType,
			expires_in: writeJwtTtlSeconds,
			authorization_details: selection.grants,
			read_resources: facts
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
				configuredAudiences(rules)
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

	private async refresh(
		logger: Logger,
		body: RefreshTokenGrantRequest
	): Promise<Response> {
		const presented = parseRefreshToken(body.refresh_token);

		if (presented === undefined) {
			throw new StaleRefreshTokenError();
		}

		// Hash the secret before loading its member. After response preparation, the
		// rotation transaction checks the active member and generation.
		const presentedHash = await sha256Hex(presented.secret);

		const member = this.context.db
			.select()
			.from(schema.refreshTokenMembers)
			.where(eq(schema.refreshTokenMembers.id, presented.id))
			.get();

		if (member === undefined) {
			throw new StaleRefreshTokenError();
		}

		if (!(await isConstantTimeEqual(member.secretHash, presentedHash, 64))) {
			throw new StaleRefreshTokenError();
		}

		const family = this.context.db
			.select()
			.from(schema.refreshTokenFamilies)
			.where(eq(schema.refreshTokenFamilies.id, member.familyId))
			.get();

		if (family === undefined) {
			this.context.db
				.delete(schema.refreshTokenMembers)
				.where(eq(schema.refreshTokenMembers.id, member.id))
				.run();
			throw new StaleRefreshTokenError();
		}

		const nowIso = isoTimestamp(new Date());

		if (family.expiresAt <= nowIso) {
			this.revokeFamily(family.id);
			throw new StaleRefreshTokenError();
		}

		if (
			family.activeMemberId !== member.id ||
			family.generation !== member.generation
		) {
			return this.retryConsumedToken(logger, presented, member, body);
		}

		const snapshot = this.oidcTrust
			.enabledOidcTrustRuleSnapshots(logger)
			.find((candidate) => candidate.rule.id === family.ruleId);

		if (snapshot === undefined) {
			this.revokeFamily(family.id);
			throw new StaleRefreshTokenError();
		}

		if (family.generation >= maxRefreshTokenFamilyMembers - 1) {
			this.revokeFamily(family.id);
			this.logFamilyRevocation(logger, 'member-limit');
			throw new StaleRefreshTokenError();
		}

		// Refresh tokens originate only from interactive rules. Resolve any requested
		// narrowing against the current rule before issuing the next session.
		const prepared = await this.prepareIssuedResponse(
			snapshot.rule,
			family.subject,
			{
				kind: 'refresh',
				grants: this.familyGrants(family)
			},
			parseRequestedGrants(body.authorization_details),
			{},
			family
		);

		if (prepared.refreshToken === undefined) {
			this.revokeFamily(family.id);
			throw new StaleRefreshTokenError();
		}
		const successor = parseRefreshToken(prepared.refreshToken.token);

		if (successor === undefined) {
			throw new StaleRefreshTokenError();
		}

		const envelope = await sealRefreshSuccessor(
			this.refreshEnvelopeContext(),
			presented,
			successor
		);

		const rotation = this.rotateFamily(
			family,
			member,
			prepared.refreshToken,
			envelope,
			snapshot
		);

		if (rotation === 'stale-member') {
			return this.retryConsumedToken(logger, presented, member, body);
		}

		if (rotation === 'rule-changed') {
			throw new StaleRefreshTokenError();
		}

		return oauthJsonResponse(prepared.body);
	}

	private async retryConsumedToken(
		logger: Logger,
		presented: RefreshToken,
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

		const nowIso = isoTimestamp(new Date());

		if (family.expiresAt <= nowIso) {
			this.revokeFamily(family.id);
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
		const isWithinGrace =
			spent?.familyId === family.id &&
			spent.secretHash === member.secretHash &&
			successor?.familyId === family.id &&
			successor.generation === member.generation + 1 &&
			family.generation === successor.generation &&
			isWithinRefreshRetryGrace(successor.createdAt, nowIso);

		if (!isWithinGrace) {
			this.revokeFamily(family.id);
			this.logFamilyRevocation(logger, 'replay');
			throw new StaleRefreshTokenError();
		}

		const secret = await openRefreshSuccessor(
			this.refreshEnvelopeContext(),
			presented,
			successor.id,
			spent.successorEnvelope
		);

		if (secret === undefined) {
			throw new StaleRefreshTokenError();
		}

		const secretHash = await sha256Hex(secret);

		if (!(await isConstantTimeEqual(successor.secretHash, secretHash, 64))) {
			throw new StaleRefreshTokenError();
		}

		const snapshot = this.oidcTrust
			.enabledOidcTrustRuleSnapshots(logger)
			.find((candidate) => candidate.rule.id === family.ruleId);

		if (snapshot === undefined || !isRuleInteractive(snapshot.rule)) {
			this.revokeFamily(family.id);
			throw new StaleRefreshTokenError();
		}

		const grants = this.familyGrants(family);
		const requested = parseRequestedGrants(body.authorization_details);

		if (requested !== undefined && !hasSameAuthority(requested, grants)) {
			throw new StaleRefreshTokenError();
		}

		const accessToken = await this.issueRuleToken(
			snapshot.rule,
			family.subject,
			grants,
			adminJwtTtlSeconds
		);
		const responseTime = isoTimestamp(new Date());

		if (
			family.expiresAt <= responseTime ||
			!isWithinRefreshRetryGrace(successor.createdAt, responseTime)
		) {
			this.revokeFamily(family.id);
			this.logFamilyRevocation(logger, 'replay');
			throw new StaleRefreshTokenError();
		}

		const isCurrent = this.context.db.transaction((transaction) => {
			if (!this.oidcTrust.isEnabledSnapshotCurrent(snapshot, transaction)) {
				this.revokeFamily(family.id, transaction);
				return false;
			}

			const active = transaction
				.select({
					id: schema.refreshTokenFamilies.id,
					grantsJson: schema.refreshTokenFamilies.grantsJson,
					expiresAt: schema.refreshTokenFamilies.expiresAt
				})
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
				active.grantsJson !== family.grantsJson
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
			refresh_token: `${successor.id}.${secret}`,
			authorization_details: grants
		} satisfies TokenResponse);
	}

	private async issuedResponse(
		snapshot: OidcTrustRuleSnapshot,
		subject: OidcSubject,
		claims: VerifiedOidcClaims,
		requested: AuthorizationDetails | undefined,
		extra: Pick<TokenResponse, 'issued_token_type'>
	): Promise<Response> {
		const prepared = await this.prepareIssuedResponse(
			snapshot.rule,
			subject,
			{ kind: 'external', claims },
			requested,
			extra
		);

		this.context.db.transaction((transaction) => {
			if (!this.oidcTrust.isEnabledSnapshotCurrent(snapshot, transaction)) {
				throw new TenantSubjectTokenUntrustedError();
			}

			const refreshToken = prepared.refreshToken;

			if (refreshToken === undefined) {
				return;
			}

			transaction
				.insert(schema.refreshTokenFamilies)
				.values({
					...refreshToken.family,
					grantsJson: this.grantSpelling.authorizationDetailsForWrite(
						refreshToken.family.grantsJson
					)
				})
				.run();
			transaction
				.insert(schema.refreshTokenMembers)
				.values(refreshToken.member)
				.run();
		});

		return oauthJsonResponse(prepared.body);
	}

	private async prepareIssuedResponse(
		rule: OidcTrustRule,
		subject: OidcSubject,
		authority: IssuanceAuthority,
		requested: AuthorizationDetails | undefined,
		extra: Pick<TokenResponse, 'issued_token_type'>,
		family?: RefreshTokenFamily
	): Promise<PreparedIssuedResponse> {
		const granted =
			authority.kind === 'external'
				? resolveRequestedGrants(rule, authority.claims, requested)
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
		const isInteractive = isRuleInteractive(rule) && !isContentReadOnly;
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
			? await this.prepareRefreshToken(rule.id, subject, granted, family)
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
		ruleId: TrustRuleId,
		subject: OidcSubject,
		grants: AuthorizationDetails,
		current?: RefreshTokenFamily
	): Promise<PreparedRefreshToken> {
		const familyId = current?.id ?? crypto.randomUUID();
		const generation = current === undefined ? 0 : current.generation + 1;
		const id = crypto.randomUUID();
		const secret = randomSecretHex();
		const now = new Date();
		const createdAt = isoTimestamp(now);
		const expiresAt =
			current?.expiresAt ??
			isoTimestamp(
				new Date(now.getTime() + refreshTokenFamilyTtlSeconds * 1000)
			);

		return {
			token: `${id}.${secret}`,
			family: {
				id: familyId,
				activeMemberId: id,
				generation,
				ruleId,
				subject,
				grantsJson: await this.grantSpelling.authorizationDetailsJson(grants),
				createdAt: current?.createdAt ?? createdAt,
				expiresAt
			},
			member: {
				id,
				familyId,
				generation,
				secretHash: await sha256Hex(secret),
				createdAt
			}
		};
	}

	private familyGrants(family: RefreshTokenFamily): AuthorizationDetails {
		if (family.grantsJson === null) {
			this.revokeFamily(family.id);
			throw new StaleRefreshTokenError();
		}

		try {
			return storedAuthorizationDetailsSchema.parse(
				JSON.parse(family.grantsJson)
			);
		} catch {
			this.revokeFamily(family.id);
			throw new StaleRefreshTokenError();
		}
	}

	private rotateFamily(
		family: RefreshTokenFamily,
		member: RefreshTokenMember,
		successor: PreparedRefreshToken,
		envelope: string,
		snapshot: OidcTrustRuleSnapshot
	): RefreshTokenRotationOutcome {
		return this.context.db.transaction((transaction) => {
			if (!this.oidcTrust.isEnabledSnapshotCurrent(snapshot, transaction)) {
				this.revokeFamily(family.id, transaction);
				return 'rule-changed';
			}

			const advancedRows = transaction
				.update(schema.refreshTokenFamilies)
				.set({
					activeMemberId: successor.family.activeMemberId,
					generation: successor.family.generation,
					grantsJson: this.grantSpelling.authorizationDetailsForWrite(
						successor.family.grantsJson
					)
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
			transaction
				.update(schema.refreshTokenMembers)
				.set({ successorEnvelope: envelope })
				.where(eq(schema.refreshTokenMembers.id, member.id))
				.run();
			transaction
				.update(schema.refreshTokenMembers)
				.set({ successorEnvelope: sql`NULL` })
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
		rule: OidcTrustRule,
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
				auditClaims: { cb_rule: rule.id }
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

	revokeRuleFamilies(
		ruleId: TrustRuleId,
		database: RefreshTokenDatabase = this.context.db
	): void {
		const familyIds = database
			.select({ id: schema.refreshTokenFamilies.id })
			.from(schema.refreshTokenFamilies)
			.where(eq(schema.refreshTokenFamilies.ruleId, ruleId));

		database
			.delete(schema.refreshTokenMembers)
			.where(inArray(schema.refreshTokenMembers.familyId, familyIds))
			.run();
		database
			.delete(schema.refreshTokenFamilies)
			.where(eq(schema.refreshTokenFamilies.ruleId, ruleId))
			.run();
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

// Every configured audience identifies this deployment, so any of them may
// appear alongside the verified audience in a token's `aud` array.
function configuredAudiences(
	rules: readonly OidcTrustRule[]
): ReadonlySet<string> {
	return new Set(rules.map((rule) => rule.audience));
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

// A refresh token is spelled `<id>.<secret>`. The ID selects the row, and the
// secret proves possession against the stored hash.
function parseRefreshToken(token: string): RefreshToken | undefined {
	const separator = token.indexOf('.');

	if (separator <= 0 || separator === token.length - 1) {
		return undefined;
	}

	return {
		id: token.slice(0, separator),
		secret: token.slice(separator + 1)
	};
}

function randomSecretHex(): string {
	return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

async function refreshEnvelopeKey(
	context: RefreshEnvelopeContext,
	presented: RefreshToken,
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
					'cupboard/refresh-envelope/v2',
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
	presented: RefreshToken,
	successor: RefreshToken
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await refreshEnvelopeKey(context, presented, successor.id);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		new TextEncoder().encode(successor.secret)
	);

	return `${bytesToHex(iv)}.${bytesToHex(new Uint8Array(ciphertext))}`;
}

async function openRefreshSuccessor(
	context: RefreshEnvelopeContext,
	presented: RefreshToken,
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
		!/^[\da-f]{160}$/iu.test(ciphertextHex)
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

async function sha256Hex(value: string): Promise<string> {
	const encoder = new TextEncoder();
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));

	return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
