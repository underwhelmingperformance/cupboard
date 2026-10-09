import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import { sessionIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	cacheWriteGrants,
	commitCreditAccept,
	currentServer,
	defaultCache,
	expectSingleCommitDecision,
	initialise,
	issueServerSignedToken,
	namedCache,
	negotiateUploads,
	openCommitSession,
	pushPath,
	putTestCache,
	resetTestServer,
	restartTestServers,
	uploadMetadata,
	verifiablePath
} from '../test-support.ts';

import {
	commitSocketIdleMs,
	readCommitSessionAttachment
} from './commit-credit-service.ts';
import {
	commitReuseGrantsPrefix,
	CommitReuseGrantsService
} from './commit-reuse-grants-service.ts';

const manyReadGrants = authorizationDetailsSchema.parse(
	Array.from({ length: 200 }, (_, index) => ({
		type: 'cupboard_cache',
		actions: ['cache:content-read'],
		cache: { kind: 'named', name: `source-cache-${String(index)}` }
	}))
);

describe('commit session reuse grants', () => {
	beforeEach(resetTestServer);

	it('opens a commit session with more read grants than an attachment can store', async () => {
		await initialise();
		const token = await issueServerSignedToken([
			...cacheWriteGrants(),
			...manyReadGrants
		]);
		const session = await openCommitSession(
			token,
			defaultCache(),
			commitCreditAccept
		);

		try {
			const authority = await runInDurableObject(
				currentServer(),
				async (_instance, state) => {
					const socket = state.getWebSockets()[0];
					const attachment =
						socket === undefined
							? undefined
							: readCommitSessionAttachment(socket);

					if (attachment === undefined) {
						throw new Error('Expected the opened session attachment');
					}

					return {
						inline: attachment.reuseGrants,
						persisted: attachment.reuseGrantsStored,
						grants: await new CommitReuseGrantsService(state.storage).read(
							attachment,
							Date.now()
						)
					};
				}
			);
			expect(authority).toStrictEqual({
				inline: undefined,
				persisted: true,
				grants: manyReadGrants
			});
		} finally {
			session.socket.close();
		}
	});

	it('reads the same authority after the Durable Object restarts', async () => {
		const sessionId = sessionIdSchema.parse('persisted-session');
		const expiresAt = Date.now() + 60_000;
		await runInDurableObject(currentServer(), (_instance, state) =>
			new CommitReuseGrantsService(state.storage).save(
				sessionId,
				expiresAt,
				manyReadGrants
			)
		);
		await restartTestServers();

		const restored = await runInDurableObject(
			currentServer(),
			(_instance, state) =>
				new CommitReuseGrantsService(state.storage).read(
					{ sessionId, authenticatedUntil: expiresAt, reuseGrantsStored: true },
					Date.now()
				)
		);
		expect(restored).toStrictEqual(manyReadGrants);
	});

	it.each(['missing', 'malformed', 'expired'] as const)(
		'uses no private read authority when the persisted grants are %s',
		async (condition) => {
			const grants = await runInDurableObject(
				currentServer(),
				async (_instance, state) => {
					const store = new CommitReuseGrantsService(state.storage);
					const session = {
						sessionId: sessionIdSchema.parse('invalid-authority'),
						authenticatedUntil: Date.now() + 60_000,
						reuseGrantsStored: true as const
					};

					if (condition !== 'missing') {
						await store.save(
							session.sessionId,
							session.authenticatedUntil,
							manyReadGrants
						);
					}

					if (condition === 'malformed') {
						const records = await state.storage.list({
							prefix: commitReuseGrantsPrefix
						});
						const key = records.keys().next().value;

						if (key === undefined) {
							throw new Error('Expected the stored session grants');
						}

						await state.storage.put(key, { invalid: true });
					}

					return store.read(
						session,
						condition === 'expired' ? session.authenticatedUntil : Date.now()
					);
				}
			);
			expect(grants).toStrictEqual([]);
		}
	);

	it('keeps inline authority for a session opened before durable grant storage', async () => {
		const legacy = await runInDurableObject(
			currentServer(),
			(_instance, state) =>
				new CommitReuseGrantsService(state.storage).read(
					{
						sessionId: sessionIdSchema.parse('legacy'),
						reuseGrants: manyReadGrants
					},
					Date.now()
				)
		);
		expect(legacy).toStrictEqual(manyReadGrants);
	});

	it.each(['close', 'error', 'idle', 'authentication-expiry'] as const)(
		'deletes session grants after %s',
		async (event) => {
			const token = await initialise();
			const session = await openCommitSession(
				token,
				defaultCache(),
				commitCreditAccept
			);

			try {
				const outcome = await runInDurableObject(
					currentServer(),
					async (instance, state) => {
						const socket = state.getWebSockets()[0];
						const attachment =
							socket === undefined
								? undefined
								: readCommitSessionAttachment(socket);

						if (
							socket === undefined ||
							attachment?.authenticatedUntil === undefined
						) {
							throw new Error('Expected the opened session attachment');
						}

						const before = await state.storage.list({
							prefix: commitReuseGrantsPrefix
						});

						switch (event) {
							case 'authentication-expiry': {
								vi.setSystemTime(attachment.authenticatedUntil);
								await instance.alarm();
								break;
							}
							case 'close': {
								await instance.webSocketClose(socket);
								break;
							}
							case 'error': {
								await instance.webSocketError(socket);
								break;
							}
							case 'idle': {
								socket.serializeAttachment({
									...attachment,
									lastActivityAt: Date.now() - commitSocketIdleMs - 1,
									credit: {
										...attachment.credit,
										unspentSince: Date.now() - commitSocketIdleMs - 1
									}
								});
								await instance.alarm();
								break;
							}
						}
						const after = await state.storage.list({
							prefix: commitReuseGrantsPrefix
						});

						return {
							before: before.size,
							after: after.size
						};
					}
				);
				expect(outcome).toStrictEqual({ before: 1, after: 0 });
			} finally {
				session.socket.close();
			}
		}
	);

	it('refuses private reuse when the session has lost its persisted read grants', async () => {
		const owner = await initialise();
		const source = namedCache('private-source');
		await putTestCache(owner, source, 'private');
		const { metadata, nar } = await verifiablePath(
			'missing-session-authority',
			{}
		);
		await pushPath(owner, metadata, source, nar);
		const sibling = uploadMetadata({
			...metadata,
			storePathHash: 'b'.repeat(32)
		});
		const token = await issueServerSignedToken(
			authorizationDetailsSchema.parse([
				...cacheWriteGrants(),
				{
					type: 'cupboard_cache',
					actions: ['cache:content-read'],
					cache: source
				}
			])
		);
		const decision = expectSingleCommitDecision(
			await negotiateUploads(token, [sibling]),
			sibling
		);
		const session = await openCommitSession(token);

		try {
			await runInDurableObject(currentServer(), async (_instance, state) => {
				const records = await state.storage.list({
					prefix: commitReuseGrantsPrefix
				});
				await state.storage.delete(records.keys().toArray());
			});
			session.send({ op: 'commit', uploadId: decision.uploadId });

			expect(await session.nextFrame()).toStrictEqual({
				ev: 'error',
				uploadId: decision.uploadId,
				status: StatusCodes.NOT_FOUND,
				message: 'Uploaded object not found'
			});
		} finally {
			session.socket.close();
		}
	});

	it('cleans expired records in bounded pages and preserves live authority', async () => {
		const outcome = await runInDurableObject(
			currentServer(),
			async (_instance, state) => {
				const store = new CommitReuseGrantsService(state.storage);
				const now = Date.UTC(2040, 0, 1);
				const live = {
					sessionId: sessionIdSchema.parse('live'),
					authenticatedUntil: now + 60_000,
					reuseGrantsStored: true as const
				};

				await store.save(
					live.sessionId,
					live.authenticatedUntil,
					manyReadGrants
				);
				for (let index = 0; index < 130; index += 1) {
					await store.save(
						sessionIdSchema.parse(`expired-${String(index)}`),
						now - 1,
						[]
					);
				}

				await state.storage.deleteAlarm();
				await store.cleanupExpired(now);
				const first = await state.storage.list({
					prefix: commitReuseGrantsPrefix
				});
				const continuation = await state.storage.getAlarm();
				await state.storage.deleteAlarm();
				await store.cleanupExpired(now);
				const second = await state.storage.list({
					prefix: commitReuseGrantsPrefix
				});

				return {
					first: first.size,
					continuesImmediately: continuation === now,
					second: second.size,
					nextExpiry: await state.storage.getAlarm(),
					expectedExpiry: live.authenticatedUntil,
					live: await store.read(live, now)
				};
			}
		);
		expect(outcome).toStrictEqual({
			first: 3,
			continuesImmediately: true,
			second: 1,
			nextExpiry: outcome.expectedExpiry,
			expectedExpiry: outcome.expectedExpiry,
			live: manyReadGrants
		});
	});
});
