import { bytesToHex } from '@cupboard/nix-store/encoding';
import {
	type AccessKeyCreateRequest,
	type AccessKeyCreateResponse,
	type AccessKeyDeleteResponse,
	type AccessKeyId,
	accessKeyIdSchema,
	accessKeyListPageSize,
	type AccessKeyListRequest,
	type AccessKeyListResponse,
	type AccessKeyParent,
	accessKeyParentSchema,
	accessKeySecretPrefix,
	accessKeySecretSchema,
	type AccessKeySummary,
	type UnreadableAccessKey
} from '@cupboard/protocol/access-keys';
import {
	type AuthorizationDetails,
	grantsWithoutRetiredOperationsSchema,
	isAccessKeyCovered
} from '@cupboard/protocol/grants';
import { type OidcSubject, type TrustRuleId } from '@cupboard/protocol/oidc';
import { type VerifiedOidcClaims } from '@cupboard/protocol/oidc-trust-match';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	asc,
	count,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lte,
	notExists,
	or,
	type SQL,
	sql
} from 'drizzle-orm';

import { type AccessIdentityKeyContext } from '../auth/access-identity.ts';
import {
	oidcPolicyIdentity,
	recordedOidcIdentity
} from '../auth/oidc-identity.ts';
import { type Principal, type VerifiedAccessKey } from '../auth/principal.ts';
import { sha256Hex } from '../crypto/crypto.ts';
import {
	accessKeyAncestors,
	accessKeys,
	accessKeyState,
	refreshTokenFamilies
} from '../db/schema.ts';
import {
	AccessKeyExpiryPastError,
	AccessKeyLimitError,
	AccessKeyRefusedError,
	InvalidAccessTokenError
} from '../errors.ts';

import { type SchemaWriter } from './context.ts';
import { jsonValueList } from './json-list.ts';

/**
The limits on how many access keys can exist. The depth and origin limits
count only unexpired keys. The tenant limit counts every stored key, because
it reads a count that triggers keep. An expired key counts until collection
deletes it.
*/
export interface AccessKeyLimits {
	/**
	The most keys in a chain below a session, or below a key without a parent.
	A key that a token creates is at depth 1.
	*/
	readonly depth: number;
	/**
	The most keys of one origin. The origin of a key below a session is the
	session. The origin of a key without a session is the subject that created
	the first key of its chain. The limit bounds how many keys one revocation
	deletes, and how many keys one credential can create.
	*/
	readonly origin: number;
	/**
	The most keys in a tenant, whatever their origin. It bounds the storage
	that keys use.
	*/
	readonly tenant: number;
}

export const accessKeyLimits: AccessKeyLimits = {
	depth: 3,
	origin: 256,
	tenant: 10_000
};

/**
Where the keys of a chain start: a sign-in session, or the subject that
created a key without a parent.
*/
type AccessKeyOrigin =
	| { readonly kind: 'session'; readonly id: string }
	| { readonly kind: 'subject'; readonly subject: OidcSubject };

/**
The principal that creates an access key. `parent` is the parent that its
keys record: the session of a token, the key itself for an access key, or
none for a token without a session. `identity` and `ruleId` are the root of
the creator's lineage. The caller's authority over the requested grants and
expiry is checked before the store is called.
*/
export interface AccessKeyCreator {
	readonly subject: OidcSubject;
	readonly identity: VerifiedOidcClaims;
	readonly ruleId?: TrustRuleId;
	readonly parent?: AccessKeyParent;
}

