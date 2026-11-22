import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type AccessKeyId,
	accessKeyIdSchema,
	type AccessKeyLimit,
	type AccessKeyRefusalProblem
} from '@cupboard/protocol/access-keys';
import {
	type AuthorizationDetail,
	authorizationDetailSchema
} from '@cupboard/protocol/grants';
import { oidcSubjectSchema, trustRuleIdSchema } from '@cupboard/protocol/oidc';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { refreshSessionIdSchema } from '@cupboard/protocol/sessions';
import { runInDurableObject } from 'cloudflare:test';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '../crypto/crypto.ts';
import {
	accessKeyAncestors,
	accessKeys,
	refreshTokenFamilies
} from '../db/schema.ts';
import {
	AccessKeyExpiryPastError,
	AccessKeyLimitError,
	AccessKeyRefusedError
} from '../errors.ts';
import {
	currentServer,
	latestMigrationIndex,
	migrateThrough,
	resetTestServer,
	testTokenIdentity,
	underOneUnitOfWork
} from '../test-support.ts';

import {
	type AccessKeyCreator,
	type AccessKeyLimits,
	accessKeyLimits,
	AccessKeyStore,
	deleteAccessKeysBelow
} from './access-key-store.ts';
import { type ServerContext } from './context.ts';
import { phaseStepSize } from './garbage-collection-service.ts';
import { markFamilyReplayed } from './refresh-sessions-service.ts';
import { gcContinuationKey } from './server.ts';

const now = new Date('2001-01-01T00:00:00.000Z');
const withinToken = isoTimestamp(new Date(now.getTime() + 10 * 60 * 1000));
const session = refreshSessionIdSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const otherSession = refreshSessionIdSchema.parse(
	'00000000-0000-4000-8000-000000000002'
);
const alice = oidcSubjectSchema.parse('alice');
const rule = trustRuleIdSchema.parse('acme-admin');

function cacheGrant(
	name: string,
	actions: readonly string[]
): AuthorizationDetail {
	return authorizationDetailSchema.parse({
		type: 'cupboard_cache',
		cache: { kind: 'named', name },
		actions
	});
}

const readBuilds = cacheGrant('builds', ['cache:content-read']);
const readRelease = cacheGrant('release', ['cache:content-read']);
const wildcard: AuthorizationDetail[] = [{ type: 'cupboard_wildcard' }];

function tokenCreator(
	fields: Partial<AccessKeyCreator> = {}
): AccessKeyCreator {
	return {
		subject: alice,
		identity: testTokenIdentity('alice'),
		ruleId: rule,
		parent: { kind: 'session', id: session },
		...fields
	};
}

function parentlessCreator(subject: string): AccessKeyCreator {
	return tokenCreator({
		parent: undefined,
		subject: oidcSubjectSchema.parse(subject)
	});
}

function keyCreator(id: AccessKeyId): AccessKeyCreator {
	return tokenCreator({ parent: { kind: 'access-key', id } });
}

function insertSession(context: ServerContext, id: string = session): void {
	context.db
		.insert(refreshTokenFamilies)
		.values({
			id,
			activeMemberId: crypto.randomUUID(),
			generation: 0,
			createdAt: isoTimestamp(now),
			expiresAt: isoTimestamp(new Date('2099-01-01T00:00:00.000Z'))
		})
		.run();
}

function withStore<T>(
	body: (store: AccessKeyStore, context: ServerContext) => Promise<T> | T,
	limits: AccessKeyLimits = accessKeyLimits
): Promise<T> {
	return runInDurableObject(currentServer(), async (instance, state) => {
		await migrateThrough(state, latestMigrationIndex);
		insertSession(instance.context);

		return body(
			new AccessKeyStore(instance.context.db, () => now, limits),
			instance.context
		);
	});
}

type CreationOutcome =
	| 'created'
	| 'expiry-past'
	| AccessKeyRefusalProblem
	| { readonly limit: AccessKeyLimit; readonly maximum: number };

