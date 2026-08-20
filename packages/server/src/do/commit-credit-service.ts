import {
	type StoredCache,
	storedCacheSchema
} from '@cupboard/nix-store/scalars';
import {
	commitAuthenticationExpiredCloseCode,
	commitAuthenticationExpiredCloseReason,
	commitBatchMaxEntries,
	type SessionId,
	sessionIdSchema
} from '@cupboard/protocol/upload';
import { z } from 'zod';

import { commitEntryCreditBudget } from '../policy/commit-credit.ts';
import { maxUncreditedCommitSessions } from '../policy/commit-sockets.ts';

import { sendCommitSessionFrame } from './commit-socket.ts';
import { type ServerContext } from './context.ts';

// The alarm closes a commit socket after 150 seconds without a client message.
// Runtime keepalive responses do not reach this object and therefore do not
// reset client activity.
//
// Keep this below the client's 600-second default commit wait. Closing an idle
// session returns its unused credit while another client can still use it. The
// 150-second interval also permits ordinary pauses between commits.
export const commitSocketIdleMs = 150 * 1000;

// The close code for a session closed as idle. The client may reconnect at
// once, so this must not be 1002, the code a client treats as fatal.
const idleCloseCode = 1001;

const entryCountSchema = z.number().int().nonnegative();
const epochMillisSchema = z.number().int().nonnegative();

// The credit state stored in a commit socket attachment. `granted` is unused
// credit assigned to the session. `demand` is the last number of queued entries
// reported by the client. `hasRequested` records whether the connection has sent
// a credit request. `unspentSince` records when the balance last increased from
// zero. `isClosing` marks a session whose credit has already been reclaimed.
// Older attachments omit the optional fields.
const commitCreditStateSchema = z.object({
	granted: entryCountSchema,
	demand: entryCountSchema,
	hasRequested: z.boolean().optional(),
	isClosing: z.boolean().optional(),
	unspentSince: epochMillisSchema.optional()
});
type CommitCreditState = z.infer<typeof commitCreditStateSchema>;

// The state stored with a commit session socket across a hibernation wake. It
// records the cache, session identifier, token expiry, closing state, credit
// state, and time of the last client message. `credit` is absent when the server
// does not pace the session. Attachments written by older deployments omit the
// optional fields. On a cold start, the scheduler rebuilds this state from
// `getWebSockets()`.
export const commitSessionAttachmentSchema = z.object({
	cache: storedCacheSchema,
	sessionId: sessionIdSchema,
	authenticatedUntil: epochMillisSchema.optional(),
	isClosing: z.boolean().optional(),
	credit: commitCreditStateSchema.optional(),
	lastActivityAt: epochMillisSchema.optional()
});
export type CommitSessionAttachment = z.infer<
	typeof commitSessionAttachmentSchema
>;

/**
 * The accounting result for one commit message.
 *
 * `accounted` means the service debited every entry. Each entry returns its
 * credit after sending its first frame.
 *
 * `unaccounted` means the server does not pace the session. The session either
 * did not negotiate credit or did not receive its opening grant.
 *
 * `overdrawn` means the message contains more entries than the session's unused
 * credit. `refused` means removing the session from accounting would exceed the
 * tenant's limit for unpaced sessions.
 */
export type CommitCreditDecision =
	'accounted' | 'unaccounted' | 'overdrawn' | 'refused';

export function readCommitSessionAttachment(
	socket: WebSocket
): CommitSessionAttachment | undefined {
	const parsed = commitSessionAttachmentSchema.safeParse(
		socket.deserializeAttachment()
	);

	return parsed.success ? parsed.data : undefined;
}

/**
 * Counts the tenant's sessions that the server does not pace. These include
 * sessions that did not negotiate credit and sessions removed from accounting
 * after a lost grant. Their messages have no per-entry credit limit, so admission
 * and downgrade enforce the same session-count limit.
 */
export function unpacedSessions(sockets: readonly WebSocket[]): number {
	return sockets.filter((socket) => {
		const attachment = readCommitSessionAttachment(socket);

		return (
			attachment !== undefined &&
			attachment.credit === undefined &&
			!isSessionClosing(attachment)
		);
	}).length;
}