/**
Describes a principal as the creator of an access key. A key creates keys
below itself with its own root identity and rule. A token's sealed identity
is opened, and a token whose identity does not open, such as one sealed
before `PUSH_ID_SIGNING_KEY` changed, is refused.
*/
export async function openAccessKeyCreator(
	principal: Principal,
	keys: AccessIdentityKeyContext
): Promise<AccessKeyCreator> {
	if (principal.kind === 'access-key') {
		const { key } = principal;

		return {
			subject: key.creatorSubject,
			identity: key.rootIdentity,
			...(key.rootRule !== undefined && { ruleId: key.rootRule }),
			parent: { kind: 'access-key', id: key.id }
		};
	}

	const { claims } = principal;
	const identity = await claims.identity.open(keys);

	if (identity === undefined) {
		throw new InvalidAccessTokenError();
	}

	return {
		subject: claims.subject,
		identity,
		...(claims.ruleId !== undefined && { ruleId: claims.ruleId }),
		...(claims.sessionId !== undefined && {
			parent: { kind: 'session', id: claims.sessionId }
		})
	};
}

type AccessKeyRow = typeof accessKeys.$inferSelect;

/**
Counts the stored access keys below `ancestor`, at any depth.
*/
export function countAccessKeysBelow(
	database: SchemaWriter,
	ancestor: AccessKeyParent
): number {
	return (
		database
			.select({ count: count() })
			.from(accessKeyAncestors)
			.where(
				and(
					eq(accessKeyAncestors.ancestorKind, ancestor.kind),
					eq(accessKeyAncestors.ancestorId, ancestor.id)
				)
			)
			.get()?.count ?? 0
	);
}

/**
Deletes the access keys below `ancestor`, and the key itself when it is an
access key, with every row that records their ancestry. Returns the number
of deleted keys. Collection keeps the rows in which a collected key is the
ancestor, so a collected key below `ancestor` does not hide the keys below it.
A session that no key remains below is released, as
{@link releaseKeylessFamilies} describes.
*/
export function deleteAccessKeysBelow(
	database: SchemaWriter,
	ancestor: AccessKeyParent
): number {
	const below = database
		.select({ id: accessKeyAncestors.descendantId })
		.from(accessKeyAncestors)
		.where(
			and(
				eq(accessKeyAncestors.ancestorKind, ancestor.kind),
				eq(accessKeyAncestors.ancestorId, ancestor.id)
			)
		);
	const sessions =
		ancestor.kind === 'access-key'
			? sessionsAbove(
					database,
					eq(accessKeyAncestors.descendantId, ancestor.id)
				)
			: [ancestor.id];
	const deleted = database
		.delete(accessKeys)
		.where(
			ancestor.kind === 'access-key'
				? or(eq(accessKeys.id, ancestor.id), inArray(accessKeys.id, below))
				: inArray(accessKeys.id, below)
		)
		.returning({ id: accessKeys.id })
		.all();

	database
		.delete(accessKeyAncestors)
		.where(
			ancestor.kind === 'access-key'
				? or(
						eq(accessKeyAncestors.descendantId, ancestor.id),
						inArray(accessKeyAncestors.descendantId, below)
					)
				: inArray(accessKeyAncestors.descendantId, below)
		)
		.run();

	releaseKeylessFamilies(database, sessions);

	return deleted.length;
}

/**
Returns the sessions above the keys that `descendants` selects from
`access_key_ancestor`. Each key has at most one session above it, at the root
of its lineage.
*/
function sessionsAbove(database: SchemaWriter, descendants: SQL): string[] {
	return database
		.selectDistinct({ id: accessKeyAncestors.ancestorId })
		.from(accessKeyAncestors)
		.where(and(eq(accessKeyAncestors.ancestorKind, 'session'), descendants))
		.all()
		.map((row) => row.id);
}

/**
Clears `retained_by_keys` on each family among `sessions` that has no access
key left below it. Collection then deletes the family once it has expired.
*/
function releaseKeylessFamilies(
	database: SchemaWriter,
	sessions: readonly string[]
): void {
	if (sessions.length === 0) {
		return;
	}

	const keysBelow = database
		.select({ id: accessKeyAncestors.descendantId })
		.from(accessKeyAncestors)
		.where(
			and(
				eq(accessKeyAncestors.ancestorKind, 'session'),
				eq(accessKeyAncestors.ancestorId, refreshTokenFamilies.id)
			)
		);
	const listed = jsonValueList(sessions);

	database
		.update(refreshTokenFamilies)
		.set({ retainedByKeys: false })
		.where(
			and(
				inArray(refreshTokenFamilies.id, listed),
				sql`${refreshTokenFamilies.retainedByKeys} = 1`,
				notExists(keysBelow)
			)
		)
		.run();
}

