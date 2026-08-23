import {
	DEFAULT_CACHE,
	storePathHashSchema,
	WIRE_DEFAULT_CACHE
} from '@cupboard/nix-store/scalars';
import {
	commitAcceptCapabilitiesHeader,
	commitAuthenticationExpiredCloseCode,
	commitAuthenticationExpiredCloseReason,
	commitBatchMaxEntries,
	commitCapabilitiesValue,
	commitCapabilitiesValueWithCredit,
	type CommitSessionRequest,
	type ParsedCommitBatchEntry,
	type SessionId,
	type UploadId,
	uploadIdSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { CommitCreditBudgetInvalidError } from '../errors.ts';
import { defaultCommitEntryCreditBudget } from '../policy/commit-credit.ts';
import { maxUncreditedCommitSessions } from '../policy/commit-sockets.ts';
import {
	type CommitConversation,
	commitCreditAccept,
	commitUpload,
	currentServer,
	deferFreshUpload,
	expectSingleUploadDecision,
	fetchPath,
	flakyR2,
	initialise,
	negotiateUploads,
	nixSha256Hash,
	openCommitSession,
	putNarBytes,
	resetTestServer,
	verifiablePath
} from '../test-support.ts';

import { maxOutgoingConnections } from './bulk.ts';
import {
	CommitCreditService,
	type CommitSessionAttachment,
	commitSessionAttachmentSchema,
	commitSocketIdleMs,
	readCommitSessionAttachment,
	unpacedSessions
} from './commit-credit-service.ts';

function openCredited(token: string): Promise<CommitConversation> {
	return openCommitSession(token, DEFAULT_CACHE, commitCreditAccept);
}

function unknownUpload(seed: string): UploadId {
	return uploadIdSchema.parse(`missing-${seed}`);
}

async function settledEntry(
	token: string,
	hashCharacter: string
): Promise<ParsedCommitBatchEntry> {
	const name = `settled-${hashCharacter}`;
	// Use a unique NAR hash so negotiation creates an upload instead of returning
	// `reuse` for an existing blob.
	const { metadata, nar } = await verifiablePath(name, {
		name,
		storePathHash: hashCharacter.repeat(32)
	});
	const decision = expectSingleUploadDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);
	await putNarBytes(decision.r2Key, nar);
	await commitUpload(token, decision.uploadId);

	return {
		uploadId: decision.uploadId,
		storePathHash: metadata.storePathHash,
		narHash: metadata.narHash
	};
}

async function reCommitOfSettledPath(
	token: string
): Promise<CommitSessionRequest> {
	return { op: 'commit-batch', commits: [await settledEntry(token, '1')] };
}

// A recommit without a pending row probes R2 while resolving narinfo. Failing
// every probe rejects an entry and stops the batch runner from starting later
// entries.
function faultPresenceProbes(): Promise<void> {
	return runInDurableObject(currentServer(), (instance) => {
		instance.context.env = {
			...instance.context.env,
			BLOBS: flakyR2(instance.context.env.BLOBS, {
				failures: Number.MAX_SAFE_INTEGER
			})
		};
	});
}

function unrunEntry(hashCharacter: string): ParsedCommitBatchEntry {
	return {
		uploadId: unknownUpload(hashCharacter),
		storePathHash: storePathHashSchema.parse(hashCharacter.repeat(32)),
		narHash: nixSha256Hash(hashCharacter)
	};
}

function misconfigureBudget(): Promise<void> {
	return runInDurableObject(currentServer(), (instance) => {
		instance.context.env = {
			...instance.context.env,
			CUPBOARD_COMMIT_ENTRY_CREDIT_BUDGET: 'half a dozen'
		};
	});
}

// Leave the socket handshake incomplete to reproduce a peer that never answers
// the server's close.
function reclaimHeldSession(): Promise<void> {
	return runInDurableObject(currentServer(), (instance, state) => {
		const socket = state.getWebSockets().find((candidate) => {
			const held = readCommitSessionAttachment(candidate);

			return held !== undefined && isHoldingCredit(held);
		});
		const attachment =
			socket === undefined ? undefined : readCommitSessionAttachment(socket);

		if (attachment === undefined) {
			throw new Error('expected a session holding credit');
		}

		const reclaiming = new CommitCreditService(instance.context);

		reclaiming.closeSession(attachment.sessionId, Date.now());
	});
}

function sessionMatching(
	isChosen: (attachment: CommitSessionAttachment) => boolean
): Promise<SessionId> {
	return runInDurableObject(currentServer(), (_instance, state) => {
		const attachment = state
			.getWebSockets()
			.map((socket) => readCommitSessionAttachment(socket))
			.find((candidate) => candidate !== undefined && isChosen(candidate));

		if (attachment === undefined) {
			throw new Error('expected a matching commit session');
		}

		return attachment.sessionId;
	});
}

// Exclude the wall-clock timestamp so credit-state assertions are deterministic.
type CreditFacts = Pick<
	NonNullable<CommitSessionAttachment['credit']>,
	'demand' | 'granted' | 'hasRequested' | 'isClosing'
>;

function recordedCredit(sessionId: SessionId): Promise<CreditFacts> {
	return runInDurableObject(currentServer(), (_instance, state) => {
		const socket = state.getWebSockets(sessionId)[0];
		const credit =
			socket === undefined
				? undefined
				: readCommitSessionAttachment(socket)?.credit;

		if (credit === undefined) {
			throw new Error('expected recorded credit for the commit session');
		}

		const { demand, granted, hasRequested, isClosing } = credit;

		return { demand, granted, hasRequested, isClosing };
	});
}

async function firstFrameOrClose(session: CommitConversation): Promise<string> {
	try {
		const frame = await session.nextFrame();

		return frame.ev;
	} catch {
		return 'closed';
	}
}

// Deleting, running, and reading the alarm must share one Durable Object call.
// This test pool does not expose an alarm created by another call's storage view.
function doesAlarmRearm(): Promise<boolean> {
	return runInDurableObject(currentServer(), async (instance, state) => {
		await state.storage.deleteAlarm();
		await instance.alarm();

		return typeof (await state.storage.getAlarm()) === 'number';
	});
}