/**
 * Returns the credit state of a session that remains in the accounting.
 *
 * A closing socket can remain listed until its peer completes the close
 * handshake. Its attachment retains `isClosing` so later readers exclude it
 * from totals and do not reclaim its credit twice.
 */
function countedCredit(
	attachment: CommitSessionAttachment | undefined
): CommitCreditState | undefined {
	const credit = attachment?.credit;

	return attachment === undefined ||
		credit === undefined ||
		isSessionClosing(attachment)
		? undefined
		: credit;
}

/**
 * Returns whether the server has reclaimed the session's credit and started
 * closing it. A client message sent before the peer receives the close can still
 * arrive, but the session no longer participates in accounting.
 */
export function isSessionClosing(attachment: CommitSessionAttachment): boolean {
	return attachment.isClosing === true || attachment.credit?.isClosing === true;
}

/**
 * Returns whether the tenant has a paced session whose credit has not been
 * reclaimed.
 */
export function hasPacedSession(sockets: readonly WebSocket[]): boolean {
	return sockets.some(
		(socket) => countedCredit(readCommitSessionAttachment(socket)) !== undefined
	);
}

function writeCommitSessionAttachment(
	socket: WebSocket,
	attachment: CommitSessionAttachment
): void {
	socket.serializeAttachment(commitSessionAttachmentSchema.parse(attachment));
}

/**
 * Returns whether the idle-session policy can close a session.
 *
 * For a session with unused credit, the idle interval starts when its balance
 * first increases from zero and does not restart until the balance is exhausted.
 * For a session without credit, the interval starts at its last client message.
 *
 * A session with declared demand and no credit is waiting for the server and is
 * therefore not idle.
 */
function isIdle(attachment: CommitSessionAttachment, now: number): boolean {
	const { credit, lastActivityAt } = attachment;

	if (lastActivityAt === undefined) {
		return false;
	}

	if (credit?.granted === 0 && credit.demand > 0) {
		return false;
	}

	const isHolding = credit !== undefined && credit.granted > 0;
	// An attachment written before `unspentSince` existed contains only its
	// activity time.
	const since = isHolding
		? (credit.unspentSince ?? lastActivityAt)
		: lastActivityAt;

	return now - since >= commitSocketIdleMs;
}

/**
 * Admits commit work against a tenant-global budget of entry credit.
 *
 * A session can have no more unacknowledged entries than its credit. The server
 * debits credit when a commit message arrives and returns it to the tenant after
 * sending each entry's first frame. A session declares demand for more credit,
 * and the release path assigns available credit during the same event.
 *
 * The budget limits parsed and waiting entries across the tenant. Commit
 * operations consume credit; subscribe operations contain no entries and do not.
 */
export class CommitCreditService {
	// Credit granted to live sessions and not yet spent, summed across sockets.
	// `undefined` until the first use on this instance rebuilds it from the
	// socket attachments.
	private grantedTotal: number | undefined;

	// Entries debited from a session and not yet answered with their first
	// frame, in total and per session. They live only in this instance's memory,
	// which is correct: an entry cannot outlive the object executing it, so a
	// cold start begins with none.
	private inFlightTotal = 0;
	private readonly inFlightPerSession = new Map<SessionId, number>();

	// The sessions with unmet demand, in the order they are next served.
	private rotation: SessionId[] = [];

	// The tenant's budget, read once: the binding cannot change under a live
	// object, and the read is on the path of every entry released.
	private budgetValue: number | undefined;

	constructor(private readonly context: ServerContext) {}

	private budget(): number {
		this.budgetValue ??= commitEntryCreditBudget(this.context.env);

		return this.budgetValue;
	}

	// The credit the tenant can grant right now.
	private available(): number {
		return Math.max(0, this.budget() - this.granted() - this.inFlightTotal);
	}