/**
Stores the tenant's access keys. Only a hash of each secret is stored.
*/
export class AccessKeyStore {
	private isKnownWithoutExpiry = false;

	constructor(
		private readonly database: SchemaWriter,
		private readonly now: () => Date = () => new Date(),
		private readonly limits: AccessKeyLimits = accessKeyLimits
	) {}

	/**
	Stores a new key. It refuses an expiry that has passed, a parent that no
	longer exists and a key beyond the depth, child or tenant limit.
	*/
	async create(
		creator: AccessKeyCreator,
		request: AccessKeyCreateRequest
	): Promise<AccessKeyCreateResponse> {
		const now = this.now();

		if (
			request.expiresAt !== undefined &&
			Date.parse(request.expiresAt) <= now.getTime()
		) {
			throw new AccessKeyExpiryPastError();
		}

		const id = accessKeyIdSchema.parse(crypto.randomUUID());
		const random = crypto.getRandomValues(new Uint8Array(32));
		const secret = accessKeySecretSchema.parse(
			`${accessKeySecretPrefix}${id}_${bytesToHex(random)}`
		);
		const summary: AccessKeySummary = {
			id,
			grants: request.grants,
			...(creator.parent !== undefined && { parent: creator.parent }),
			...(creator.ruleId !== undefined && { rule: creator.ruleId }),
			subject: creator.subject,
			createdAt: isoTimestamp(now),
			...(request.expiresAt !== undefined && { expiresAt: request.expiresAt })
		};
		const row: Omit<typeof accessKeys.$inferInsert, 'sessionAbove'> = {
			id,
			secretHash: await sha256Hex(secret),
			grantsJson: JSON.stringify(summary.grants),
			...(summary.parent !== undefined && {
				parentKind: summary.parent.kind,
				parentId: summary.parent.id
			}),
			rootIdentityJson: JSON.stringify(oidcPolicyIdentity(creator.identity)),
			...(summary.rule !== undefined && { rootRule: summary.rule }),
			creatorSubject: summary.subject,
			createdAt: summary.createdAt,
			...(summary.expiresAt !== undefined && { expiresAt: summary.expiresAt })
		};

		this.database.transaction((transaction) => {
			const ancestry = parentAncestry(transaction, creator, now, this.limits);

			requireTenantCapacity(transaction, this.limits);

			transaction
				.insert(accessKeys)
				.values({
					...row,
					sessionAbove: ancestry.some((ancestor) => ancestor.kind === 'session')
				})
				.run();

			transaction.run(sql`
				INSERT INTO access_key_ancestor (ancestor_kind, ancestor_id, descendant_id)
				SELECT json_extract(ancestor.value, '$.kind'), json_extract(ancestor.value, '$.id'), ${id}
				FROM json_each(${JSON.stringify(ancestry)}) AS ancestor
			`);
		});
		this.isKnownWithoutExpiry = false;

		return { ...summary, secret };
	}