async function outcomeOf(creating: Promise<unknown>): Promise<CreationOutcome> {
	try {
		await creating;

		return 'created';
	} catch (error) {
		if (error instanceof AccessKeyRefusedError) {
			return error.problem;
		}

		if (error instanceof AccessKeyLimitError) {
			return { limit: error.limit, maximum: error.maximum };
		}

		if (error instanceof AccessKeyExpiryPastError) {
			return 'expiry-past';
		}

		throw error;
	}
}

// The `retained_by_keys` flag of the session's family.
function retainedFamily(context: ServerContext): boolean | undefined {
	return context.db
		.select({ retained: refreshTokenFamilies.retainedByKeys })
		.from(refreshTokenFamilies)
		.where(eq(refreshTokenFamilies.id, session))
		.get()?.retained;
}

function storedKeyIds(context: ServerContext): string[] {
	return context.db
		.select({ id: accessKeys.id })
		.from(accessKeys)
		.orderBy(asc(accessKeys.createdAt), asc(accessKeys.id))
		.all()
		.map((key) => key.id);
}

function storedAncestry(context: ServerContext): unknown[] {
	return context.db
		.select()
		.from(accessKeyAncestors)
		.orderBy(
			asc(accessKeyAncestors.descendantId),
			asc(accessKeyAncestors.ancestorKind)
		)
		.all();
}

