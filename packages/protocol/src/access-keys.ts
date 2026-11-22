import { z } from 'zod';

import { authorizationDetailsSchema } from './grants.ts';
import { oidcSubjectSchema, trustRuleIdSchema } from './oidc.ts';
import { isoTimestamp, isoTimestampSchema } from './scalars.ts';
import { refreshSessionIdSchema } from './sessions.ts';

export const accessKeyIdSchema = z.uuid().brand('AccessKeyId');
export type AccessKeyId = z.output<typeof accessKeyIdSchema>;

/**
The prefix of every access-key secret. A secret is
`cupboard_ak_<id>_<random>`, so a secret scanner can recognise a leaked key
and the server can find its record without a search.
*/
export const accessKeySecretPrefix = 'cupboard_ak_';

export const accessKeySecretSchema = z
	.string()
	.regex(
		/^cupboard_ak_[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}_[\da-f]{64}$/u
	)
	.brand('AccessKeySecret');
export type AccessKeySecret = z.output<typeof accessKeySecretSchema>;

/**
Returns the id of the key that a well-formed secret belongs to.
*/
export function accessKeyIdOf(secret: AccessKeySecret): AccessKeyId {
	return accessKeyIdSchema.parse(
		secret.slice(
			accessKeySecretPrefix.length,
			accessKeySecretPrefix.length + 36
		)
	);
}

/**
The most grants that one access key can contain.
*/
export const maxAccessKeyGrants = 64;

/**
The principal that created an access key: a sign-in session, or another
access key.
*/
export const accessKeyParentSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('session'), id: refreshSessionIdSchema }),
	z.strictObject({ kind: z.literal('access-key'), id: accessKeyIdSchema })
]);
export type AccessKeyParent = z.output<typeof accessKeyParentSchema>;

/**
An access key without its secret. A key has no parent when a token without
a session created it. It has no rule when several trust rules together
covered the grants of its creator. A key without `expiresAt` does not expire.
*/
export const accessKeySummarySchema = z.strictObject({
	id: accessKeyIdSchema,
	grants: authorizationDetailsSchema.min(1),
	parent: accessKeyParentSchema.optional(),
	rule: trustRuleIdSchema.optional(),
	subject: oidcSubjectSchema,
	createdAt: isoTimestampSchema,
	expiresAt: isoTimestampSchema.optional()
});
export type AccessKeySummary = z.output<typeof accessKeySummarySchema>;

/**
The expiry of a new access key: an ISO 8601 date and time in UTC.
*/
export const accessKeyExpirySchema = z.iso
	.datetime()
	.transform((value) => isoTimestamp(new Date(value)));

export const accessKeyCreateRequestSchema = z.strictObject({
	grants: authorizationDetailsSchema.min(1).max(maxAccessKeyGrants),
	expiresAt: accessKeyExpirySchema.optional()
});
export type AccessKeyCreateRequest = z.output<
	typeof accessKeyCreateRequestSchema
>;

/**
A new access key. The response is the only place where the secret appears.
*/
export const accessKeyCreateResponseSchema = accessKeySummarySchema.extend({
	secret: accessKeySecretSchema
});
export type AccessKeyCreateResponse = z.output<
	typeof accessKeyCreateResponseSchema
>;

/**
A stored access key with grants that this release cannot read. A release ignores
operations that it does not know and drops a grant with no operation left. A
key is unreadable when none of its grants remain, or when one of them has a
type or a binding that the release does not know. It stays stored but cannot
be used. Only a wildcard holder sees it in a listing, and only a
wildcard holder can delete it.
*/
export const unreadableAccessKeySchema = accessKeySummarySchema.omit({
	grants: true
});
export type UnreadableAccessKey = z.output<typeof unreadableAccessKeySchema>;

/**
The most keys in one page of a listing. A key can have up to
{@link maxAccessKeyGrants} grants, so this bounds the size of a response.
*/
export const accessKeyListPageSize = 100;

/**
A page of a listing. Pass `cursor` from the previous page to continue it.
*/
export const accessKeyListRequestSchema = z.strictObject({
	cursor: accessKeyIdSchema.optional(),
	limit: z.number().int().min(1).max(accessKeyListPageSize).optional()
});
export type AccessKeyListRequest = z.output<typeof accessKeyListRequestSchema>;

/**
One page of the keys that the caller can list, in ID order. A page can have
fewer keys than the limit, or none, and still have a `cursor`, because the
server reads up to the limit and returns only the keys that the caller can
list. `unreadableAccessKeys` lists the page's unreadable keys to a wildcard
holder and is empty for every other caller. The listing ends at the first page
without a `cursor`.
*/
export const accessKeyListResponseSchema = z.strictObject({
	accessKeys: z.array(accessKeySummarySchema),
	unreadableAccessKeys: z.array(unreadableAccessKeySchema),
	cursor: accessKeyIdSchema.optional()
});
export type AccessKeyListResponse = z.output<
	typeof accessKeyListResponseSchema
>;

export const accessKeyDeleteResponseSchema = z.strictObject({
	id: accessKeyIdSchema,
	deleted: z.boolean()
});
export type AccessKeyDeleteResponse = z.output<
	typeof accessKeyDeleteResponseSchema
>;

/**
Why the caller may not create an access key:

- `grants-not-covered`: the caller's grants do not cover every requested
  grant.
- `expiry-required`: the caller needs `access-key:create` for every
  requested grant to create a key without an expiry.
- `expiry-beyond-creator`: the caller needs `access-key:create` for every
  requested grant to create a key that outlives its own credential.
- `parent-ended`: the caller's session or key no longer exists.
*/
export const accessKeyRefusalProblemSchema = z.enum([
	'grants-not-covered',
	'expiry-required',
	'expiry-beyond-creator',
	'parent-ended'
]);
export type AccessKeyRefusalProblem = z.output<
	typeof accessKeyRefusalProblemSchema
>;

export const accessKeyRefusedErrorCode = 'ACCESS_KEY_REFUSED';
export const accessKeyRefusedErrorDataSchema = z.strictObject({
	problem: accessKeyRefusalProblemSchema
});

/**
The limit that a new access key would exceed: the length of the chain of
keys above it, the number of unexpired keys of its origin (its session, or
the subject that created the first key of a chain without a session), or the
number of keys in the tenant, which includes expired keys until collection
deletes them.
*/
export const accessKeyLimitSchema = z.enum(['depth', 'origin', 'tenant']);
export type AccessKeyLimit = z.output<typeof accessKeyLimitSchema>;

export const accessKeyLimitErrorCode = 'ACCESS_KEY_LIMIT';
export const accessKeyLimitErrorDataSchema = z.strictObject({
	limit: accessKeyLimitSchema,
	maximum: z.number().int().positive()
});