	/**
	Lists one page of the unexpired keys that `grants` can list, in ID order.
	See {@link isAccessKeyCovered}. When this release cannot read a key's
	grants, the key is listed in `unreadableAccessKeys`, and only to a caller
	whose grants cover {@link unreadableKeyAuthority}.
	*/
	list(
		grants: AuthorizationDetails,
		page: AccessKeyListRequest = {}
	): AccessKeyListResponse {
		const now = isoTimestamp(this.now());
		const limit = page.limit ?? accessKeyListPageSize;
		const rows = this.database
			.select()
			.from(accessKeys)
			.where(
				and(
					unexpired(now),
					page.cursor === undefined ? undefined : gt(accessKeys.id, page.cursor)
				)
			)
			.orderBy(asc(accessKeys.id))
			.limit(limit + 1)
			.all();
		const read = rows.slice(0, limit);
		const last = read.at(-1);

		return {
			accessKeys: read
				.flatMap((row) => {
					const summary = accessKeySummary(row);

					return summary === undefined ? [] : [summary];
				})
				.filter((key) =>
					isAccessKeyCovered(grants, 'access-key:list', key.grants)
				),
			unreadableAccessKeys: isAccessKeyCovered(
				grants,
				'access-key:list',
				unreadableKeyAuthority
			)
				? read.flatMap((row) =>
						storedGrants(row.grantsJson) === undefined
							? [unreadableAccessKey(row)]
							: []
					)
				: [],
			...(rows.length > limit && last !== undefined && { cursor: last.id })
		};
	}

	/**
	Returns an unexpired key with its secret hash, or undefined when no key
	has the id or the key has expired.
	*/
	verifiable(
		id: AccessKeyId,
		now: Date
	):
		| { readonly secretHash: string; readonly key: VerifiedAccessKey }
		| undefined {
		const unexpiredKey = and(
			eq(accessKeys.id, id),
			unexpired(isoTimestamp(now))
		);
		const row = this.database
			.select()
			.from(accessKeys)
			.where(unexpiredKey)
			.get();
		const rootIdentity =
			row === undefined
				? undefined
				: recordedOidcIdentity(JSON.parse(row.rootIdentityJson));
		const grants = row === undefined ? undefined : storedGrants(row.grantsJson);

		if (
			row === undefined ||
			rootIdentity === undefined ||
			grants === undefined
		) {
			return undefined;
		}

		return {
			secretHash: row.secretHash,
			key: {
				id: row.id,
				grants,
				...(row.expiresAt !== null && { expiresAt: new Date(row.expiresAt) }),
				creatorSubject: row.creatorSubject,
				rootIdentity,
				...(row.rootRule !== null && { rootRule: row.rootRule })
			}
		};
	}

	/**
	Returns the grants against which the authoriser checks a caller's authority
	over a key, or undefined when no key has the id. For a key whose grants this
	release cannot read, they are {@link unreadableKeyAuthority}.
	*/
	grantsOf(id: AccessKeyId): AuthorizationDetails | undefined {
		const row = this.database
			.select({ grantsJson: accessKeys.grantsJson })
			.from(accessKeys)
			.where(eq(accessKeys.id, id))
			.get();

		return row === undefined
			? undefined
			: (storedGrants(row.grantsJson) ?? unreadableKeyAuthority);
	}

	/**
	Deletes a key and every key below it in one transaction. The authoriser
	checks the caller against {@link grantsOf}, so an id without a row deletes
	nothing.
	*/
	delete(id: AccessKeyId): AccessKeyDeleteResponse {
		return this.database.transaction((transaction) => {
			const row = transaction
				.select({ grantsJson: accessKeys.grantsJson })
				.from(accessKeys)
				.where(eq(accessKeys.id, id))
				.get();
			const hasKey = row !== undefined;

			return {
				id,
				deleted:
					hasKey &&
					deleteAccessKeysBelow(transaction, { kind: 'access-key', id }) > 0
			};
		});
	}

	earliestExpiry(): IsoTimestamp | undefined {
		if (this.isKnownWithoutExpiry) {
			return undefined;
		}

		const expiry =
			this.database
				.select({ at: accessKeys.expiresAt })
				.from(accessKeys)
				.where(isNotNull(accessKeys.expiresAt))
				.orderBy(asc(accessKeys.expiresAt), asc(accessKeys.id))
				.limit(1)
				.get()?.at ?? undefined;

		this.isKnownWithoutExpiry = expiry === undefined;

		return expiry;
	}