function closeCode(session: CommitConversation): Promise<number> {
	return new Promise((resolve) => {
		session.socket.addEventListener('close', (event) => {
			resolve(event.code);
		});
	});
}

function closeDetails(
	session: CommitConversation
): Promise<{ readonly code: number; readonly reason: string }> {
	return new Promise((resolve) => {
		session.socket.addEventListener('close', (event) => {
			resolve({ code: event.code, reason: event.reason });
		});
	});
}

function expireAuthentication(socket: WebSocket): void {
	const attachment = readCommitSessionAttachment(socket);

	if (attachment === undefined) {
		throw new Error('expected an open commit session');
	}

	socket.serializeAttachment({
		...attachment,
		authenticatedUntil: Date.now() - 1
	});
}

function rewindActivity(socket: WebSocket, by: number): void {
	const attachment = readCommitSessionAttachment(socket);

	if (attachment?.lastActivityAt === undefined) {
		throw new Error('expected a commit session recording its activity');
	}

	const { credit } = attachment;

	socket.serializeAttachment(
		commitSessionAttachmentSchema.parse({
			...attachment,
			lastActivityAt: attachment.lastActivityAt - by,
			...(credit?.unspentSince !== undefined && {
				credit: { ...credit, unspentSince: credit.unspentSince - by }
			})
		})
	);
}

function rewindHolding(socket: WebSocket, by: number): void {
	const attachment = readCommitSessionAttachment(socket);
	const credit = attachment?.credit;

	if (attachment === undefined || credit?.unspentSince === undefined) {
		throw new Error('expected a commit session holding credit');
	}

	socket.serializeAttachment(
		commitSessionAttachmentSchema.parse({
			...attachment,
			credit: { ...credit, unspentSince: credit.unspentSince - by }
		})
	);
}

function rewindPastIdle(
	isChosen: (attachment: CommitSessionAttachment) => boolean,
	rewind: (socket: WebSocket, by: number) => void = rewindActivity
): Promise<void> {
	return runInDurableObject(currentServer(), (_instance, state) => {
		for (const socket of state.getWebSockets()) {
			const attachment = readCommitSessionAttachment(socket);

			if (attachment !== undefined && isChosen(attachment)) {
				rewind(socket, commitSocketIdleMs + 1);
			}
		}
	});
}

// Keep the timestamp change and alarm in one Durable Object turn so an
// independently armed alarm cannot close the session between them.
function runIdleClose(
	isChosen: (attachment: CommitSessionAttachment) => boolean = () => false,
	rewind: (socket: WebSocket, by: number) => void = rewindActivity
): Promise<void> {
	return runInDurableObject(currentServer(), async (instance, state) => {
		for (const socket of state.getWebSockets()) {
			const attachment = readCommitSessionAttachment(socket);

			if (attachment !== undefined && isChosen(attachment)) {
				rewind(socket, commitSocketIdleMs + 1);
			}
		}

		await instance.alarm();
	});
}

function isHoldingCredit(attachment: CommitSessionAttachment): boolean {
	return (attachment.credit?.granted ?? 0) > 0;
}

function isQueuedForCredit(attachment: CommitSessionAttachment): boolean {
	const { credit } = attachment;

	return credit !== undefined && credit.demand > 0 && credit.granted === 0;
}

const openingGrant = Math.floor(defaultCommitEntryCreditBudget / 2);
const remainingPool = defaultCommitEntryCreditBudget - openingGrant;

async function openHoldingPool(
	token: string,
	entries: number = defaultCommitEntryCreditBudget
): Promise<CommitConversation> {
	const holder = await openCredited(token);
	holder.send({ op: 'request-credit', entries });

	const quanta = [];

	for (
		let remaining = entries;
		remaining > 0;
		remaining -= commitBatchMaxEntries
	) {
		quanta.push({
			ev: 'credit',
			grant: Math.min(remaining, commitBatchMaxEntries)
		});
	}

	expect(await Promise.all(quanta.map(() => holder.nextFrame()))).toStrictEqual(
		quanta
	);

	return holder;
}