	// Hands free credit to the waiting sessions, one quantum each in rotation
	// order, until either the credit or the demand runs out. A session that
	// still wants more goes to the back, so a large publication cannot drain the
	// budget before a small one has had a turn, and no session can be starved.
	// Returns whether `observed` was among the sessions granted, which is how
	// `declareDemand` tells an answered request from a queued one.
	//
	// A waiting session must never hold a pending server-side promise, timer or
	// request. A waiter exists only as an entry in this rotation and as the
	// demand recorded in its socket attachment, and grants happen in the release
	// path, so an object with nothing executing hibernates while its sessions
	// wait. A parked promise, a timer or a held request per waiter would turn
	// that free waiting into active duration, which Durable Objects bill by the
	// second.
	private grantWaiting(now: number, observed?: SessionId): boolean {
		let isGrantedObserved = false;

		// Two constraints fix this order. Rebuild before reading the rotation: on
		// a cold start the rotation is empty until the credit total is rebuilt,
		// and the rebuild is what fills it, so reading the rotation first would
		// find it empty and grant nothing to a session that is genuinely waiting.
		// Then read the rotation before what is free: `available()` reads the
		// tenant's budget, which a misconfigured deployment cannot supply, so a
		// pass with nobody to grant to must not depend on it. The rebuild reads
		// only the attachments.
		this.granted();

		while (this.rotation.length > 0 && this.available() > 0) {
			const sessionId = this.rotation.shift();

			if (sessionId === undefined) {
				break;
			}

			const socket = this.context.ctx.getWebSockets(sessionId)[0];
			const attachment =
				socket === undefined ? undefined : readCommitSessionAttachment(socket);
			const credit = countedCredit(attachment);

			// The session hung up, has had its credit reclaimed, or has since had
			// its demand met, so it leaves the rotation.
			if (
				socket === undefined ||
				attachment === undefined ||
				credit === undefined ||
				credit.demand === 0
			) {
				continue;
			}

			const quantum = Math.min(
				credit.demand,
				commitBatchMaxEntries,
				this.available()
			);
			const demand = credit.demand - quantum;
			const granted = this.granted();

			writeCommitSessionAttachment(socket, {
				...attachment,
				credit: {
					...credit,
					granted: credit.granted + quantum,
					demand,
					// A session that had spent everything holds credit again from
					// now: without this a waiter granted after a long wait would
					// carry the stamp from before the wait, and would be closed before
					// its commit could cross the wire. A session that still held
					// credit keeps its stamp, so topping it up cannot put the close
					// off.
					...(credit.granted === 0 && { unspentSince: now })
				}
			});
			this.grantedTotal = granted + quantum;
			sendCommitSessionFrame(socket, { ev: 'credit', grant: quantum });
			isGrantedObserved ||= sessionId === observed;

			if (demand > 0) {
				this.rotation.push(sessionId);
			}
		}

		return isGrantedObserved;
	}

	private granted(): number {
		this.grantedTotal ??= this.sumGranted();

		return this.grantedTotal;
	}

	// Rebuilds the unused-credit total and the waiting-session rotation from
	// socket attachments, optionally excluding one session. A cold start retains
	// neither value in memory, so attachments are the complete source. The next
	// round-robin cycle starts from `getWebSockets()` order.
	//
	// Rebuild every attachment because the object can hibernate while a session
	// waits and other sessions retain unused credit. Persisted demand lets any
	// later event resume allocation. The idle-close alarm provides such an event.
	private sumGranted(excluded?: SessionId): number {
		let granted = 0;
		this.rotation = [];

		for (const socket of this.context.ctx.getWebSockets()) {
			const attachment = readCommitSessionAttachment(socket);
			const credit = countedCredit(attachment);

			if (attachment === undefined || credit === undefined) {
				continue;
			}

			if (attachment.sessionId === excluded) {
				continue;
			}

			granted += credit.granted;

			if (credit.demand > 0) {
				this.rotation.push(attachment.sessionId);
			}
		}

		return granted;
	}

	// The current number of sessions before this one in the rotation. This value
	// is diagnostic only because completing an entry advances the rotation.
	private sessionsAhead(sessionId: SessionId): number {
		const index = this.rotation.indexOf(sessionId);

		return index === -1 ? this.rotation.length : index;
	}

	// Marks a listed session as closing and resets any credit it still holds. A
	// closed socket remains listed until the client completes the close handshake,
	// so credit calculations must ignore it to avoid counting reassigned credit
	// twice.
	//
	// The marker also makes alarm and idle-close passes ignore an unpaced session
	// closed at its authentication deadline, even if the peer never completes the
	// handshake.
	private markSessionClosing(sessionId: SessionId): void {
		const socket = this.context.ctx.getWebSockets(sessionId)[0];
		const attachment =
			socket === undefined ? undefined : readCommitSessionAttachment(socket);

		if (socket === undefined || attachment === undefined) {
			return;
		}

		writeCommitSessionAttachment(socket, {
			...attachment,
			isClosing: true,
			...(attachment.credit !== undefined && {
				credit: {
					...attachment.credit,
					granted: 0,
					demand: 0,
					isClosing: true
				}
			})
		});
	}