describe('access-key creation', () => {
	beforeEach(resetTestServer);

	it('refuses an expiry that has passed', async () => {
		const result = await withStore(async (store, context) => ({
			outcome: await outcomeOf(
				store.create(tokenCreator(), {
					grants: [readBuilds],
					expiresAt: isoTimestamp(now)
				})
			),
			stored: storedKeyIds(context)
		}));

		expect(result).toStrictEqual({ outcome: 'expiry-past', stored: [] });
	});

	it('returns the secret once and stores its hash, root and ancestry', async () => {
		const result = await withStore(async (store, context) => {
			const created = await store.create(tokenCreator(), {
				grants: [readBuilds],
				expiresAt: withinToken
			});

			return {
				created,
				rows: context.db.select().from(accessKeys).all(),
				ancestry: storedAncestry(context),
				listed: store.list([{ type: 'cupboard_wildcard' }])
			};
		});
		const { id, secret } = result.created;
		const summary = {
			id,
			grants: [readBuilds],
			parent: { kind: 'session', id: session },
			rule,
			subject: alice,
			createdAt: isoTimestamp(now),
			expiresAt: withinToken
		};

		const secretFormat = new RegExp(`^cupboard_ak_${id}_[0-9a-f]{64}$`, 'u');
		const secretHash = await sha256Hex(secret);

		expect({
			...result,
			isSecretFormatted: secretFormat.test(secret)
		}).toStrictEqual({
			created: { ...summary, secret },
			rows: [
				{
					id,
					secretHash,
					grantsJson: JSON.stringify([readBuilds]),
					parentKind: 'session',
					parentId: session,
					rootIdentityJson: JSON.stringify(testTokenIdentity('alice')),
					rootRule: rule,
					creatorSubject: alice,
					createdAt: isoTimestamp(now),
					expiresAt: withinToken,
					sessionAbove: true
				}
			],
			ancestry: [
				{ ancestorKind: 'session', ancestorId: session, descendantId: id }
			],
			listed: { accessKeys: [summary], unreadableAccessKeys: [] },
			isSecretFormatted: true
		});
	});

	it('refuses a key below a session that no longer exists', async () => {
		const unknownSession = refreshSessionIdSchema.parse(crypto.randomUUID());
		const result = await withStore(async (store, context) => ({
			outcome: await outcomeOf(
				store.create(
					tokenCreator({
						parent: {
							kind: 'session',
							id: unknownSession
						}
					}),
					{ grants: [readBuilds], expiresAt: withinToken }
				)
			),
			stored: storedKeyIds(context)
		}));

		expect(result).toStrictEqual({ outcome: 'parent-ended', stored: [] });
	});

	it(`refuses a key below a chain of ${String(accessKeyLimits.depth)} keys`, async () => {
		const result = await withStore(async (store, context) => {
			let parent = await store.create(tokenCreator(), {
				grants: [readBuilds]
			});

			for (let depth = 2; depth <= accessKeyLimits.depth; depth++) {
				parent = await store.create(keyCreator(parent.id), {
					grants: [readBuilds]
				});
			}

			return {
				outcome: await outcomeOf(
					store.create(keyCreator(parent.id), { grants: [readBuilds] })
				),
				stored: storedKeyIds(context).length
			};
		});

		expect(result).toStrictEqual({
			outcome: { limit: 'depth', maximum: accessKeyLimits.depth },
			stored: accessKeyLimits.depth
		});
	});

	const smallLimits: AccessKeyLimits = { depth: 3, origin: 3, tenant: 5 };

	it('refuses a key beyond the origin limit of a session, counting every key below it', async () => {
		const result = await withStore(async (store, context) => {
			const first = await store.create(tokenCreator(), {
				grants: [readBuilds],
				expiresAt: withinToken
			});
			await store.create(tokenCreator(), {
				grants: [readBuilds],
				expiresAt: withinToken
			});
			await store.create(keyCreator(first.id), {
				grants: [readBuilds],
				expiresAt: withinToken
			});
			const belowSession = await outcomeOf(
				store.create(tokenCreator(), {
					grants: [readBuilds],
					expiresAt: withinToken
				})
			);
			const belowKey = await outcomeOf(
				store.create(keyCreator(first.id), {
					grants: [readBuilds],
					expiresAt: withinToken
				})
			);
			insertSession(context, otherSession);
			const otherOrigin = await outcomeOf(
				store.create(
					tokenCreator({ parent: { kind: 'session', id: otherSession } }),
					{
						grants: [readBuilds],
						expiresAt: withinToken
					}
				)
			);

			return { belowSession, belowKey, otherOrigin };
		}, smallLimits);

		expect(result).toStrictEqual({
			belowSession: { limit: 'origin', maximum: smallLimits.origin },
			belowKey: { limit: 'origin', maximum: smallLimits.origin },
			otherOrigin: 'created'
		});
	});

	it('counts the parentless keys of a subject and the keys below them as one origin', async () => {
		const result = await withStore(async (store) => {
			const root = await store.create(parentlessCreator('alice'), {
				grants: [readBuilds],
				expiresAt: withinToken
			});
			await store.create(keyCreator(root.id), {
				grants: [readBuilds],
				expiresAt: withinToken
			});
			await store.create(keyCreator(root.id), {
				grants: [readBuilds],
				expiresAt: withinToken
			});
			const parentless = await outcomeOf(
				store.create(parentlessCreator('alice'), {
					grants: [readBuilds],
					expiresAt: withinToken
				})
			);
			const otherSubject = await outcomeOf(
				store.create(parentlessCreator('bob'), {
					grants: [readBuilds],
					expiresAt: withinToken
				})
			);

			return { parentless, otherSubject };
		}, smallLimits);

		expect(result).toStrictEqual({
			parentless: { limit: 'origin', maximum: smallLimits.origin },
			otherSubject: 'created'
		});
	});

	it.each([
		{
			name: 'the origin limit, which counts only unexpired keys',
			creator: () => tokenCreator(),
			count: smallLimits.origin,
			limit: 'origin',
			afterExpiry: 'created',
			afterCollection: { limit: 'origin', maximum: smallLimits.origin }
		},
		{
			name: 'the tenant limit, which counts every key until collection deletes it',
			creator: (index: number) => parentlessCreator(`user-${String(index)}`),
			count: smallLimits.tenant,
			limit: 'tenant',
			afterExpiry: { limit: 'tenant', maximum: smallLimits.tenant },
			afterCollection: 'created'
		}
	])(
		'applies $name',
		async ({ creator, count, limit, afterExpiry, afterCollection }) => {
			const result = await withStore(async (store, context) => {
				for (let index = 0; index < count; index++) {
					await store.create(creator(index), {
						grants: [readBuilds],
						expiresAt: withinToken
					});
				}

				const beyond = await outcomeOf(
					store.create(creator(count), {
						grants: [readBuilds],
						expiresAt: withinToken
					})
				);
				const [first] = storedKeyIds(context);
				context.db
					.update(accessKeys)
					.set({ expiresAt: isoTimestamp(now) })
					.where(eq(accessKeys.id, accessKeyIdSchema.parse(first)))
					.run();
				const expired = await outcomeOf(
					store.create(creator(count), {
						grants: [readBuilds],
						expiresAt: withinToken
					})
				);
				store.deleteExpired(isoTimestamp(now), 100);
				const collected = await outcomeOf(
					store.create(creator(count + 1), {
						grants: [readBuilds],
						expiresAt: withinToken
					})
				);

				return { beyond, expired, collected };
			}, smallLimits);

			expect(result).toStrictEqual({
				beyond: { limit, maximum: count },
				expired: afterExpiry,
				collected: afterCollection
			});
		}
	);
});

