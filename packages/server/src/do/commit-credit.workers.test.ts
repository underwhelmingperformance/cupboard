import {
	DEFAULT_CACHE,
	storePathHashSchema,
	WIRE_DEFAULT_CACHE
} from '@cupboard/nix-store/scalars';
import {
	commitAcceptCapabilitiesHeader,
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

// A session the server paces, which is what a client that understands credit
// opens.
function openCredited(token: string): Promise<CommitConversation> {
	return openCommitSession(token, DEFAULT_CACHE, commitCreditAccept);
}

// An id no pending row holds. Committing it answers an `error` frame, which is
// one of the three first frames that return an entry's credit, and it costs no
// upload fixture.
function unknownUpload(seed: string): UploadId {
	return uploadIdSchema.parse(`missing-${seed}`);
}

// Pushes a path all the way through, then names it again the way a reconnect
// re-sends an entry whose reply was lost. The path is committed and its pending
// row is gone, so the entry resolves against the path's narinfo and answers
// `settled` at once.
async function settledEntry(
	token: string,
	hashCharacter: string
): Promise<ParsedCommitBatchEntry> {
	const name = `settled-${hashCharacter}`;
	// Each path needs a NAR of its own: negotiate answers `reuse` for a hash the
	// cache already holds, and a reused path is never uploaded or committed.
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

// Makes every R2 presence probe fault, which is what a batched entry whose
// pending row is gone runs into while it resolves the path's narinfo. The entry
// rejects, and `mapWithConcurrency` starts none of the entries behind it.
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

// A batch entry no commit ever runs: the message naming it is refused before
// the fan-out, so the entry only has to parse.
function unrunEntry(hashCharacter: string): ParsedCommitBatchEntry {
	return {
		uploadId: unknownUpload(hashCharacter),
		storePathHash: storePathHashSchema.parse(hashCharacter.repeat(32)),
		narHash: nixSha256Hash(hashCharacter)
	};
}

// Gives the tenant a budget that is not a positive integer, which is what a
// deployment reaches by setting the variable to anything the policy refuses.
function misconfigureBudget(): Promise<void> {
	return runInDurableObject(currentServer(), (instance) => {
		instance.context.env = {
			...instance.context.env,
			CUPBOARD_COMMIT_ENTRY_CREDIT_BUDGET: 'half a dozen'
		};
	});
}

// Reclaims the credit of the session holding some, the way the idle close does,
// and leaves its socket open: that is the state a peer leaves behind by never
// answering the close the server sent it.
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

// The session behind the first socket `isChosen` picks out. A test names a
// session while it is still the only one in that state, so that it can read
// what the object records against that one session later on.
function sessionMatching(
	isChosen: (attachment: CommitSessionAttachment) => boolean
): Promise<SessionId> {
	return runInDurableObject(currentServer(), (_instance, state) => {
		const attachment = state
			.getWebSockets()
			.map((socket) => readCommitSessionAttachment(socket))
			.find((candidate) => candidate !== undefined && isChosen(candidate));

		if (attachment === undefined) {
			throw new Error('expected a session the test could name');
		}

		return attachment.sessionId;
	});
}

// The parts of a session's credit state the accounting turns on. The holding
// stamp is left out because it carries a wall-clock time.
type CreditFacts = Pick<
	NonNullable<CommitSessionAttachment['credit']>,
	'demand' | 'granted' | 'hasRequested' | 'isClosing'
>;

// What the object records against one session.
function recordedCredit(sessionId: SessionId): Promise<CreditFacts> {
	return runInDurableObject(currentServer(), (_instance, state) => {
		const socket = state.getWebSockets(sessionId)[0];
		const credit =
			socket === undefined
				? undefined
				: readCommitSessionAttachment(socket)?.credit;

		if (credit === undefined) {
			throw new Error('expected a session the object records credit for');
		}

		const { demand, granted, hasRequested, isClosing } = credit;

		return { demand, granted, hasRequested, isClosing };
	});
}

// What the server did with a message from a session it has already closed: the
// frame it answered, or the close it repeated, since the frame reader rejects
// when the socket closes before a frame arrives. Reading either settles once
// the object has handled the message.
async function answerTo(session: CommitConversation): Promise<string> {
	try {
		const frame = await session.nextFrame();

		return frame.ev;
	} catch {
		return 'closed';
	}
}

// Whether a pass of the alarm leaves the object due to wake again. The drop,
// the pass and the read share one call, since an alarm armed in another call is
// not visible to this pool's storage view.
function doesAlarmRearm(): Promise<boolean> {
	return runInDurableObject(currentServer(), async (instance, state) => {
		await state.storage.deleteAlarm();
		await instance.alarm();

		return typeof (await state.storage.getAlarm()) === 'number';
	});
}

// The close code the server reported, for a socket the server is expected to
// close.
function closeCode(session: CommitConversation): Promise<number> {
	return new Promise((resolve) => {
		session.socket.addEventListener('close', (event) => {
			resolve(event.code);
		});
	});
}

// Rewinds both of a session's stamps: when the server last heard from it, and
// when the credit it holds began sitting unspent. A session reaches this state
// by going that long without doing either.
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

// Rewinds only the holding stamp and leaves the activity stamp untouched, which
// is the state a client reaches by talking without committing anything.
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

// Rewinds the sessions `isChosen` picks out past the idle period, leaving the
// close to a later turn.
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

// Closes the idle sessions the way the alarm does, first rewinding the sessions
// `isChosen` picks out past the idle period. Both happen in one turn, so an
// alarm of the object's own cannot reach the rewound sessions first. Called
// with no argument it runs against the sessions as they stand.
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

// A session holding credit it has not spent, which is what the idle close
// exists to reclaim.
function isHoldingCredit(attachment: CommitSessionAttachment): boolean {
	return (attachment.credit?.granted ?? 0) > 0;
}

// A session the server has told to wait: it has declared demand and holds
// nothing to spend.
function isQueuedForCredit(attachment: CommitSessionAttachment): boolean {
	const { credit } = attachment;

	return credit !== undefined && credit.demand > 0 && credit.granted === 0;
}

// What a session opens with against an idle tenant: half of the free pool.
const openingGrant = Math.floor(defaultCommitEntryCreditBudget / 2);
// What the tenant still has free once one session has opened.
const remainingPool = defaultCommitEntryCreditBudget - openingGrant;

// Opens a session and has it ask for `entries` of the tenant's credit, which is
// what a publication with work queued does. The session's opening grant returns
// to the tenant at its first request, so it asks for everything it is to hold,
// and a grant is capped at `commitBatchMaxEntries`, so the answer arrives as one
// frame per quantum. Asking for no more than the tenant can cover leaves the
// session no unmet demand, so it drops out of the rotation and the sessions that
// follow it are the ones served next.
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

	// A deployment that configured its budget with something other than a
	// positive integer cannot pace anything, and the upgrade fails. It has to
	// fail before the accept: a socket the object has accepted stays in
	// `getWebSockets()` whatever the upgrade answers, so a dial would cost the
	// tenant a socket of its ceiling every time.
	it('accepts no socket when the tenant credit budget is misconfigured', async () => {
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

	// The budget governs credited work and nothing else. The alarm drives the
	// object's other background loops after the idle close, and the close runs
	// even for a tenant holding no socket at all, so a misconfigured budget must
	// not stop it: the pass reaches the budget only once it has a session to
	// grant to. Reaching the end of the alarm is the assertion, since every later
	// loop is awaited inside it.
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

	// A client that never negotiated credit has no credit to reclaim, so its
	// close must not read the budget either. Its hang-up runs the same reclaim
	// every close runs, and a throw there would leave the handshake unfinished on
	// a socket that still counts against the tenant's ceiling.
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

	// A tenant whose sessions are waiting for credit cannot be served at all
	// without a budget, so there the misconfiguration surfaces rather than being
	// swallowed. The pass runs on a service that has not read the budget yet,
	// which is the state of an object that woke since the deployment changed;
	// one that read a good value before keeps it.
	it('fails a close pass when a waiter needs the misconfigured budget', async () => {
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

	// The idle close leaves a session that never negotiated credit alone, and
	// only a credited session joins the rotation, so a tenant holding neither has
	// nothing for a pass to do. Re-arming for one would wake the object every
	// idle period for as long as the socket stayed open, and a Durable Object is
	// billed for the wake.
	it('re-arms the idle close only while a credited session is open', async () => {
		const token = await initialise();
		const unpaced = await openCommitSession(token);

		const isArmedForUnpaced = await doesAlarmRearm();

		const credited = await openCredited(token);
		const isArmedForCredited = await doesAlarmRearm();

		expect({ isArmedForUnpaced, isArmedForCredited }).toStrictEqual({
			isArmedForUnpaced: false,
			isArmedForCredited: true
		});

		unpaced.socket.close();
		credited.socket.close();
	});

	// A session the close has finished with keeps its credit state, so a message
	// crossing the close still reads a zero balance, and its socket stays listed
	// until the peer answers. A peer that never answers would otherwise leave the
	// tenant waking every idle period for a session the close is done with.
	it('leaves the alarm unarmed for a session it has already closed', async () => {
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

	// The socket of a session the close has finished with stays listed until its
	// peer answers, so every later pass finds it again with nothing left to do
	// for it: reclaiming twice recomputes a total that has not moved and reads
	// the parked sessions for a session already gone. That read is the
	// observable, since the pass asks for it only once it means to close
	// something.
	it('leaves a session it has already closed out of the next pass', async () => {
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

				// Nothing else spares it: it has been silent past the idle period,
				// and the rewind shares this turn with the pass.
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

	// The credit state stays behind for exactly this: a message the client sent
	// before it read the close is recognised as one from a session the server has
	// finished with. The server repeats the close and runs nothing. The session
	// below has asked for credit and been answered, so it knows what it holds,
	// and the close it now meets is the server's own doing rather than anything
	// the client got wrong: the code has to be one the client retries.
	it('repeats the close for a message that crosses it', async () => {
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

	// A request for credit that crosses the close would otherwise re-arm the
	// session it came from: the accounting would record the demand and grant
	// against it, and nothing would ever reclaim what it was given, since the
	// idle close is done with the session and a peer that never answers its close
	// fires no close event. The session below asks for the whole budget, so a
	// grant to it is a grant the tenant never gets back.
	it('grants nothing to a request for credit that crosses the close', async () => {
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
		const answered = await answerTo(ghost);

		// The holder's credit goes back to the tenant, which rebuilds the rotation
		// and hands out everything the tenant has free. The waiter is the only
		// session left to serve, so it must be handed the whole budget however
		// much the reclaimed session declared.
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

	// A session whose queue never outgrew its opening grant never asks for
	// credit, and it is the ordinary shape the idle close acts on. A commit that
	// crosses that close names more entries than the reclaimed session holds, so
	// without the closing mark the server would read a lost grant, take the
	// session out of the accounting and run the whole message: entries committed
	// for a session it has already closed, every frame unsendable, and a socket
	// that from then on holds one of the unpaced sessions the tenant allows, with
	// nothing left that may close it.
	it('runs no commit for a message that crosses the close of a session that never asked for credit', async () => {
		const token = await initialise();
		const ghost = await openCredited(token);

		await reclaimHeldSession();

		ghost.send({
			op: 'commit-batch',
			commits: [unrunEntry('m'), unrunEntry('n')]
		});
		const answered = await answerTo(ghost);
		const unpaced = await runInDurableObject(
			currentServer(),
			(_instance, state) => unpacedSessions(state.getWebSockets())
		);

		expect({ answered, unpaced }).toStrictEqual({
			answered: 'closed',
			unpaced: 0
		});
	});

	// A session opens on half of what is free, so no session can take the pool
	// without asking for it, and two sessions opening in turn are offered half
	// and then half of the rest.
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

	// Once one session holds the whole budget, the next opens on nothing and is
	// told so when it declares demand: there is no credit left to hand out.
	it('grants no more than the budget and queues the session it cannot cover', async () => {
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

	// An entry's credit returns to the tenant as its first frame is sent,
	// whichever frame that is, and reaches the waiting session in the same
	// exchange.
	it.each([
		{
			answer: 'settled',
			commit: (token: string): Promise<CommitSessionRequest> =>
				reCommitOfSettledPath(token)
		},
		{
			answer: 'deferred',
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
			answer: 'error',
			commit: (_token: string): Promise<CommitSessionRequest> =>
				Promise.resolve({ op: 'commit', uploadId: unknownUpload('c') })
		}
	])(
		'returns the credit of an entry answered with $answer',
		async ({ answer, commit }) => {
			const token = await initialise();
			const request = await commit(token);
			const holder = await openHoldingPool(token);
			const waiter = await openCredited(token);

			waiter.send({ op: 'request-credit', entries: 50 });
			const queued = await waiter.nextFrame();

			holder.send(request);
			const first = await holder.nextFrame();
			const granted = await waiter.nextFrame();

			expect({ queued, answer: first.ev, granted }).toStrictEqual({
				queued: { ev: 'queued', ahead: 0 },
				answer,
				granted: { ev: 'credit', grant: 1 }
			});

			holder.socket.close();
			waiter.socket.close();
		}
	);

	// A batch is debited whole and returns its credit an entry at a time, and the
	// fan-out starts no entry behind one that rejects. The message has to return
	// what those abandoned entries took, or the tenant circulates less credit
	// after every storage fault. It has to answer them too, or the client waits
	// out its own deadline on entries this object has stopped working on.
	it('answers the entries a failing batch entry abandons and returns their credit', async () => {
		const token = await initialise();
		const commits: ParsedCommitBatchEntry[] = [];

		// One path per entry, and more entries than the fan-out starts at once, so
		// the first rejection leaves some of them unstarted. The hash characters
		// skip 'e', which the nix base32 alphabet does not have.
		for (const character of ['a', 'b', 'c', 'd', 'f', 'g', 'h', 'i']) {
			commits.push(await settledEntry(token, character));
		}

		const holder = await openHoldingPool(token);
		const waiter = await openCredited(token);

		waiter.send({ op: 'request-credit', entries: remainingPool });
		const queued = await waiter.nextFrame();

		await faultPresenceProbes();
		holder.send({ op: 'commit-batch', commits });

		// Every entry of the batch is answered: the fault reached each one that
		// ran and stopped the rest before they started, so all of them are named
		// in an error the client retries.
		const answers = await Promise.all(commits.map(() => holder.nextFrame()));

		// The entries that ran return their credit one at a time; the ones the
		// first rejection abandoned come back together as the message settles.
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

	// Two entries free one unit of credit each. Round-robin gives one to each
	// waiting session; serving them in the order they declared demand would give
	// both to the first, whose demand is far from met.
	it('serves the waiting sessions in turn', async () => {
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

	// A session that has asked for credit has been answered over this same
	// connection, so it knows what it holds, and a message naming more entries
	// than that can only be a client bug. 1002 is the close a client treats as
	// final rather than retrying.
	it('closes a session that commits more entries than the credit it asked for', async () => {
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

	// A socket the server closes stays listed until the client answers, so the
	// credit has to move in the same event as the close: the session that
	// overdrew keeps nothing, and what it held reaches the waiting session at
	// once.
	it('returns the credit of a session it closes for overdrawing', async () => {
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

	// The grant a session opens with is advertised on the 101 response, and a hop
	// that rewrites the handshake can drop it. Such a client believes it
	// negotiated no credit and commits unpaced, so the server reads an overdraw
	// from a session that has never asked for credit as a lost offer: it serves
	// the message, and the session leaves the accounting for the rest of its
	// life.
	it('serves and downgrades a session that overdraws credit it never asked for', async () => {
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

	// The downgrade above serves a session by taking it out of the accounting,
	// and the only bound left on it is the number of unpaced sessions the tenant
	// allows. Once the tenant holds that many, the session is refused instead,
	// with a close the client retries: an upgrade refused at the same bound is
	// retryable too, so a client that genuinely lost its grant gets the offer
	// again on a new connection.
	it('refuses the downgrade once the tenant holds every unpaced session it allows', async () => {
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

	// The opening grant travels only in the 101 capability token, so a hop that
	// answers the handshake itself can strand it: the client commits believing it
	// holds nothing, and the grant sits in the attachment for the life of the
	// connection. A client asks for credit only when it holds none, so credit
	// unspent at the first request is exactly that stranded grant. It returns to
	// the tenant, and the answer re-offers it in a frame the client can see.
	it('reclaims an opening grant the session never learned of', async () => {
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
			// The stranded grant is back in the pool, so the next session opens on
			// half of everything the first one did not ask for.
			reopened: commitCapabilitiesValueWithCredit(
				Math.floor((defaultCommitEntryCreditBudget - demand) / 2)
			)
		});

		stranded.socket.close();
		reopened.socket.close();
	});

	// A session that spent its opening grant before asking has nothing to
	// reclaim, so its first request is answered out of the tenant's free credit
	// alone.
	it('grants only free credit to a session that spent its opening grant', async () => {
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

	// A session that hangs up returns the credit it never spent, so the server
	// never has to expire a grant or ask for one back.
	it('returns the credit a closed session never spent', async () => {
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

	// A cold start remembers neither the credit it has granted nor the sessions
	// waiting for more. Both are recorded in the socket attachments, so a fresh
	// scheduler reading only those must reach the same state. The waiter below is
	// granted one entry's worth: it would be the whole budget if the rebuilt
	// total had missed the credit the holder's attachment claims, and no grant
	// would arrive at all if the rebuilt rotation had not found the waiter.
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

	// The idle close is what recovers a session that took credit and fell silent,
	// and its firing is the wake a waiting session can always count on.
	it('closes a silent session on the alarm and passes its credit on', async () => {
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

	// `request-credit` costs nothing and can be sent as often as a client likes,
	// so a session that keeps asking while spending nothing would hold the whole
	// budget for as long as it kept talking. What the idle close measures for a
	// session holding credit is how long it has held that credit unspent.
	it('closes a session that keeps talking while it holds unspent credit', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const waiter = await openCredited(token);

		waiter.send({ op: 'request-credit', entries: remainingPool });
		const queued = await waiter.nextFrame();

		// The holder is heard from now and has spent nothing since it opened, so
		// only the spend stamp is rewound.
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

	// The idle close measures how long a session has held credit without
	// emptying it, so a session holding the budget cannot put it off by
	// keeping one entry moving. The entry it spends returns its own credit; the
	// rest is credit nothing is using.
	it('closes a session that trickles one entry while it holds the pool', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const waiter = await openCredited(token);

		waiter.send({ op: 'request-credit', entries: remainingPool });
		const queued = await waiter.nextFrame();

		const closed = closeCode(holder);
		// The rewind, the trickled entry and the close run in one turn. Sending
		// the entry from the client would expose the holder to the close across a
		// round trip, in which an alarm the object armed on its own traffic can
		// close it before the entry lands, and rewinding after that entry hides the
		// behaviour under test: what this asserts is that spending leaves the
		// holding clock alone, so the stamp the close reads is still the old one.
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
			// The trickled entry's own credit reaches the waiter as it is released.
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

	// A client with work to do spends what it is granted, so the grant that
	// follows starts the clock again and the idle close leaves the session alone
	// however long its publication runs.
	it('keeps a session that spends each grant before asking for the next', async () => {
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

		// The stamp the session carries is older than the idle period, so only
		// the grant that follows the spend can save it from the close. Rewinding
		// it while the session holds nothing is safe: a session with no credit is
		// measured by its last message, which is the commit above.
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

	// A message that commits nothing puts nothing in flight, so it must leave no
	// count behind: nothing releases what a subscribe never took, and the idle
	// close never touches a session the object still counts entries for.
	it('closes a session whose only accounted message commits nothing', async () => {
		const token = await initialise();
		const session = await openCredited(token);
		const closed = closeCode(session);

		// The reply says the id is gone, and it is also what tells this test the
		// message was accounted before the close runs.
		session.send({ op: 'subscribe', uploadIds: [unknownUpload('s')] });
		const answer = await session.nextFrame();

		await runIdleClose(isHoldingCredit, rewindHolding);

		expect({ answer: answer.ev, code: await closed }).toStrictEqual({
			answer: 'verdict',
			code: 1001
		});
	});

	// A session that has declared demand and holds no credit is waiting on this
	// object, which is what the `queued` frame told it to do. Closing it returns
	// nothing to the tenant and costs the client a reconnect.
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

	// The idle close spares a session waiting with credit 0, and measures one
	// holding credit. A grant moves the session from the first state to the
	// second, and the wait before it must not count against the grant: the client
	// has a round trip in which to spend it, and alarms fire on ordinary traffic,
	// not on the idle period's beat.
	it('gives a waiter the idle period to spend the grant that reached it', async () => {
		const token = await initialise();
		const holder = await openHoldingPool(token);
		const waiter = await openCredited(token);

		waiter.send({ op: 'request-credit', entries: remainingPool });
		const queued = await waiter.nextFrame();

		// Rewinding a session the alarm is forbidden to close is safe across the
		// round trip below: while it holds no credit and has demand outstanding,
		// neither stamp is consulted. Widening this to a session holding credit
		// would let an alarm of the object's own close it before the grant lands.
		await rewindPastIdle(isQueuedForCredit);

		// One entry of the holder's frees one unit, which the release hands to the
		// waiter.
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

	// A socket the server has closed stays listed until the client answers, so a
	// later reclaim in the same pass still reads its attachment. Both reclaims
	// below run against sessions the object still lists, which is that state
	// exactly: the second must not count the credit the first has already handed
	// to the waiter.
	it('returns the credit of every session reclaimed in one turn', async () => {
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

			// Choose the holders before reclaiming any of them, since the first
			// reclaim hands its credit to the waiter and would otherwise put the
			// waiter in this set.
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

	// An object that woke with nothing in memory rebuilds its rotation from the
	// attachments, but it has forgotten the entries that were in flight, so the
	// budget can read as free with a waiter recorded and nothing else due to
	// happen. The alarm has to hand that credit out even on a pass that closes
	// nothing, or the waiter sits beside free credit until an unrelated message
	// arrives.
	it('grants to a rebuilt waiter on a pass that closes nothing', async () => {
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

			// The holder spent its credit on entries that were still executing when
			// the object went away: the attachment survives saying it holds nothing,
			// the count of what was in flight does not, so the whole budget reads as
			// free to the object that wakes. Both sessions were heard from a moment
			// ago, so this pass closes neither.
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

	// A cold start rebuilds the credit total and the rotation from the socket
	// attachments, and an attachment outlives the code that wrote it, so the
	// closing mark has to be enough on its own: a session carrying it is out of
	// the accounting whatever balance its attachment still claims. The closing
	// attachment below claims the whole budget, so a rebuild that counted it
	// would find the tenant with nothing to hand out and leave the waiter with
	// the demand it arrived with.
	it('leaves a closing session out of a rebuilt total', async () => {
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

	// This is the ordinary shape of a publication: it opens on an unsolicited
	// share of the pool, commits fewer entries than that share, and parks on the
	// verdicts holding the rest. Nobody is queued for what it holds, so closing
	// it would cost it a reconnect every idle period and return credit to a
	// tenant with no use for it.
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
			// The session still holds all but the entry it spent.
			opening: commitCapabilitiesValueWithCredit(openingGrant),
			deferred: 'deferred',
			verdict: { ev: 'verdict', uploadId, status: 'servable' }
		});

		session.socket.close();
	});

	// The exemption above is for a session that has nothing left to give back.
	// A session parked on a verdict still holds credit, which is what the
	// tenant's other publications are queued for, so the holding clock applies to
	// it too, and its parked entry survives the close on its durable row.
	it('closes a verdict-parked session that holds credit it never spent', async () => {
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
		// The parked session is the one holding the rest of the budget; the
		// waiter holds the single unit the tenant had free.
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

	// A session that did not negotiate credit is outside the accounting
	// entirely. It is granted nothing, so it cannot reduce what another session
	// is offered, and it never joins the rotation, so no `credit` frame is ever
	// addressed to it.
	it('grants nothing to a session that did not negotiate credit', async () => {
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

	// Before this accounting existed the server never closed a commit socket, and
	// a client built for that server treats a close as the end of its session, so
	// the idle close leaves such a session alone however long it is silent. It
	// holds no credit to reclaim, and the number of them a tenant may hold is
	// bounded at the upgrade.
	it('keeps a session that never negotiated credit through the idle close', async () => {
		const token = await initialise();
		const unpaced = await openCommitSession(token);

		// The session has to be heard from once, or the object has no activity to
		// measure it by.
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

	// A client decides to pace itself from the declaration it sent, and the
	// server decides to pace the session from the declaration it received, so a
	// hop that drops the request header leaves a client asking for credit the
	// session was never given. The op is answered the way an op this server does
	// not know is answered, which is a reply the client falls back from: it
	// commits through its own window, which is what the session was accepted as.
	it('answers a session that asks for credit it never negotiated', async () => {
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
