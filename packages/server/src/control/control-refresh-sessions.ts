import { type Logger } from '@cupboard/logger';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import {
	oidcIssuerSchema,
	type OidcSubject,
	oidcSubjectSchema,
	type RefreshTokenGrantRequest,
	type TokenResponse
} from '@cupboard/protocol/oidc';
import {
	type OidcTrustRule,
	type VerifiedOidcClaims
} from '@cupboard/protocol/oidc-trust-match';
import { type OidcTrustSelection } from '@cupboard/protocol/oidc-trust-selection';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type RefreshSessionId,
	refreshSessionIdSchema,
	type RefreshSessionListResponseInput,
	type RefreshSessionRevokeResponseInput
} from '@cupboard/protocol/sessions';
import {
	and,
	asc,
	eq,
	exists,
	gt,
	inArray,
	isNotNull,
	lt,
	lte,
	notExists,
	sql
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	adminJwtTtlSeconds,
	maxRefreshTokenFamilyMembers,
	refreshTokenFamilyTtlSeconds,
	refreshTokenRetryGraceMs
} from '../auth/auth.ts';
import {
	type AuthenticatedRefreshAuthority,
	openRefreshSuccessor,
	RefreshCredential,
	type RefreshKeyContext,
	refreshPolicyIdentity,
	sealRefreshSuccessor
} from '../auth/refresh-credential.ts';
import {
	hasSameAuthority,
	isRefreshStateMatching,
	isWithinRefreshRetryGrace,
	unknownMemberCredentialHash
} from '../auth/refresh-rotation.ts';
import { attenuatedGrants, parseRequestedGrants } from '../authz/issuance.ts';
import { sha256Hex } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	StaleRefreshTokenError,
	SubjectTokenReplayedError
} from '../errors.ts';
import { type SubjectNonce } from '../oidc/subject-binding.ts';

import { consumeControlSubjectNonce } from './control-subject-nonces.ts';

type Database = DrizzleD1Database<typeof d1Schema>;
type ControlRefreshFamily =
	typeof d1Schema.controlRefreshSessionFamily.$inferSelect;
type ControlRefreshMember =
	typeof d1Schema.controlRefreshSessionMember.$inferSelect;

const families = d1Schema.controlRefreshSessionFamily;
const members = d1Schema.controlRefreshSessionMember;
const nonces = d1Schema.controlConsumedSubjectNonce;

/**
The most members, families and successor envelopes that one pruning pass changes.
*/
export const controlRefreshPrunePageSize = 1000;

interface PreparedControlRefresh {
	readonly credential: RefreshCredential;
	readonly family: typeof d1Schema.controlRefreshSessionFamily.$inferInsert;
	readonly member: typeof d1Schema.controlRefreshSessionMember.$inferInsert;
}

type ControlRotationOutcome = 'rotated' | 'stale-member';

/**
 * What the control plane supplies to its refresh sessions: the D1 database,
 * the keys for its refresh credentials, the current control trust policy, and
 * the signing of access tokens.
 */
export interface ControlRefreshDependencies {
	readonly database: Database;
	readonly keys: RefreshKeyContext;
	readonly selectPolicy: (
		identity: VerifiedOidcClaims,
		grants: AuthorizationDetails
	) => Promise<OidcTrustSelection>;
	readonly issueAccessToken: (
		rule: OidcTrustRule | undefined,
		subject: OidcSubject,
		grants: AuthorizationDetails
	) => Promise<string>;
}

/**
 * The control plane's refresh-token families in D1. They follow the tenant
 * object's families: rotation on every refresh, a one-minute retry grace for
 * the spent credential, revocation on replay, a member limit and a 30-day
 * expiry. D1 has no interactive transactions, so rotation advances the active
 * member with a conditional update in one batch and checks whether the update
 * changed a row.
 */
export class ControlRefreshSessions {
	constructor(private readonly dependencies: ControlRefreshDependencies) {}