describe('access-key listing and deletion', () => {
	beforeEach(resetTestServer);

	const admin = tokenCreator();

	it('lists the unexpired keys whose grants the caller can list', async () => {
		const result = await withStore(async (store, context) => {
			const builds = await store.create(admin, { grants: [readBuilds] });
			await store.create(admin, { grants: [readRelease] });
			await store.create(admin, { grants: [readBuilds, readRelease] });
			await store.create(admin, {
				grants: [readBuilds],
				expiresAt: withinToken
			});
			const later = new AccessKeyStore(
				context.db,
				() => new Date(Date.parse(withinToken) + 1)
			);

			return {
				listed: later.list([cacheGrant('builds', ['access-key:list'])]),
				expected: {
					accessKeys: [builds].map(({ secret: _, ...key }) => key),
					unreadableAccessKeys: []
				}
			};
		});

		expect(result.listed).toStrictEqual(result.expected);
	});

	it('lists the keys in pages ordered by ID', async () => {
		const result = await withStore(async (store) => {
			const created = [];

			for (let index = 0; index < 3; index++) {
				const { secret: _, ...key } = await store.create(admin, {
					grants: [readBuilds]
				});
				created.push(key);
			}

			const first = store.list(wildcard, { limit: 2 });

			return {
				pages: [
					first,
					store.list(wildcard, {
						limit: 2,
						...(first.cursor !== undefined && { cursor: first.cursor })
					})
				],
				created: created.toSorted((left, right) =>
					byCodeUnit(left.id, right.id)
				)
			};
		});
		const [first, second, third] = result.created;

		expect(result.pages).toStrictEqual([
			{
				accessKeys: [first, second],
				unreadableAccessKeys: [],
				cursor: second?.id
			},
			{ accessKeys: [third], unreadableAccessKeys: [] }
		]);
	});

	it.each([
		{
			name: 'one of two sibling keys is deleted',
			build: async (store: AccessKeyStore) => {
				const first = await store.create(tokenCreator(), {
					grants: [readBuilds]
				});
				const second = await store.create(tokenCreator(), {
					grants: [readBuilds]
				});

				return {
					remove: () => {
						store.delete(first.id);
					},
					remaining: second.id
				};
			}
		},
		{
			name: 'a child key is deleted',
			build: async (store: AccessKeyStore) => {
				const parent = await store.create(tokenCreator(), {
					grants: [readBuilds]
				});
				const child = await store.create(keyCreator(parent.id), {
					grants: [readBuilds]
				});

				return {
					remove: () => {
						store.delete(child.id);
					},
					remaining: parent.id
				};
			}
		},
		{
			name: 'a parent key is collected while its child remains',
			build: async (store: AccessKeyStore) => {
				const parent = await store.create(tokenCreator(), {
					grants: [readBuilds],
					expiresAt: withinToken
				});
				const child = await store.create(keyCreator(parent.id), {
					grants: [readBuilds]
				});
				const afterParent = isoTimestamp(new Date(Date.parse(withinToken) + 1));

				return {
					remove: () => {
						store.deleteExpired(afterParent, phaseStepSize);
					},
					remaining: child.id
				};
			}
		}
	])(
		'keeps a replayed session retained while a key remains below it after $name',
		async ({ build }) => {
			const result = await withStore(async (store, context) => {
				const { remove, remaining } = await build(store);
				markFamilyReplayed(context.db, session, isoTimestamp(now));
				remove();
				const afterRemoval = {
					keys: storedKeyIds(context),
					retained: retainedFamily(context)
				};
				store.delete(accessKeyIdSchema.parse(remaining));

				return {
					afterRemoval,
					afterLast: {
						keys: storedKeyIds(context),
						retained: retainedFamily(context)
					},
					remaining
				};
			});

			expect(result).toStrictEqual({
				afterRemoval: { keys: [result.remaining], retained: true },
				afterLast: { keys: [], retained: false },
				remaining: result.remaining
			});
		}
	);

	it('releases a replayed session when it deletes the keys below the session', async () => {
		const result = await withStore(async (store, context) => {
			await store.create(tokenCreator(), { grants: [readBuilds] });
			markFamilyReplayed(context.db, session, isoTimestamp(now));
			context.db.transaction((transaction) =>
				deleteAccessKeysBelow(transaction, { kind: 'session', id: session })
			);

			return { keys: storedKeyIds(context), retained: retainedFamily(context) };
		});

		expect(result).toStrictEqual({ keys: [], retained: false });
	});

	it('deletes a key and every key below it, and keeps the others', async () => {
		const result = await withStore(async (store, context) => {
			const top = await store.create(admin, { grants: [readBuilds] });
			const sibling = await store.create(admin, { grants: [readBuilds] });
			const deleted = await store.create(keyCreator(top.id), {
				grants: [readBuilds]
			});
			await store.create(keyCreator(deleted.id), { grants: [readBuilds] });
			const response = store.delete(deleted.id);

			return {
				response,
				expected: { id: deleted.id, deleted: true },
				remaining: storedKeyIds(context).toSorted(byCodeUnit),
				kept: [top.id, sibling.id].toSorted(byCodeUnit),
				ancestry: storedAncestry(context),
				expectedAncestry: [top.id, sibling.id]
					.toSorted(byCodeUnit)
					.map((id) => ({
						ancestorKind: 'session',
						ancestorId: session,
						descendantId: id
					}))
			};
		});

		expect({
			response: result.response,
			remaining: result.remaining,
			ancestry: result.ancestry
		}).toStrictEqual({
			response: result.expected,
			remaining: result.kept,
			ancestry: result.expectedAncestry
		});
	});
});