	// Takes a session out of the credit accounting for the rest of its life: its
	// unspent credit goes back to the tenant, and from then on the server bounds
	// it the way it bounds a session that never negotiated credit. The recompute
	// is the one `closeSession` uses, since a session carrying no credit state is
	// exactly a session the sum must not count.
	private downgradeSession(
		socket: WebSocket,
		attachment: CommitSessionAttachment,
		now: number
	): void {
		writeCommitSessionAttachment(socket, {
			...attachment,
			credit: undefined,
			lastActivityAt: now
		});
		this.grantedTotal = this.sumGranted();
		this.grantWaiting(now);
	}

	/**
	 * Records a newly accepted commit socket and returns the credit it opens
	 * with: half of what the tenant has free, rounded down. The caller
	 * advertises the return value on the 101, so an uncontended tenant starts
	 * committing without a further round trip.
	 *
	 * Half rather than all of it, because this grant is speculative: the session
	 * has asked for nothing yet and may never commit at all. A session handed the
	 * whole pool on arrival would starve every later session until it closed or
	 * the idle close reclaimed its credit, which is a long time to keep a
	 * publication waiting for capacity nothing is using. Halving bounds that by
	 * construction and costs a session nothing it asked for, since
	 * `request-credit` remains unbounded.
	 *
	 * A session that did not negotiate credit is recorded without any and opens
	 * at zero, since nothing paces it.
	 */
	openSession(
		socket: WebSocket,
		session: {
			readonly cache: StoredCache;
			readonly sessionId: SessionId;
			readonly authenticatedUntil: number;
		},
		hasNegotiated: boolean,
		now: number
	): number {
		if (!hasNegotiated) {
			writeCommitSessionAttachment(socket, { ...session, lastActivityAt: now });

			return 0;
		}

		const granted = this.granted();
		const opening = Math.floor(this.available() / 2);
		writeCommitSessionAttachment(socket, {
			...session,
			// The session holds this grant from now: the idle close measures a
			// holder from the moment its balance rose from zero.
			credit: { granted: opening, demand: 0, unspentSince: now },
			lastActivityAt: now
		});
		this.grantedTotal = granted + opening;

		return opening;
	}

	/**
	 * Applies one client message to the session: records that the session was
	 * heard from, and debits the entries the message commits. Pass zero entries
	 * for a message that commits none.
	 */
	admitMessage(
		socket: WebSocket,
		attachment: CommitSessionAttachment,
		entries: number,
		now: number
	): CommitCreditDecision {
		if (attachment.credit === undefined) {
			writeCommitSessionAttachment(socket, {
				...attachment,
				lastActivityAt: now
			});

			return 'unaccounted';
		}

		if (entries > attachment.credit.granted) {
			if (attachment.credit.hasRequested === true) {
				return 'overdrawn';
			}

			// Once a session leaves the accounting, nothing bounds it but the number
			// of unpaced sessions the tenant allows, which is the bound the upgrade
			// applies to a session that never negotiated credit. Without the same
			// bound here, a client could take every socket it opens out of the
			// accounting and hold as many as the socket ceiling allows.
			if (
				unpacedSessions(this.context.ctx.getWebSockets()) >=
				maxUncreditedCommitSessions
			) {
				return 'refused';
			}

			// The client declared the capability on its upgrade request, but its
			// grant travelled back on the 101 response, and a hop that answers the
			// handshake itself can drop that header. A session that has never asked
			// for credit has sent nothing that shows the offer reached it, so the
			// server reads the overdraw as a lost offer and takes the session out of
			// the accounting.
			this.downgradeSession(socket, attachment, now);

			return 'unaccounted';
		}

		// Read the total before writing the attachment. A cold start rebuilds the
		// total from these same attachments, so a rebuild triggered by the
		// adjustment below would already include this debit and count it twice.
		const granted = this.granted();

		// The spend leaves the stamp alone: it measures how long the session has
		// held credit without emptying it, and spending part of a balance is not
		// emptying it.
		writeCommitSessionAttachment(socket, {
			...attachment,
			credit: {
				...attachment.credit,
				granted: attachment.credit.granted - entries
			},
			lastActivityAt: now
		});
		// The entries move from the session's unspent credit into this object, so
		// the tenant's free credit is unchanged until they are answered.
		this.grantedTotal = granted - entries;

		// A message that commits nothing puts nothing in flight. Recording it
		// would leave a count no release ever removes, since only an entry's frame
		// releases anything.
		if (entries > 0) {
			this.inFlightTotal += entries;
			this.inFlightPerSession.set(
				attachment.sessionId,
				(this.inFlightPerSession.get(attachment.sessionId) ?? 0) + entries
			);
		}

		return 'accounted';
	}