describe('commit session credit', () => {
	beforeEach(resetTestServer);

	it.each([
		{
			client: 'a client that understands credit',
			accepted: commitCreditAccept,
			capabilities: commitCapabilitiesValueWithCredit(openingGrant)
		},
		{
			client: 'a client that does not',
			accepted: undefined,
			capabilities: commitCapabilitiesValue
		}
	])(
		'advertises the opening grant to $client',
		async ({ accepted, capabilities }) => {
			const token = await initialise();
			const session = await openCommitSession(token, DEFAULT_CACHE, accepted);

			expect(session.capabilities).toBe(capabilities);

			session.socket.close();
		}
	);

	// Budget validation must precede `acceptWebSocket`. A rejected upgrade cannot
	// remove an accepted socket from `getWebSockets()`, so accepting first would
	// consume one slot from the tenant's socket ceiling on every retry.
	it('does not accept a socket when the tenant credit budget is misconfigured', async () => {
		const token = await initialise();

		await misconfigureBudget();

		const response = await fetchPath(`/cache/${WIRE_DEFAULT_CACHE}/commit`, {
			headers: {
				authorization: `Bearer ${token}`,
				upgrade: 'websocket',
				[commitAcceptCapabilitiesHeader]: commitCreditAccept
			}
		});
		const sockets = await runInDurableObject(
			currentServer(),
			(_instance, state) => state.getWebSockets().length
		);

		expect({ status: response.status, sockets }).toStrictEqual({
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			sockets: 0
		});
	});

	it('checks authentication expiry before it handles a commit message', async () => {
		const token = await initialise();
		const session = await openCommitSession(token);
		const closed = closeDetails(session);

		await runInDurableObject(currentServer(), async (instance, state) => {
			const socket = state.getWebSockets()[0];

			if (socket === undefined) {
				throw new Error('expected an open commit session');
			}

			expireAuthentication(socket);
			await instance.webSocketMessage(
				socket,
				JSON.stringify({ op: 'commit', uploadId: unknownUpload('x') })
			);
		});

		await expect(closed).resolves.toStrictEqual({
			code: commitAuthenticationExpiredCloseCode,
			reason: commitAuthenticationExpiredCloseReason
		});
	});

	// An alarm with no credit waiters must not read the credit budget. Otherwise a
	// bad budget would also block unrelated maintenance loops. Reaching the end of
	// the awaited alarm proves that those later loops were allowed to run.
	it('runs the alarm for a socketless tenant when the budget is misconfigured', async () => {
		await initialise();
		await misconfigureBudget();

		const outcome = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await instance.alarm();

				return { sockets: state.getWebSockets().length, alarm: 'ran' };
			}
		);

		expect(outcome).toStrictEqual({ sockets: 0, alarm: 'ran' });
	});

	// Closing an unpaced session releases no credit and must not read the budget.
	// A validation error here would interrupt the close handshake while the socket
	// still counts against the tenant's ceiling.
	it('closes an uncredited session when the budget is misconfigured', async () => {
		const token = await initialise();
		const unpaced = await openCommitSession(token);

		await misconfigureBudget();

		const outcome = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const socket = state.getWebSockets()[0];

				if (socket === undefined) {
					throw new Error('expected the uncredited session to be listed');
				}

				instance.webSocketClose(socket);

				return 'reclaimed';
			}
		);

		expect({ outcome, grant: unpaced.capabilities }).toStrictEqual({
			outcome: 'reclaimed',
			grant: commitCapabilitiesValue
		});
	});

	// A rebuilt rotation needs the budget before it can grant credit. This path
	// must reject an invalid value. A new service instance models a Durable Object
	// wake after deployment configuration changed.
	it('rejects an invalid budget when an idle-close pass allocates recorded demand', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const waiter = await openCredited(token);

		waiter.send({ op: 'request-credit', entries: remainingPool });
		expect(await waiter.nextFrame()).toStrictEqual({ ev: 'queued', ahead: 0 });

		await misconfigureBudget();

		await expect(
			runInDurableObject(currentServer(), (instance) => {
				const woken = new CommitCreditService(instance.context);

				woken.closeIdleSessions(Date.now(), () => new Set<SessionId>());
			})
		).rejects.toThrow(CommitCreditBudgetInvalidError);

		holder.socket.close();
		waiter.socket.close();
	});

	// Every live session contributes an authentication-expiry deadline. Only paced
	// sessions also contribute an idle-credit deadline.
	it('re-arms the socket close while any authenticated session is open', async () => {
		const token = await initialise();
		const unpaced = await openCommitSession(token);

		const isArmedForUnpaced = await doesAlarmRearm();

		const credited = await openCredited(token);
		const isArmedForCredited = await doesAlarmRearm();

		expect({ isArmedForUnpaced, isArmedForCredited }).toStrictEqual({
			isArmedForUnpaced: true,
			isArmedForCredited: true
		});

		unpaced.socket.close();
		credited.socket.close();
	});

	// Reclamation keeps a marked, zeroed attachment until the peer completes the
	// close handshake. The marker must also exclude the socket from future alarm
	// scheduling if the peer never responds.
	it('leaves the alarm unarmed after reclaiming a session', async () => {
		const token = await initialise();
		const closing = await openCredited(token);

		await reclaimHeldSession();

		expect({
			grant: closing.capabilities,
			isArmed: await doesAlarmRearm()
		}).toStrictEqual({
			grant: commitCapabilitiesValueWithCredit(openingGrant),
			isArmed: false
		});

		closing.socket.close();
	});

	// A marked socket can remain in `getWebSockets()` after reclamation. Later
	// passes must skip it before consulting verdict state; otherwise every alarm
	// repeats work for a session that is already closed.
	it('excludes a reclaimed session from later idle passes', async () => {
		const token = await initialise();
		const ghost = await openCredited(token);

		await reclaimHeldSession();

		const outcome = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const socket = state.getWebSockets()[0];

				if (socket === undefined) {
					throw new Error('expected the closed session to be listed');
				}

				rewindActivity(socket, commitSocketIdleMs + 1);

				let parkedReads = 0;
				const passing = new CommitCreditService(instance.context);

				passing.closeIdleSessions(Date.now(), () => {
					parkedReads += 1;

					return new Set<SessionId>();
				});

				return { parkedReads, sockets: state.getWebSockets().length };
			}
		);

		expect({ grant: ghost.capabilities, ...outcome }).toStrictEqual({
			grant: commitCapabilitiesValueWithCredit(openingGrant),
			parkedReads: 0,
			sockets: 1
		});

		ghost.socket.close();
	});

	// The closing marker identifies messages sent before the peer observed the
	// close. The server must repeat its retryable idle close without running the
	// message; the client had previously received a valid grant and committed no
	// protocol error.
	it('repeats the close when a client message arrives after reclamation', async () => {
		const token = await initialise();
		const crossing = await openCredited(token);

		crossing.send({ op: 'request-credit', entries: 1 });
		const granted = await crossing.nextFrame();

		const closed = closeCode(crossing);
		await reclaimHeldSession();

		crossing.send({ op: 'commit', uploadId: unknownUpload('w') });

		expect({ granted, code: await closed }).toStrictEqual({
			granted: { ev: 'credit', grant: 1 },
			code: 1001
		});
	});

	// Processing demand after reclamation would allocate credit to a session that
	// the idle pass will never revisit. If the peer also ignores the close, no
	// close callback can return that allocation to the tenant.
	it('rejects a credit request after reclaiming the session', async () => {
		const token = await initialise();
		const ghost = await openCredited(token);

		await reclaimHeldSession();

		const holder = await openHoldingPool(token, commitBatchMaxEntries);
		const waiter = await openCredited(token);

		waiter.send({
			op: 'request-credit',
			entries: defaultCommitEntryCreditBudget
		});
		const queued = await waiter.nextFrame();
		const waiterId = await sessionMatching(isQueuedForCredit);

		ghost.send({
			op: 'request-credit',
			entries: defaultCommitEntryCreditBudget
		});
		const answered = await firstFrameOrClose(ghost);

		holder.socket.close();
		const granted = await waiter.nextFrame();

		expect({
			queued,
			answered,
			granted,
			served: await recordedCredit(waiterId)
		}).toStrictEqual({
			queued: { ev: 'queued', ahead: 0 },
			answered: 'closed',
			granted: { ev: 'credit', grant: commitBatchMaxEntries },
			served: {
				granted: defaultCommitEntryCreditBudget,
				demand: 0,
				hasRequested: true,
				isClosing: undefined
			}
		});

		waiter.socket.close();
	});

	// A client can spend its opening grant without ever requesting more credit.
	// After idle reclamation, a crossing batch must not enter the lost-grant
	// downgrade path. Doing so would run entries whose result frames cannot be
	// delivered and leave the closed socket counted as an unpaced session.
	it('runs no commit when an opening-grant batch crosses an idle close', async () => {
		const token = await initialise();
		const ghost = await openCredited(token);

		await reclaimHeldSession();

		ghost.send({
			op: 'commit-batch',
			commits: [unrunEntry('m'), unrunEntry('n')]
		});
		const answered = await firstFrameOrClose(ghost);
		const unpaced = await runInDurableObject(
			currentServer(),
			(_instance, state) => unpacedSessions(state.getWebSockets())
		);

		expect({ answered, unpaced }).toStrictEqual({
			answered: 'closed',
			unpaced: 0
		});
	});

	it('opens each session on half of the free pool', async () => {
		const token = await initialise();
		const first = await openCredited(token);
		const second = await openCredited(token);

		expect({
			first: first.capabilities,
			second: second.capabilities
		}).toStrictEqual({
			first: commitCapabilitiesValueWithCredit(openingGrant),
			second: commitCapabilitiesValueWithCredit(Math.floor(remainingPool / 2))
		});

		first.socket.close();
		second.socket.close();
	});

	it('queues demand beyond the tenant budget', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const waiter = await openCredited(token);

		waiter.send({ op: 'request-credit', entries: 50 });

		expect({
			waiter: waiter.capabilities,
			answer: await waiter.nextFrame()
		}).toStrictEqual({
			waiter: commitCapabilitiesValueWithCredit(0),
			answer: { ev: 'queued', ahead: 0 }
		});

		holder.socket.close();
		waiter.socket.close();
	});

	it.each([
		{
			result: 'settled',
			commit: (token: string): Promise<CommitSessionRequest> =>
				reCommitOfSettledPath(token)
		},
		{
			result: 'deferred',
			commit: async (token: string): Promise<CommitSessionRequest> => {
				const deferred = await deferFreshUpload(
					token,
					'deferred',
					'b'.repeat(32)
				);

				return { op: 'commit', uploadId: deferred.uploadId };
			}
		},
		{
			result: 'error',
			commit: (_token: string): Promise<CommitSessionRequest> =>
				Promise.resolve({ op: 'commit', uploadId: unknownUpload('c') })
		}
	])(
		'releases one unit when the first result is $result',
		async ({ result, commit }) => {
			const token = await initialise();
			const request = await commit(token);
			const holder = await openHoldingPool(token);
			const waiter = await openCredited(token);

			waiter.send({ op: 'request-credit', entries: 50 });
			const queued = await waiter.nextFrame();

			holder.send(request);
			const first = await holder.nextFrame();
			const granted = await waiter.nextFrame();

			expect({ queued, result: first.ev, granted }).toStrictEqual({
				queued: { ev: 'queued', ahead: 0 },
				result,
				granted: { ev: 'credit', grant: 1 }
			});

			holder.socket.close();
			waiter.socket.close();
		}
	);

	// Admission debits the full batch before bounded fan-out begins. A rejection
	// can prevent later entries from starting, so the batch boundary must answer
	// those entries and release their units. Otherwise each storage fault shrinks
	// the circulating budget and leaves the client waiting for abandoned work.
	it('sends errors for unstarted entries after a batch failure and returns their credit', async () => {
		const token = await initialise();
		const commits: ParsedCommitBatchEntry[] = [];

		// Exceed the concurrency limit so a rejection leaves entries unstarted.
		// Nix base32 omits `e`.
		for (const character of ['a', 'b', 'c', 'd', 'f', 'g', 'h', 'i']) {
			commits.push(await settledEntry(token, character));
		}

		const holder = await openHoldingPool(token);
		const waiter = await openCredited(token);

		waiter.send({ op: 'request-credit', entries: remainingPool });
		const queued = await waiter.nextFrame();

		await faultPresenceProbes();
		holder.send({ op: 'commit-batch', commits });

		const answers = await Promise.all(commits.map(() => holder.nextFrame()));

		// Started entries release individually. The batch cleanup releases all
		// unstarted entries together.
		const startedEntries = maxOutgoingConnections;
		const grants = await Promise.all(
			Array.from({ length: startedEntries + 1 }, () => waiter.nextFrame())
		);

		expect({
			queued,
			answers: answers.map((frame) =>
				frame.ev === 'error'
					? { ev: frame.ev, uploadId: frame.uploadId, status: frame.status }
					: { ev: frame.ev }
			),
			grants
		}).toStrictEqual({
			queued: { ev: 'queued', ahead: 0 },
			answers: commits.map((entry) => ({
				ev: 'error',
				uploadId: entry.uploadId,
				status: StatusCodes.SERVICE_UNAVAILABLE
			})),
			grants: [
				...Array.from({ length: startedEntries }, () => ({
					ev: 'credit',
					grant: 1
				})),
				{ ev: 'credit', grant: commits.length - startedEntries }
			]
		});

		holder.socket.close();
		waiter.socket.close();
	});

	it('grants credit to waiting sessions in round-robin order', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const first = await openCredited(token);
		const second = await openCredited(token);

		first.send({ op: 'request-credit', entries: 50 });
		second.send({ op: 'request-credit', entries: 50 });
		await first.nextFrame();
		await second.nextFrame();

		holder.send({ op: 'commit', uploadId: unknownUpload('one') });
		await holder.nextFrame();
		holder.send({ op: 'commit', uploadId: unknownUpload('two') });
		await holder.nextFrame();

		expect(
			await Promise.all([first.nextFrame(), second.nextFrame()])
		).toStrictEqual([
			{ ev: 'credit', grant: 1 },
			{ ev: 'credit', grant: 1 }
		]);

		holder.socket.close();
		first.socket.close();
		second.socket.close();
	});

	// A grant sent over the established connection confirms the client's balance.
	// Exceeding that balance is a fatal protocol error, reported with 1002.
	it('closes a session for committing beyond its confirmed balance', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const overdrawing = await openCredited(token);
		const closed = closeCode(overdrawing);

		overdrawing.send({ op: 'request-credit', entries: 1 });
		const queued = await overdrawing.nextFrame();

		overdrawing.send({ op: 'commit', uploadId: unknownUpload('d') });

		expect({
			grant: overdrawing.capabilities,
			queued,
			code: await closed
		}).toStrictEqual({
			grant: commitCapabilitiesValueWithCredit(0),
			queued: { ev: 'queued', ahead: 0 },
			code: 1002
		});

		holder.socket.close();
	});

	// Reclaim before starting the close handshake because the socket can remain
	// listed until the peer replies. The waiter's immediate grant proves that the
	// overdrawn session retained no balance.
	it('redistributes a session balance before closing it for overdrawing', async () => {
		const token = await initialise();
		const spare = 2;
		const holder = await openHoldingPool(
			token,
			defaultCommitEntryCreditBudget - spare
		);
		const overdrawing = await openCredited(token);

		overdrawing.send({ op: 'request-credit', entries: 1 });
		const granted = await overdrawing.nextFrame();

		const waiter = await openCredited(token);
		waiter.send({ op: 'request-credit', entries: remainingPool });
		const opening = await waiter.nextFrame();

		const closed = closeCode(overdrawing);
		overdrawing.send({
			op: 'commit-batch',
			commits: [unrunEntry('b'), unrunEntry('c')]
		});

		expect({
			granted,
			opening,
			code: await closed,
			reclaimed: await waiter.nextFrame()
		}).toStrictEqual({
			granted: { ev: 'credit', grant: 1 },
			opening: { ev: 'credit', grant: 1 },
			code: 1002,
			reclaimed: { ev: 'credit', grant: 1 }
		});

		holder.socket.close();
		waiter.socket.close();
	});

	// An intermediary can strip the opening grant from the 101 response. Before
	// any `request-credit` exchange confirms the protocol, an overdraw therefore
	// downgrades the connection and lets the client continue unpaced.
	it('downgrades an overdraw before the first explicit credit exchange', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const downgraded = await openCredited(token);

		downgraded.send({ op: 'commit', uploadId: unknownUpload('g') });
		const first = await downgraded.nextFrame();

		downgraded.send({ op: 'commit', uploadId: unknownUpload('h') });
		const second = await downgraded.nextFrame();

		expect({
			grant: downgraded.capabilities,
			answers: [first.ev, second.ev],
			state: downgraded.socket.readyState
		}).toStrictEqual({
			grant: commitCapabilitiesValueWithCredit(0),
			answers: ['error', 'error'],
			state: WebSocket.READY_STATE_OPEN
		});

		holder.socket.close();
		downgraded.socket.close();
	});

	// A downgraded connection has no per-entry bound, so the legacy session limit
	// also guards this transition. At the limit, a retryable 1013 close lets a
	// client reconnect and negotiate another opening grant.
	it('refuses a downgrade at the unpaced-session limit', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const unpaced: CommitConversation[] = [];

		for (let index = 0; index < maxUncreditedCommitSessions; index += 1) {
			unpaced.push(await openCommitSession(token));
		}

		const refused = await openCredited(token);
		const closed = closeCode(refused);

		refused.send({ op: 'commit', uploadId: unknownUpload('l') });

		expect({
			grant: refused.capabilities,
			code: await closed
		}).toStrictEqual({
			grant: commitCapabilitiesValueWithCredit(0),
			code: 1013
		});

		holder.socket.close();

		for (const session of unpaced) {
			session.socket.close();
		}
	});

	// The opening grant exists only in the 101 response. At the first explicit
	// request, any remaining opening balance may be unknown to the client, so the
	// server returns it to the pool and sends the replacement grant over the open
	// WebSocket.
	it('replaces an unused opening grant on the first credit request', async () => {
		const token = await initialise();
		const stranded = await openCredited(token);
		const demand = 10;

		stranded.send({ op: 'request-credit', entries: demand });
		const granted = await stranded.nextFrame();
		const reopened = await openCredited(token);

		expect({
			opening: stranded.capabilities,
			granted,
			reopened: reopened.capabilities
		}).toStrictEqual({
			opening: commitCapabilitiesValueWithCredit(openingGrant),
			granted: { ev: 'credit', grant: demand },
			reopened: commitCapabilitiesValueWithCredit(
				Math.floor((defaultCommitEntryCreditBudget - demand) / 2)
			)
		});

		stranded.socket.close();
		reopened.socket.close();
	});

	// A first request replaces only unused opening credit. Credit already moved to
	// an entry remains charged until that entry's first result frame.
	it('preserves credit already spent from the opening grant', async () => {
		const token = await initialise();
		const spare = 2;
		const holder = await openHoldingPool(
			token,
			defaultCommitEntryCreditBudget - spare
		);
		const spender = await openCredited(token);

		spender.send({ op: 'commit', uploadId: unknownUpload('j') });
		const answer = await spender.nextFrame();

		spender.send({ op: 'request-credit', entries: spare + 1 });
		const granted = await spender.nextFrame();

		expect({
			opening: spender.capabilities,
			answer: answer.ev,
			granted
		}).toStrictEqual({
			opening: commitCapabilitiesValueWithCredit(Math.floor(spare / 2)),
			answer: 'error',
			granted: { ev: 'credit', grant: spare }
		});

		holder.socket.close();
		spender.socket.close();
	});

	it("returns a session's unused balance when it closes", async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const waiter = await openCredited(token);

		waiter.send({ op: 'request-credit', entries: 50 });
		const queued = await waiter.nextFrame();

		holder.socket.close();

		expect({ queued, granted: await waiter.nextFrame() }).toStrictEqual({
			queued: { ev: 'queued', ahead: 0 },
			granted: { ev: 'credit', grant: 50 }
		});

		waiter.socket.close();
	});

	// Hibernation discards both the cached balance and the rotation. A fresh
	// service must rebuild both from socket attachments. The one-unit grant proves
	// that it found the holder's balance and the waiter's demand.
	it('rebuilds the granted total and the rotation from the socket attachments', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const waiter = await openCredited(token);

		waiter.send({ op: 'request-credit', entries: 50 });
		expect(await waiter.nextFrame()).toStrictEqual({ ev: 'queued', ahead: 0 });

		await runInDurableObject(currentServer(), (instance, state) => {
			const socket = state
				.getWebSockets()
				.find(
					(candidate) =>
						(readCommitSessionAttachment(candidate)?.credit?.granted ?? 0) > 0
				);
			const attachment =
				socket === undefined ? undefined : readCommitSessionAttachment(socket);

			if (socket === undefined || attachment === undefined) {
				throw new Error('expected a session holding credit');
			}

			const rebuilt = new CommitCreditService(instance.context);
			rebuilt.admitMessage(socket, attachment, 1, Date.now());
			rebuilt.release(attachment.sessionId, Date.now());
		});

		expect(await waiter.nextFrame()).toStrictEqual({ ev: 'credit', grant: 1 });

		holder.socket.close();
		waiter.socket.close();
	});

	it('closes a silent session on the alarm and redistributes its credit', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const waiter = await openCredited(token);

		waiter.send({ op: 'request-credit', entries: 50 });
		expect(await waiter.nextFrame()).toStrictEqual({ ev: 'queued', ahead: 0 });

		const closed = closeCode(holder);
		await runIdleClose(isHoldingCredit);

		expect({
			code: await closed,
			granted: await waiter.nextFrame()
		}).toStrictEqual({
			code: 1001,
			granted: { ev: 'credit', grant: 50 }
		});

		waiter.socket.close();
	});

	// Credit requests do not spend the balance. Client activity must therefore not
	// reset the idle clock for a positive balance, or repeated requests could hold
	// the tenant's budget indefinitely.
	it('reclaims a positive balance despite repeated credit requests', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const waiter = await openCredited(token);

		waiter.send({ op: 'request-credit', entries: remainingPool });
		const queued = await waiter.nextFrame();

		holder.send({ op: 'request-credit', entries: 1 });
		const heartbeat = await holder.nextFrame();

		const closed = closeCode(holder);
		await runIdleClose(isHoldingCredit, rewindHolding);

		expect({
			queued,
			heartbeat,
			code: await closed,
			granted: await waiter.nextFrame()
		}).toStrictEqual({
			queued: { ev: 'queued', ahead: 0 },
			heartbeat: { ev: 'queued', ahead: 1 },
			code: 1001,
			granted: { ev: 'credit', grant: remainingPool }
		});

		waiter.socket.close();
	});

	// Partial spending does not reset the positive-balance interval. Otherwise a
	// session could retain the pool indefinitely by moving one entry at a time.
	it('reclaims the remaining pool despite one-entry progress', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const waiter = await openCredited(token);

		waiter.send({ op: 'request-credit', entries: remainingPool });
		const queued = await waiter.nextFrame();

		const closed = closeCode(holder);
		// Keep ageing, spending, and the alarm in one object turn. A client round
		// trip could race an independently armed alarm, while ageing after the spend
		// would not test whether partial spending preserved the original timestamp.
		await runInDurableObject(currentServer(), async (instance, state) => {
			const socket = state.getWebSockets().find((candidate) => {
				const held = readCommitSessionAttachment(candidate);

				return held !== undefined && isHoldingCredit(held);
			});

			if (socket === undefined) {
				throw new Error('expected a session holding credit');
			}

			rewindHolding(socket, commitSocketIdleMs + 1);
			const attachment = readCommitSessionAttachment(socket);

			if (attachment === undefined) {
				throw new Error('expected a session holding credit');
			}

			const trickling = new CommitCreditService(instance.context);
			const now = Date.now();
			trickling.admitMessage(socket, attachment, 1, now);
			trickling.release(attachment.sessionId, now);

			await instance.alarm();
		});

		expect({
			queued,
			trickled: await waiter.nextFrame(),
			code: await closed,
			granted: await waiter.nextFrame()
		}).toStrictEqual({
			queued: { ev: 'queued', ahead: 0 },
			trickled: { ev: 'credit', grant: 1 },
			code: 1001,
			granted: { ev: 'credit', grant: remainingPool - 1 }
		});

		waiter.socket.close();
	});

	// Exhausting the balance ends the holding interval. A later grant begins a new
	// interval, so steady progress does not inherit old idle time.
	it('starts a new idle interval after the balance is exhausted', async () => {
		const token = await initialise();
		const spare = 1;
		const holder = await openHoldingPool(
			token,
			defaultCommitEntryCreditBudget - spare
		);
		const spender = await openCredited(token);

		spender.send({ op: 'request-credit', entries: spare });
		const first = await spender.nextFrame();

		spender.send({ op: 'commit', uploadId: unknownUpload('q') });
		const spent = await spender.nextFrame();

		// Age the previous holding timestamp while the balance is zero. The recent
		// commit controls idleness until the next grant replaces that timestamp.
		await rewindPastIdle(
			(attachment) => attachment.credit?.granted === 0,
			rewindHolding
		);

		spender.send({ op: 'request-credit', entries: spare });
		const second = await spender.nextFrame();

		await runIdleClose();

		spender.send({ op: 'commit', uploadId: unknownUpload('r') });
		const alive = await spender.nextFrame();

		expect({
			first,
			spent: spent.ev,
			second,
			alive: alive.ev,
			state: spender.socket.readyState
		}).toStrictEqual({
			first: { ev: 'credit', grant: spare },
			spent: 'error',
			second: { ev: 'credit', grant: spare },
			alive: 'error',
			state: WebSocket.READY_STATE_OPEN
		});

		holder.socket.close();
		spender.socket.close();
	});

	// Subscribe operations admit zero entries and have no matching release. They
	// must not leave a non-zero in-flight count that prevents idle reclamation.
	it('closes a session whose only accounted message commits nothing', async () => {
		const token = await initialise();
		const session = await openCredited(token);
		const closed = closeCode(session);

		session.send({ op: 'subscribe', uploadIds: [unknownUpload('s')] });
		const answer = await session.nextFrame();

		await runIdleClose(isHoldingCredit, rewindHolding);

		expect({ answer: answer.ev, code: await closed }).toStrictEqual({
			answer: 'verdict',
			code: 1001
		});
	});

	// A zero-balance session with declared demand is waiting on the server. It has
	// no credit to reclaim, so an idle close would add only a reconnect.
	it('keeps a session queued for credit through the idle close', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const waiter = await openCredited(token);

		waiter.send({ op: 'request-credit', entries: remainingPool });
		const queued = await waiter.nextFrame();

		await runIdleClose(isQueuedForCredit);

		holder.socket.close();

		expect({
			queued,
			granted: await waiter.nextFrame(),
			state: waiter.socket.readyState
		}).toStrictEqual({
			queued: { ev: 'queued', ahead: 0 },
			granted: { ev: 'credit', grant: remainingPool },
			state: WebSocket.READY_STATE_OPEN
		});

		waiter.socket.close();
	});

	// A grant moves a waiter from the demand clock to a new positive-balance
	// interval. Time spent queued must not consume the interval available for the
	// client to receive and spend that grant.
	it('starts a full idle interval when a waiter receives credit', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const waiter = await openCredited(token);

		waiter.send({ op: 'request-credit', entries: remainingPool });
		const queued = await waiter.nextFrame();

		// The alarm ignores timestamps while demand is positive and the balance is
		// zero, so ageing this waiter cannot race the grant below.
		await rewindPastIdle(isQueuedForCredit);

		holder.send({ op: 'commit', uploadId: unknownUpload('m') });
		const answer = await holder.nextFrame();
		const granted = await waiter.nextFrame();

		await runIdleClose();

		waiter.send({ op: 'commit', uploadId: unknownUpload('n') });
		const spent = await waiter.nextFrame();

		expect({
			queued,
			answer: answer.ev,
			granted,
			spent: spent.ev,
			state: waiter.socket.readyState
		}).toStrictEqual({
			queued: { ev: 'queued', ahead: 0 },
			answer: 'error',
			granted: { ev: 'credit', grant: 1 },
			spent: 'error',
			state: WebSocket.READY_STATE_OPEN
		});

		holder.socket.close();
		waiter.socket.close();
	});

	// Both closing sockets remain listed during this turn. Each rebuild must
	// exclude previously reclaimed balances, including credit already reassigned
	// to the waiter.
	it('returns every reclaimed balance in the same turn', async () => {
		const token = await initialise();
		const first = await openCredited(token);
		const second = await openCredited(token);

		second.send({ op: 'request-credit', entries: remainingPool });
		const toppedUp = await second.nextFrame();

		const waiter = await openCredited(token);
		waiter.send({
			op: 'request-credit',
			entries: defaultCommitEntryCreditBudget
		});
		const queued = await waiter.nextFrame();

		await runInDurableObject(currentServer(), (instance, state) => {
			const reclaiming = new CommitCreditService(instance.context);
			const holders: SessionId[] = [];

			// Capture the original holders before redistribution gives the waiter a
			// positive balance.
			for (const socket of state.getWebSockets()) {
				const attachment = readCommitSessionAttachment(socket);

				if (attachment !== undefined && isHoldingCredit(attachment)) {
					holders.push(attachment.sessionId);
				}
			}

			for (const sessionId of holders) {
				reclaiming.closeSession(sessionId, Date.now());
			}
		});

		expect({
			toppedUp,
			queued,
			grants: [await waiter.nextFrame(), await waiter.nextFrame()]
		}).toStrictEqual({
			toppedUp: { ev: 'credit', grant: remainingPool },
			queued: { ev: 'queued', ahead: 0 },
			grants: [
				{ ev: 'credit', grant: openingGrant },
				{ ev: 'credit', grant: remainingPool }
			]
		});

		first.socket.close();
		second.socket.close();
		waiter.socket.close();
	});

	// Hibernation preserves demand but not in-flight counters. The next alarm can
	// therefore observe both a waiter and newly available capacity. It must grant
	// that capacity even when no session qualifies for closing.
	it('grants free capacity to a rebuilt waiter without closing a session', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const waiter = await openCredited(token);

		waiter.send({ op: 'request-credit', entries: remainingPool });
		const queued = await waiter.nextFrame();

		await runInDurableObject(currentServer(), (instance, state) => {
			const socket = state.getWebSockets().find((candidate) => {
				const held = readCommitSessionAttachment(candidate);

				return held !== undefined && isHoldingCredit(held);
			});
			const attachment =
				socket === undefined ? undefined : readCommitSessionAttachment(socket);

			if (socket === undefined || attachment?.credit === undefined) {
				throw new Error('expected a session holding credit');
			}

			// Model a wake after the holder moved its balance into in-flight work.
			// Hibernation removed that work, while the attachment retained a zero
			// balance. Both sessions remain too recent for idle closure.
			socket.serializeAttachment(
				commitSessionAttachmentSchema.parse({
					...attachment,
					credit: { ...attachment.credit, granted: 0 }
				})
			);

			const woken = new CommitCreditService(instance.context);
			woken.closeIdleSessions(Date.now(), () => new Set<SessionId>());
		});

		expect({ queued, granted: await waiter.nextFrame() }).toStrictEqual({
			queued: { ev: 'queued', ahead: 0 },
			granted: { ev: 'credit', grant: remainingPool }
		});

		holder.socket.close();
		waiter.socket.close();
	});

	// A closing marker must override any stale balance in a durable attachment.
	// The fixture gives the closing session the whole budget; a rebuild that
	// counted it would leave the recorded waiter unserved.
	it('excludes a marked session from a rebuilt total', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const waiter = await openCredited(token);

		waiter.send({ op: 'request-credit', entries: remainingPool });
		const queued = await waiter.nextFrame();

		const rebuilt = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const closing = state.getWebSockets().find((candidate) => {
					const held = readCommitSessionAttachment(candidate);

					return held !== undefined && isHoldingCredit(held);
				});
				const waiting = state.getWebSockets().find((candidate) => {
					const held = readCommitSessionAttachment(candidate);

					return held !== undefined && isQueuedForCredit(held);
				});
				const attachment =
					closing === undefined
						? undefined
						: readCommitSessionAttachment(closing);

				if (
					closing === undefined ||
					waiting === undefined ||
					attachment?.credit === undefined
				) {
					throw new Error('expected a holding session and a waiting one');
				}

				closing.serializeAttachment(
					commitSessionAttachmentSchema.parse({
						...attachment,
						credit: {
							...attachment.credit,
							granted: defaultCommitEntryCreditBudget,
							demand: openingGrant,
							isClosing: true
						}
					})
				);

				const woken = new CommitCreditService(instance.context);
				woken.closeIdleSessions(Date.now(), () => new Set<SessionId>());

				const served = readCommitSessionAttachment(waiting)?.credit;

				return {
					granted: served?.granted,
					demand: served?.demand
				};
			}
		);

		expect({ queued, rebuilt }).toStrictEqual({
			queued: { ev: 'queued', ahead: 0 },
			rebuilt: { granted: remainingPool, demand: 0 }
		});

		holder.socket.close();
		waiter.socket.close();
	});

	// A small publication can wait for a verdict while retaining part of its
	// speculative opening grant. Without competing demand, reclaiming that surplus
	// would force periodic reconnects without making useful capacity available.
	it('keeps a session waiting on a verdict through the idle close', async () => {
		const token = await initialise();
		const session = await openCredited(token);
		const { uploadId } = await deferFreshUpload(
			token,
			'parked',
			'a'.repeat(32)
		);

		session.send({ op: 'commit', uploadId });
		const deferred = await session.nextFrame();

		await runIdleClose(() => true);

		await currentServer().runVerification();

		expect({
			opening: session.capabilities,
			deferred: deferred.ev,
			verdict: await session.nextFrame()
		}).toStrictEqual({
			opening: commitCapabilitiesValueWithCredit(openingGrant),
			deferred: 'deferred',
			verdict: { ev: 'verdict', uploadId, status: 'servable' }
		});

		session.socket.close();
	});

	// Competing demand changes the idle decision. A session awaiting a verdict can
	// still withhold unused credit from another publication. Its pending upload
	// remains durable across the reconnect.
	it('reclaims unused credit from a session awaiting a verdict when another session is waiting', async () => {
		const token = await initialise();
		const parked = await openHoldingPool(token);
		const { uploadId } = await deferFreshUpload(
			token,
			'surplus',
			'd'.repeat(32)
		);

		parked.send({ op: 'commit', uploadId });
		const deferred = await parked.nextFrame();

		const waiter = await openCredited(token);
		waiter.send({ op: 'request-credit', entries: remainingPool });
		const opening = await waiter.nextFrame();

		const closed = closeCode(parked);
		// Select the parked session by its larger balance; the waiter holds one unit.
		await runIdleClose(
			(attachment) => (attachment.credit?.granted ?? 0) > 1,
			rewindHolding
		);

		expect({
			deferred: deferred.ev,
			opening,
			code: await closed,
			granted: await waiter.nextFrame()
		}).toStrictEqual({
			deferred: 'deferred',
			opening: { ev: 'credit', grant: 1 },
			code: 1001,
			granted: { ev: 'credit', grant: remainingPool - 1 }
		});

		waiter.socket.close();
	});

	it("does not reduce a credited session's opening grant while a legacy session is open", async () => {
		const token = await initialise();
		const unpaced = await openCommitSession(token);

		unpaced.send({ op: 'commit', uploadId: unknownUpload('f') });
		const answer = await unpaced.nextFrame();

		const credited = await openCredited(token);

		expect({
			answer: answer.ev,
			unpaced: unpaced.capabilities,
			credited: credited.capabilities
		}).toStrictEqual({
			answer: 'error',
			unpaced: commitCapabilitiesValue,
			credited: commitCapabilitiesValueWithCredit(openingGrant)
		});

		unpaced.socket.close();
		credited.socket.close();
	});

	// Legacy clients treat a server close as the end of publication. Their
	// sessions hold no credit and are bounded at upgrade, so idle reclamation must
	// leave them open.
	it('keeps a legacy session open through the idle pass', async () => {
		const token = await initialise();
		const unpaced = await openCommitSession(token);

		unpaced.send({ op: 'commit', uploadId: unknownUpload('t') });
		const answer = await unpaced.nextFrame();

		await runIdleClose(() => true);

		unpaced.send({ op: 'commit', uploadId: unknownUpload('u') });
		const alive = await unpaced.nextFrame();

		expect({
			answers: [answer.ev, alive.ev],
			state: unpaced.socket.readyState
		}).toStrictEqual({
			answers: ['error', 'error'],
			state: WebSocket.READY_STATE_OPEN
		});

		unpaced.socket.close();
	});

	it.each([
		{ name: 'credited', open: openCredited },
		{ name: 'unpaced', open: (token: string) => openCommitSession(token) }
	])(
		'closes an $name session when its access token expires',
		async ({ open }) => {
			const token = await initialise();
			const session = await open(token);
			const closed = closeDetails(session);

			await runInDurableObject(currentServer(), async (instance, state) => {
				const socket = state.getWebSockets()[0];

				if (socket === undefined) {
					throw new Error('expected an open commit session');
				}

				expireAuthentication(socket);
				await instance.alarm();
			});

			await expect(closed).resolves.toStrictEqual({
				code: commitAuthenticationExpiredCloseCode,
				reason: commitAuthenticationExpiredCloseReason
			});
		}
	);

	// An intermediary can remove the client's credit capability from the upgrade
	// request. The server then accepts an unpaced session while the client still
	// sends `request-credit`. An `unsupported` frame makes the client resume its
	// legacy window without closing the session.
	it('returns unsupported and keeps an unpaced session open after request-credit', async () => {
		const token = await initialise();
		const unpaced = await openCommitSession(token);

		unpaced.send({ op: 'request-credit', entries: 5 });
		const answer = await unpaced.nextFrame();

		unpaced.send({ op: 'commit', uploadId: unknownUpload('o') });
		const committed = await unpaced.nextFrame();

		expect({
			answer,
			committed: committed.ev,
			state: unpaced.socket.readyState
		}).toStrictEqual({
			answer: { ev: 'unsupported', op: 'request-credit' },
			committed: 'error',
			state: WebSocket.READY_STATE_OPEN
		});

		unpaced.socket.close();
	});
});