describe('access-key expiry', () => {
	beforeEach(resetTestServer);

	it('collects expired keys and still revokes the keys below them', async () => {
		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await migrateThrough(state, latestMigrationIndex);
				insertSession(instance.context);
				const store = instance.context.accessKeys;
				const creator = tokenCreator();
				const expiring = await store.create(creator, {
					grants: [readBuilds],
					expiresAt: isoTimestamp(new Date('2099-01-01T00:00:00.000Z'))
				});
				const below = await store.create(keyCreator(expiring.id), {
					grants: [readBuilds]
				});
				state.storage.sql.exec(
					'UPDATE access_key SET expires_at = ? WHERE id = ?',
					isoTimestamp(now),
					expiring.id
				);

				await underOneUnitOfWork(() => instance.runGarbageCollection());
				await state.storage.deleteAlarm();
				const afterCollection = {
					keys: storedKeyIds(instance.context),
					ancestry: storedAncestry(instance.context)
				};
				const revoked = instance.context.db.transaction((transaction) =>
					deleteAccessKeysBelow(transaction, { kind: 'session', id: session })
				);

				return {
					afterCollection,
					revoked,
					afterRevocation: storedKeyIds(instance.context),
					expected: {
						keys: [below.id],
						ancestry: [
							{
								ancestorKind: 'access-key',
								ancestorId: expiring.id,
								descendantId: below.id
							},
							{
								ancestorKind: 'session',
								ancestorId: session,
								descendantId: below.id
							}
						]
					}
				};
			}
		);

		expect({
			afterCollection: result.afterCollection,
			revoked: result.revoked,
			afterRevocation: result.afterRevocation
		}).toStrictEqual({
			afterCollection: result.expected,
			revoked: 1,
			afterRevocation: []
		});
	});

	it('keeps a key whose grants this release cannot read through collection, and lists it only to a wildcard holder', async () => {
		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await migrateThrough(state, latestMigrationIndex);
				insertSession(instance.context);
				const store = instance.context.accessKeys;
				const unreadable = await store.create(tokenCreator(), {
					grants: [readBuilds]
				});
				// An operation from a later release, which this release does
				// not know.
				state.storage.sql.exec(
					'UPDATE access_key SET grants_json = ? WHERE id = ?',
					JSON.stringify([
						{
							type: 'cupboard_cache',
							cache: { kind: 'named', name: 'builds' },
							actions: ['cache:future-operation']
						}
					]),
					unreadable.id
				);

				await underOneUnitOfWork(() => instance.runGarbageCollection());
				await state.storage.deleteAlarm();
				const cacheScoped = [
					cacheGrant('builds', ['access-key:list', 'access-key:delete'])
				];
				const afterCollection = {
					keys: storedKeyIds(instance.context),
					authority: store.grantsOf(unreadable.id),
					listedToWildcard: store.list(wildcard),
					listedToCache: store.list(cacheScoped)
				};

				return {
					afterCollection,
					id: unreadable.id,
					createdAt: unreadable.createdAt
				};
			}
		);
		const { id, createdAt } = result;

		expect(result).toStrictEqual({
			afterCollection: {
				keys: [id],
				authority: wildcard,
				listedToWildcard: {
					accessKeys: [],
					unreadableAccessKeys: [
						{
							id,
							parent: { kind: 'session', id: session },
							rule,
							subject: alice,
							createdAt
						}
					]
				},
				listedToCache: { accessKeys: [], unreadableAccessKeys: [] }
			},
			id,
			createdAt
		});
	});

	it('continues collection when a page of expired keys is full', async () => {
		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await migrateThrough(state, latestMigrationIndex);
				const store = instance.context.accessKeys;
				for (let index = 0; index <= phaseStepSize; index++) {
					await store.create(parentlessCreator(`user-${String(index)}`), {
						grants: [readBuilds]
					});
				}

				state.storage.sql.exec(
					'UPDATE access_key SET expires_at = ?',
					isoTimestamp(now)
				);
				await underOneUnitOfWork(() => instance.runGarbageCollection());
				const afterFirstPass = {
					keys: storedKeyIds(instance.context).length,
					continuation: await state.storage.get(gcContinuationKey)
				};
				await state.storage.deleteAlarm();
				await underOneUnitOfWork(() => instance.runGarbageCollection());
				await state.storage.deleteAlarm();

				return {
					afterFirstPass,
					afterSecondPass: storedKeyIds(instance.context).length
				};
			}
		);

		expect(result).toStrictEqual({
			afterFirstPass: { keys: 1, continuation: [{ scope: 'tenant' }] },
			afterSecondPass: 0
		});
	});
});