	/**
	Deletes up to `limit` expired keys and the rows that record their own
	ancestry. Keys below an expired key remain. Returns whether more expired
	keys may remain.
	*/
	deleteExpired(now: IsoTimestamp, limit: number): boolean {
		const earliest = this.earliestExpiry();

		if (earliest === undefined || earliest > now) {
			return false;
		}

		return this.database.transaction((transaction) => {
			const due = transaction
				.select({ id: accessKeys.id })
				.from(accessKeys)
				.where(
					and(isNotNull(accessKeys.expiresAt), lte(accessKeys.expiresAt, now))
				)
				.orderBy(asc(accessKeys.expiresAt), asc(accessKeys.id))
				.limit(limit);
			const sessions = sessionsAbove(
				transaction,
				inArray(accessKeyAncestors.descendantId, due)
			);

			transaction
				.delete(accessKeyAncestors)
				.where(inArray(accessKeyAncestors.descendantId, due))
				.run();

			const deleted = transaction
				.delete(accessKeys)
				.where(inArray(accessKeys.id, due))
				.returning({ id: accessKeys.id })
				.all();

			releaseKeylessFamilies(transaction, sessions);

			return deleted.length === limit;
		});
	}
}

// Expired keys count until collection deletes them, which the maintenance
// alarm schedules for the earliest expiry.
function requireTenantCapacity(
	database: SchemaWriter,
	limits: AccessKeyLimits
): void {
	const keys =
		database
			.select({ keyCount: accessKeyState.keyCount })
			.from(accessKeyState)
			.get()?.keyCount ?? 0;

	if (keys >= limits.tenant) {
		throw new AccessKeyLimitError('tenant', limits.tenant);
	}
}

// Checks that the parent still exists, that the new key stays within the
// depth limit and that its origin can have another key. Returns the ancestors
// of the new key.
function parentAncestry(
	database: SchemaWriter,
	creator: AccessKeyCreator,
	now: Date,
	limits: AccessKeyLimits
): readonly AccessKeyParent[] {
	const { parent } = creator;
	const at = isoTimestamp(now);
	const subjectOrigin: AccessKeyOrigin = {
		kind: 'subject',
		subject: creator.subject
	};

	if (parent === undefined) {
		requireOriginCapacity(database, subjectOrigin, at, limits);

		return [];
	}

	if (!isParentLive(database, parent, at)) {
		throw new AccessKeyRefusedError('parent-ended');
	}

	if (parent.kind === 'session') {
		requireOriginCapacity(database, parent, at, limits);

		return [parent];
	}

	const above = database
		.select({
			kind: accessKeyAncestors.ancestorKind,
			id: accessKeyAncestors.ancestorId
		})
		.from(accessKeyAncestors)
		.where(eq(accessKeyAncestors.descendantId, parent.id))
		.all()
		.map((ancestor) => ancestorOf(ancestor.kind, ancestor.id));
	const depth =
		above.filter((ancestor) => ancestor.kind === 'access-key').length + 2;

	if (depth > limits.depth) {
		throw new AccessKeyLimitError('depth', limits.depth);
	}

	const session = above.find((ancestor) => ancestor.kind === 'session');

	requireOriginCapacity(database, session ?? subjectOrigin, at, limits);

	return [...above, parent];
}

// A key created by a key has the subject of the key that created it, so the
// unexpired keys of a subject that have no session above them are the keys of
// that subject's origin.
function requireOriginCapacity(
	database: SchemaWriter,
	origin: AccessKeyOrigin,
	now: IsoTimestamp,
	limits: AccessKeyLimits
): void {
	const keys =
		origin.kind === 'session'
			? sessionOriginCount(database, origin.id, now)
			: subjectOriginCount(database, origin.subject, now);

	if (keys >= limits.origin) {
		throw new AccessKeyLimitError('origin', limits.origin);
	}
}