	private async retryConsumedToken(
		logger: Logger,
		presented: RefreshCredential,
		member: ControlRefreshMember,
		body: RefreshTokenGrantRequest
	): Promise<TokenResponse> {
		const family = await this.family(member.familyId);

		if (family === undefined) {
			throw new StaleRefreshTokenError();
		}

		const successor = await this.member(family.activeMemberId);
		const spent = await this.member(member.id);
		const now = isoTimestamp(new Date());

		if (
			family.expiresAt <= now ||
			spent?.familyId !== family.id ||
			spent.credentialHash !== member.credentialHash ||
			successor?.familyId !== family.id ||
			successor.generation !== member.generation + 1 ||
			family.generation !== successor.generation ||
			!isWithinRefreshRetryGrace(successor.createdAt, now)
		) {
			await this.revokeFamily(family.id);
			logFamilyRevocation(logger, 'replay');
			throw new StaleRefreshTokenError();
		}

		const value = await openRefreshSuccessor(
			this.dependencies.keys,
			presented,
			successor.id,
			spent.successorEnvelope
		);
		const credential =
			value === undefined ? undefined : RefreshCredential.parse(value);
		const authority = await credential?.authenticate(
			successor.credentialHash,
			this.dependencies.keys
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

		const selection = await this.currentPolicy(authority, authority.grants);

		if (selection.outcome !== 'selected') {
			await this.revokeFamily(family.id);
			throw new StaleRefreshTokenError();
		}

		const accessToken = await this.dependencies.issueAccessToken(
			selection.rule,
			oidcSubjectSchema.parse(authority.identity.sub),
			authority.grants
		);

		if (!(await this.isRetryStillCurrent(authority, family.id, successor))) {
			await this.revokeFamily(family.id);
			throw new StaleRefreshTokenError();
		}

		return {
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: adminJwtTtlSeconds,
			refresh_token: credential.value,
			authorization_details: authority.grants
		};
	}

	// The successor must still be active and within the grace period after the
	// access token is signed, and the policy must still select the identity.
	private async isRetryStillCurrent(
		authority: AuthenticatedRefreshAuthority,
		familyId: string,
		successor: ControlRefreshMember
	): Promise<boolean> {
		const active = await this.dependencies.database
			.select()
			.from(families)
			.where(
				and(
					eq(families.id, familyId),
					eq(families.activeMemberId, successor.id),
					eq(families.generation, successor.generation)
				)
			)
			.get();
		const now = isoTimestamp(new Date());

		if (
			active === undefined ||
			active.expiresAt <= now ||
			!isWithinRefreshRetryGrace(successor.createdAt, now)
		) {
			return false;
		}

		const selection = await this.currentPolicy(authority, authority.grants);

		return selection.outcome === 'selected';
	}

	private currentPolicy(
		authority: AuthenticatedRefreshAuthority,
		grants: AuthorizationDetails
	): Promise<OidcTrustSelection> {
		return this.dependencies.selectPolicy(authority.identity, grants);
	}

	private async prepare(
		identity: VerifiedOidcClaims,
		subject: OidcSubject,
		rule: OidcTrustRule | undefined,
		grants: AuthorizationDetails,
		current?: ControlRefreshFamily
	): Promise<PreparedControlRefresh> {
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
		const credential = await RefreshCredential.issue(
			{
				familyId,
				memberId: id,
				generation,
				expiresAt,
				identity: policyIdentity,
				grants
			},
			this.dependencies.keys
		);

		return {
			credential,
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

	/**
	 * Advances the family from the presented member to the successor. The
	 * update matches only while the presented member is still active, and the
	 * later statements in the batch apply only once the successor is active.
	 * A concurrent rotation that won therefore leaves this batch with no
	 * effect.
	 */
	private async rotate(
		family: ControlRefreshFamily,
		member: ControlRefreshMember,
		successor: PreparedControlRefresh,
		envelope: string
	): Promise<ControlRotationOutcome> {
		const { database } = this.dependencies;
		const successorId = successor.member.id;
		const now = isoTimestamp(new Date());
		const activeSuccessorCondition = and(
			eq(families.id, family.id),
			eq(families.activeMemberId, successorId)
		);
		const successorIsActive = database
			.select({ id: families.id })
			.from(families)
			.where(activeSuccessorCondition);
		const successorDeadline = isoTimestamp(
			new Date(
				Date.parse(successor.member.createdAt) + refreshTokenRetryGraceMs
			)
		);
		const advance = database
			.update(families)
			.set({
				activeMemberId: successorId,
				generation: successor.member.generation,
				rule: successor.family.rule ?? sql`NULL`
			})
			.where(
				and(
					eq(families.id, family.id),
					eq(families.activeMemberId, member.id),
					eq(families.generation, member.generation),
					gt(families.expiresAt, now)
				)
			)
			.returning({ id: families.id });
		const insertSuccessor = database.insert(members).select(
			database
				.select({
					id: sql<string>`${successorId}`.as('id'),
					familyId: families.id,
					generation: families.generation,
					credentialHash: sql<string>`${successor.member.credentialHash}`.as(
						'credential_hash'
					),
					successorEnvelope: sql<string | null>`NULL`.as('successor_envelope'),
					successorExpiresAt: sql<IsoTimestamp | null>`NULL`.as(
						'successor_expires_at'
					),
					createdAt: sql<IsoTimestamp>`${successor.member.createdAt}`.as(
						'created_at'
					)
				})
				.from(families)
				.where(activeSuccessorCondition)
		);
		const storeEnvelope = database
			.update(members)
			.set({
				successorEnvelope: envelope,
				successorExpiresAt: successorDeadline
			})
			.where(and(eq(members.id, member.id), exists(successorIsActive)));
		const clearOlderEnvelope = database
			.update(members)
			.set({ successorEnvelope: sql`NULL`, successorExpiresAt: sql`NULL` })
			.where(
				and(
					eq(members.familyId, family.id),
					eq(members.generation, member.generation - 1),
					exists(successorIsActive)
				)
			);
		const [advanced] = await database.batch([
			advance,
			insertSuccessor,
			storeEnvelope,
			clearOlderEnvelope
		]);

		return advanced.length > 0 ? 'rotated' : 'stale-member';
	}

	private async revokeFamily(familyId: string): Promise<boolean> {
		const { database } = this.dependencies;
		const [, deleted] = await database.batch([
			database.delete(members).where(eq(members.familyId, familyId)),
			database
				.delete(families)
				.where(eq(families.id, familyId))
				.returning({ id: families.id })
		]);

		return deleted.length > 0;
	}

	private family(id: string): Promise<ControlRefreshFamily | undefined> {
		return this.dependencies.database
			.select()
			.from(families)
			.where(eq(families.id, id))
			.get();
	}

	private member(id: string): Promise<ControlRefreshMember | undefined> {
		return this.dependencies.database
			.select()
			.from(members)
			.where(eq(members.id, id))
			.get();
	}

	/**
	 * Creates a family for a verified external identity and returns its first
	 * refresh credential. With `nonce`, one batch records the nonce as consumed
	 * and creates the family. When the nonce is already recorded, the batch
	 * changes nothing and the method throws `SubjectTokenReplayedError`.
	 */
	async create(
		identity: VerifiedOidcClaims,
		subject: OidcSubject,
		rule: OidcTrustRule | undefined,
		grants: AuthorizationDetails,
		nonce?: SubjectNonce
	): Promise<{
		readonly familyId: RefreshSessionId;
		readonly refreshToken: string;
	}> {
		const prepared = await this.prepare(identity, subject, rule, grants);
		const created = {
			familyId: refreshSessionIdSchema.parse(prepared.family.id),
			refreshToken: prepared.credential.value
		};
		const { database } = this.dependencies;

		if (nonce === undefined) {
			await database.batch([
				database.insert(families).values(prepared.family),
				database.insert(members).values(prepared.member)
			]);

			return created;
		}

		// Each insert below selects from the nonce row only when that row has this
		// family's id. The id is new, so the row has it only when the first
		// statement inserted the row.
		const { family, member } = prepared;
		const consumedForFamily = and(
			eq(nonces.nonce, nonce.nonce),
			eq(nonces.familyId, family.id)
		);
		const insertFamily = database.insert(families).select(
			database
				.select({
					id: sql<string>`${family.id}`.as('id'),
					activeMemberId: sql<string>`${family.activeMemberId}`.as(
						'active_member_id'
					),
					generation: sql<number>`${family.generation}`.as('generation'),
					createdAt: sql<IsoTimestamp>`${family.createdAt}`.as('created_at'),
					expiresAt: sql<IsoTimestamp>`${family.expiresAt}`.as('expires_at'),
					issuer: sql<string>`${family.issuer}`.as('issuer'),
					subject: sql<string>`${family.subject}`.as('subject'),
					rule: sql<string | null>`${family.rule ?? sql`NULL`}`.as('rule')
				})
				.from(nonces)
				.where(consumedForFamily)
		);
		const insertMember = database.insert(members).select(
			database
				.select({
					id: sql<string>`${member.id}`.as('id'),
					familyId: sql<string>`${member.familyId}`.as('family_id'),
					generation: sql<number>`${member.generation}`.as('generation'),
					credentialHash: sql<string>`${member.credentialHash}`.as(
						'credential_hash'
					),
					successorEnvelope: sql<string | null>`NULL`.as('successor_envelope'),
					successorExpiresAt: sql<IsoTimestamp | null>`NULL`.as(
						'successor_expires_at'
					),
					createdAt: sql<IsoTimestamp>`${member.createdAt}`.as('created_at')
				})
				.from(nonces)
				.where(consumedForFamily)
		);
		const [consumed] = await database.batch([
			consumeControlSubjectNonce(database, nonce, family.id),
			insertFamily,
			insertMember
		]);

		if (consumed.length === 0) {
			throw new SubjectTokenReplayedError();
		}

		return created;
	}

	async refresh(
		logger: Logger,
		body: RefreshTokenGrantRequest
	): Promise<TokenResponse> {
		const presented = RefreshCredential.parse(body.refresh_token);

		if (presented === undefined) {
			throw new StaleRefreshTokenError();
		}

		const member = await this.member(presented.id);

		if (member === undefined) {
			throw new StaleRefreshTokenError();
		}

		const authority = await presented.authenticate(
			member.credentialHash,
			this.dependencies.keys
		);
		const family = await this.family(member.familyId);

		if (authority === undefined || family === undefined) {
			throw new StaleRefreshTokenError();
		}

		if (family.expiresAt <= isoTimestamp(new Date())) {
			await this.revokeFamily(family.id);
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
		const selection = await this.currentPolicy(authority, grants);

		if (selection.outcome !== 'selected') {
			await this.revokeFamily(family.id);
			throw new StaleRefreshTokenError();
		}

		if (family.generation >= maxRefreshTokenFamilyMembers - 1) {
			await this.revokeFamily(family.id);
			logFamilyRevocation(logger, 'member-limit');
			throw new StaleRefreshTokenError();
		}

		const subject = oidcSubjectSchema.parse(authority.identity.sub);
		const accessToken = await this.dependencies.issueAccessToken(
			selection.rule,
			subject,
			grants
		);
		const successor = await this.prepare(
			authority.identity,
			subject,
			selection.rule,
			grants,
			family
		);
		const envelope = await sealRefreshSuccessor(
			this.dependencies.keys,
			presented,
			successor.credential
		);
		const rotation = await this.rotate(family, member, successor, envelope);

		if (rotation === 'stale-member') {
			return this.retryConsumedToken(logger, presented, member, body);
		}

		// D1 cannot evaluate the policy inside the rotation batch, so check it
		// again after the commit. If current policy no longer permits the grants,
		// revoke the family.
		const committed = await this.currentPolicy(authority, grants);

		if (committed.outcome !== 'selected') {
			await this.revokeFamily(family.id);
			throw new StaleRefreshTokenError();
		}

		return {
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: adminJwtTtlSeconds,
			refresh_token: successor.credential.value,
			authorization_details: grants
		};
	}

	/**
	 * Revokes the family of a presented credential. An unknown or forged
	 * credential changes nothing, and it is hashed like a known one so the
	 * response time does not show whether its member exists.
	 */
	async revokePresented(
		logger: Logger,
		presented: RefreshCredential
	): Promise<void> {
		const member = await this.member(presented.id);
		const authority = await presented.authenticate(
			member?.credentialHash ?? unknownMemberCredentialHash,
			this.dependencies.keys
		);

		if (member === undefined || authority?.familyId !== member.familyId) {
			return;
		}

		await this.revokeFamily(member.familyId);
		logger.info('refresh-token family revoked', {
			reason: 'revocation-request'
		});
	}

	async list(): Promise<RefreshSessionListResponseInput> {
		const now = isoTimestamp(new Date());
		const live = await this.dependencies.database
			.select()
			.from(families)
			.where(gt(families.expiresAt, now))
			.orderBy(asc(families.createdAt), asc(families.id))
			.all();

		return {
			sessions: live.map((family) => ({
				id: family.id,
				issuer: family.issuer,
				subject: family.subject,
				...(family.rule !== null && { rule: family.rule }),
				createdAt: family.createdAt,
				expiresAt: family.expiresAt
			}))
		};
	}

	async revoke(
		id: RefreshSessionId
	): Promise<RefreshSessionRevokeResponseInput> {
		return { id, revoked: await this.revokeFamily(id) };
	}
}

function logFamilyRevocation(
	logger: Logger,
	reason: 'member-limit' | 'replay'
): void {
	logger.warn('refresh-token family revoked', { reason });
}

/**
 * Deletes expired control refresh families, and clears successor envelopes
 * whose retry grace has passed, up to one page of each kind per call. A family
 * can have more members than a page, so a family row is deleted only once it
 * has no members left, and the next call continues with the rest.
 */
export async function pruneControlRefreshSessions(
	database: Database,
	now: IsoTimestamp
): Promise<{ membersDeleted: number; familiesDeleted: number }> {
	const expiredFamilies = database
		.select({ id: families.id })
		.from(families)
		.where(lte(families.expiresAt, now))
		.orderBy(asc(families.expiresAt), asc(families.id))
		.limit(controlRefreshPrunePageSize);
	const expiredMembers = database
		.select({ id: members.id })
		.from(members)
		.where(inArray(members.familyId, expiredFamilies))
		.limit(controlRefreshPrunePageSize);
	const familyMembers = database
		.select({ id: members.id })
		.from(members)
		.where(eq(members.familyId, families.id));
	const emptyExpiredFamilies = database
		.select({ id: families.id })
		.from(families)
		.where(and(lte(families.expiresAt, now), notExists(familyMembers)))
		.limit(controlRefreshPrunePageSize);
	const expiredEnvelopes = database
		.select({ id: members.id })
		.from(members)
		.where(
			and(
				isNotNull(members.successorExpiresAt),
				lt(members.successorExpiresAt, now)
			)
		)
		.orderBy(asc(members.successorExpiresAt), asc(members.id))
		.limit(controlRefreshPrunePageSize);
	const [deletedMembers, deletedFamilies] = await database.batch([
		database
			.delete(members)
			.where(inArray(members.id, expiredMembers))
			.returning({ id: members.id }),
		database
			.delete(families)
			.where(inArray(families.id, emptyExpiredFamilies))
			.returning({ id: families.id }),
		database
			.update(members)
			.set({ successorEnvelope: sql`NULL`, successorExpiresAt: sql`NULL` })
			.where(inArray(members.id, expiredEnvelopes))
	]);

	return {
		membersDeleted: deletedMembers.length,
		familiesDeleted: deletedFamilies.length
	};
}