	/**
	 * Returns credit to the tenant's pool as an entry's first frame is sent, and
	 * passes it straight on to the waiting sessions. `entries` is how many
	 * entries this call answers for. Every entry of a message
	 * {@link admitMessage} accounted for must be released, whether or not the
	 * commit that entry names ever ran.
	 */
	release(sessionId: SessionId, now: number, entries = 1): void {
		this.inFlightTotal -= entries;
		const remaining =
			(this.inFlightPerSession.get(sessionId) ?? entries) - entries;

		if (remaining <= 0) {
			this.inFlightPerSession.delete(sessionId);
		} else {
			this.inFlightPerSession.set(sessionId, remaining);
		}

		this.grantWaiting(now);
	}

	/**
	 * Handles a `request-credit` operation. The declared demand replaces the
	 * previous value. The server assigns available credit during the same event or
	 * returns `queued` when none is available. Closing the connection withdraws
	 * demand and returns unused credit. Returns `false` for a session that did not
	 * negotiate credit.
	 *
	 * A proxy can remove the opening credit header from the 101 response. On the
	 * session's first request, reclaim any unused opening credit and return it in a
	 * `credit` frame, which travels over the established connection. WebSocket
	 * message ordering ensures that an earlier commit using the opening grant is
	 * debited first. Reclamation applies only to the first credit request.
	 */
	declareDemand(
		socket: WebSocket,
		attachment: CommitSessionAttachment,
		entries: number,
		now: number
	): boolean {
		if (attachment.credit === undefined) {
			return false;
		}

		const { sessionId } = attachment;
		// Read the total before writing the attachment, for the reason
		// `admitMessage` gives: a rebuild would already include the write below.
		const total = this.granted();
		const orphaned =
			attachment.credit.hasRequested === true ? 0 : attachment.credit.granted;

		writeCommitSessionAttachment(socket, {
			...attachment,
			credit: {
				...attachment.credit,
				granted: attachment.credit.granted - orphaned,
				demand: entries,
				hasRequested: true
			},
			lastActivityAt: now
		});
		this.grantedTotal = total - orphaned;

		if (!this.rotation.includes(sessionId)) {
			this.rotation.push(sessionId);
		}

		if (this.grantWaiting(now, sessionId)) {
			return true;
		}

		sendCommitSessionFrame(socket, {
			ev: 'queued',
			ahead: this.sessionsAhead(sessionId)
		});

		return true;
	}

	/**
	 * Reclaims a closed session's unspent credit and passes it to the sessions
	 * still waiting. Entries the session left in flight are unaffected: each
	 * still returns its own credit when its commit finishes.
	 */
	closeSession(sessionId: SessionId, now: number): void {
		this.markSessionClosing(sessionId);
		// Recompute from the attachments rather than adjusting a running total: a
		// closing socket may or may not still be listed when its close is handled,
		// and a sum that excludes the session is right either way. Sessions close
		// rarely, so the scan costs little, and it re-seeds the rotation at the
		// same time.
		this.grantedTotal = this.sumGranted(sessionId);
		this.grantWaiting(now);
	}

	/**
	 * The earliest access-token expiry among sessions that remain open.
	 */
	nextAuthenticationExpiry(): number | undefined {
		let earliest: number | undefined;

		for (const socket of this.context.ctx.getWebSockets()) {
			const attachment = readCommitSessionAttachment(socket);
			const expiresAt = attachment?.authenticatedUntil;

			if (
				attachment === undefined ||
				expiresAt === undefined ||
				isSessionClosing(attachment)
			) {
				continue;
			}

			earliest =
				earliest === undefined ? expiresAt : Math.min(earliest, expiresAt);
		}

		return earliest;
	}