// Starts from the ancestor rows of the session, so it reads only the keys
// below the session.
function sessionOriginCount(
	database: SchemaWriter,
	session: string,
	now: IsoTimestamp
): number {
	return (
		database
			.select({ count: count() })
			.from(accessKeyAncestors)
			.innerJoin(accessKeys, eq(accessKeys.id, accessKeyAncestors.descendantId))
			.where(
				and(
					eq(accessKeyAncestors.ancestorKind, 'session'),
					eq(accessKeyAncestors.ancestorId, session),
					unexpired(now)
				)
			)
			.get()?.count ?? 0
	);
}

// Reads the subject's keys without a session above them through
// `access_key_subject_origin_idx`.
function subjectOriginCount(
	database: SchemaWriter,
	subject: OidcSubject,
	now: IsoTimestamp
): number {
	return (
		database
			.select({ count: count() })
			.from(accessKeys)
			.where(
				and(
					eq(accessKeys.creatorSubject, subject),
					sql`${accessKeys.sessionAbove} = 0`,
					unexpired(now)
				)
			)
			.get()?.count ?? 0
	);
}

function isParentLive(
	database: SchemaWriter,
	parent: AccessKeyParent,
	now: IsoTimestamp
): boolean {
	if (parent.kind === 'session') {
		return (
			database
				.select({ id: refreshTokenFamilies.id })
				.from(refreshTokenFamilies)
				.where(
					and(
						eq(refreshTokenFamilies.id, parent.id),
						gt(refreshTokenFamilies.expiresAt, now),
						isNull(refreshTokenFamilies.replayedAt)
					)
				)
				.get() !== undefined
		);
	}

	return (
		database
			.select({ id: accessKeys.id })
			.from(accessKeys)
			.where(and(eq(accessKeys.id, parent.id), unexpired(now)))
			.get() !== undefined
	);
}

function unexpired(now: IsoTimestamp): SQL | undefined {
	return or(isNull(accessKeys.expiresAt), gt(accessKeys.expiresAt, now));
}

function ancestorOf(
	kind: AccessKeyParent['kind'],
	id: string
): AccessKeyParent {
	return accessKeyParentSchema.parse({ kind, id });
}

// Returns undefined for grants that this release cannot read. The release
// ignores operations that it does not know and drops a grant with no operation
// left. The grants are unreadable when no grant remains, or when a grant has a
// type or a binding that the release does not know. Such a key stays inert, so
// that it works again after a roll-forward. It cannot be verified, and only a
// wildcard holder can list it or delete it by id, as `unreadableKeyAuthority`
// decides.
function storedGrants(grantsJson: string): AuthorizationDetails | undefined {
	const parsed = grantsWithoutRetiredOperationsSchema.safeParse(
		JSON.parse(grantsJson)
	);

	return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
}

/**
The grants against which a caller's authority over a key with unreadable
grants is checked. No other grant can be checked against such a key, so only
a wildcard holder can list it or delete it.
*/
const unreadableKeyAuthority: AuthorizationDetails = [
	{ type: 'cupboard_wildcard' }
];

function unreadableAccessKey(row: AccessKeyRow): UnreadableAccessKey {
	return {
		id: row.id,
		...(row.parentKind !== null &&
			row.parentId !== null && {
				parent: ancestorOf(row.parentKind, row.parentId)
			}),
		...(row.rootRule !== null && { rule: row.rootRule }),
		subject: row.creatorSubject,
		createdAt: row.createdAt,
		...(row.expiresAt !== null && { expiresAt: row.expiresAt })
	};
}

function accessKeySummary(row: AccessKeyRow): AccessKeySummary | undefined {
	const grants = storedGrants(row.grantsJson);

	if (grants === undefined) {
		return undefined;
	}

	return {
		id: row.id,
		grants,
		...(row.parentKind !== null &&
			row.parentId !== null && {
				parent: ancestorOf(row.parentKind, row.parentId)
			}),
		...(row.rootRule !== null && { rule: row.rootRule }),
		subject: row.creatorSubject,
		createdAt: row.createdAt,
		...(row.expiresAt !== null && { expiresAt: row.expiresAt })
	};
}