	/**
	 * Closes one session if the access token from its upgrade has expired.
	 * Returns whether the caller must stop processing the session.
	 */
	closeIfAuthenticationExpired(
		socket: WebSocket,
		attachment: CommitSessionAttachment,
		now: number
	): boolean {
		if (
			attachment.authenticatedUntil === undefined ||
			attachment.authenticatedUntil > now
		) {
			return false;
		}

		this.closeSession(attachment.sessionId, now);
		socket.close(
			commitAuthenticationExpiredCloseCode,
			commitAuthenticationExpiredCloseReason
		);

		return true;
	}

	/**
	 * Closes every session whose upgrade token has expired.
	 */
	closeExpiredSessions(now: number): void {
		for (const socket of this.context.ctx.getWebSockets()) {
			const attachment = readCommitSessionAttachment(socket);

			if (attachment !== undefined && !isSessionClosing(attachment)) {
				this.closeIfAuthenticationExpired(socket, attachment, now);
			}
		}
	}

	/**
	 * Closes sessions that are idle, have no entry in progress, and await no upload
	 * verdict. Closing returns unused credit to the tenant. The client reconnects
	 * before its next commit and thereby learns that the connection-scoped grant
	 * has expired.
	 *
	 * Do not close sessions that did not negotiate credit. Older clients treat a
	 * close as the end of publication, and these sessions have no credit to
	 * reclaim. {@link maxUncreditedCommitSessions} limits their number. Remove this
	 * compatibility exception with the gate that admits those clients.
	 *
	 * Do not close a session that awaits a verdict. A `deferred` frame already
	 * returned its credit, and verification can exceed the idle interval.
	 *
	 * A parked session is closed only for credit another session is waiting for.
	 * Every connection opens on an unsolicited share of the free pool, so a
	 * publication smaller than that share parks while still holding the rest, and
	 * closing such a session every time it parks would cost it a reconnect every
	 * idle period for nothing. With a session in the rotation the surplus is what
	 * that session is queued for, and the close returns it. The close does not
	 * lose the parked entries: the client picks them up again by subscribing to
	 * their durable rows on the connection it reopens.
	 *
	 * Every pass ends by granting what the tenant has free, so the alarm is the
	 * event a rebuilt rotation can always count on, whether or not the pass
	 * closed anything.
	 *
	 * `awaitingVerdict` is called at most once per pass, and only for a session
	 * that has failed the cheaper tests, so a pass over busy sessions reads no
	 * rows.
	 */
	closeIdleSessions(
		now: number,
		awaitingVerdict: () => ReadonlySet<SessionId>
	): void {
		let parked: ReadonlySet<SessionId> | undefined;
		// Read the granted total before the loop: on a cold start it is what
		// rebuilds the rotation from the attachments, and the rotation is how this
		// pass tells whether any session is waiting for the credit a parked
		// session holds.
		this.granted();

		for (const socket of this.context.ctx.getWebSockets()) {
			const attachment = readCommitSessionAttachment(socket);

			// A session marked closing is finished work, kept only so that a
			// message crossing the close is recognised as one from a session the
			// server has already closed. Its socket stays listed until the peer
			// answers or the runtime reaps it, which for a peer that never answers
			// is never, so testing it again would repeat a recompute and a verdict
			// read on every firing for as long as it hangs about.
			if (attachment?.credit === undefined || isSessionClosing(attachment)) {
				continue;
			}

			if (!isIdle(attachment, now)) {
				continue;
			}

			if ((this.inFlightPerSession.get(attachment.sessionId) ?? 0) > 0) {
				continue;
			}

			const isWanted =
				attachment.credit.granted > 0 && this.rotation.length > 0;

			if (!isWanted) {
				parked ??= awaitingVerdict();

				if (parked.has(attachment.sessionId)) {
					continue;
				}
			}

			this.closeSession(attachment.sessionId, now);
			socket.close(idleCloseCode, 'idle');
		}

		// Hand out what the tenant has free, whether or not this pass closed
		// anything. An object that woke with nothing in memory has forgotten the
		// entries that were in flight, so the budget can read as free with a
		// waiter recorded in an attachment and no other event due: this alarm is
		// the event that resumes granting for it.
		this.grantWaiting(now);
	}
}
