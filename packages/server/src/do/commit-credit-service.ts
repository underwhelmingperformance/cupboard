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

// How long a commit socket may go without a client message before the alarm
// closes it. Keepalive pings are answered by the runtime and never reach this
// object, so they deliberately do not count as activity: a silent socket is one
// whose push has nothing left to commit.
//
// This must stay comfortably below the client's default wait budget for a
// commit (`defaultCommitWaitSeconds`, 600 s). Closing idle sessions is what
// reclaims credit a session has taken and abandoned, and a reclaim that arrives
// after the waiting client has given up does not help it. A quarter of that
// budget leaves the waiting session time to finish, while staying long enough
// that an ordinary pause between commits does not cost a reopen.
export const commitSocketIdleMs = 150 * 1000;

// The close code for a session closed as idle. The client may reconnect at
// once, so this must not be 1002, the code a client treats as fatal.
const idleCloseCode = 1001;

const entryCountSchema = z.number().int().nonnegative();
const epochMillisSchema = z.number().int().nonnegative();

// The credit half of a commit socket's attachment. `granted` is credit the
// server has handed this session and the session has not yet spent on a commit
// message. `demand` is the number of entries the client last declared it had
// queued and could not send. `hasRequested` records whether the client has ever
// asked for credit over this connection. `unspentSince` is when the session's
// balance last rose from zero, so it measures how long the session has held
// credit without ever emptying it. `isClosing` marks a session whose credit the
// server has already reclaimed, on a socket the object may go on listing until
// its peer answers the close. The optional fields are absent from an attachment
// written before they existed.
const commitCreditStateSchema = z.object({
	granted: entryCountSchema,
	demand: entryCountSchema,
	hasRequested: z.boolean().optional(),
	isClosing: z.boolean().optional(),
	unspentSince: epochMillisSchema.optional()
});
type CommitCreditState = z.infer<typeof commitCreditStateSchema>;

// What a commit session socket carries across a hibernation wake: its cache and
// id, the expiry of the token used for the upgrade, whether the server is
// closing it, its credit state, and when the object last heard from it.
// `credit` is absent when the server does not pace the session. The optional
// fields are absent from attachments written by older deployments.
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
 * What the credit accounting made of one commit message.
 *
 * `accounted` means the entries were debited, so each must return its credit
 * once its frame is sent. `unaccounted` means the server does not pace this
 * session and bounds it only by the number of such sessions, the way it bounded
 * every session before credit: either the session never negotiated credit, or
 * its grant never reached the client and the server has just taken the session
 * out of the accounting. `overdrawn` means the message names more entries than
 * the session holds credit for, and the session has asked for credit, so it
 * knows what it holds. `refused` means serving the message would take the
 * session out of the accounting while the tenant already holds every unpaced
 * session it allows.
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
 * How many of the tenant's sessions the server serves without pacing: those
 * that never negotiated credit, and those a lost grant took out of the
 * accounting. Nothing bounds their messages but their number, so the upgrade
 * and the downgrade hold them to the same bound and have to count them the same
 * way.
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
 * The credit state of a session the accounting still counts: one that
 * negotiated credit, and whose credit the server has not already reclaimed.
 *
 * A reclaimed session keeps its credit state so that every later reader
 * recognises the session as finished, and its socket stays listed until its
 * peer answers the close, which for a peer that never answers is never. Nothing
 * reclaims such a session's credit a second time, so a total, a rotation or a
 * grant that read its state as a live session's would take that credit out of
 * the tenant's pool for good.
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
 * Whether the server has already reclaimed this session's credit, which it does
 * as it closes the session. The socket stays listed until its peer answers the
 * close, so a message the client sent before it read the close still arrives,
 * and the session is finished with the accounting whatever that message asks
 * for.
 */
export function isSessionClosing(attachment: CommitSessionAttachment): boolean {
	return attachment.isClosing === true || attachment.credit?.isClosing === true;
}

/**
 * Whether the tenant holds a session the idle close could act on: one that
 * negotiated credit, and whose credit the server has not already reclaimed.
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
 * Whether a session is doing nothing the tenant should wait for, which is the
 * state the idle close acts on.
 *
 * A session holding credit is measured by how long it has held credit without
 * ever emptying it. Neither a message nor a spend restarts that clock. A
 * session that keeps one entry moving while the rest of the budget stays
 * unspent is holding the budget, whatever it spends, and `request-credit`
 * costs a client nothing to repeat. A client with work to do drains each
 * grant, so the grant that follows starts the clock again. A session holding
 * no credit is measured by its last message, since a socket that has sent no
 * message has nothing left to commit.
 *
 * A session that has declared demand and holds no credit is measured by
 * neither. It is waiting for this object to grant it something, which is what
 * the `queued` frame told it to do.
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
	// An attachment written before the holding stamp existed carries only its
	// activity time.
	const since = isHolding
		? (credit.unspentSince ?? lastActivityAt)
		: lastActivityAt;

	return now - since >= commitSocketIdleMs;
}

/**
 * Admits commit work against a tenant-global budget of entry credit.
 *
 * A session may have as many entries unanswered on the wire as it holds credit
 * for. The server grants a session credit, debits it when a commit message
 * arrives, and returns it to the tenant's pool as each entry's first frame is
 * sent, which is the instant the entry stops occupying this object. A session
 * that wants more declares its demand, and the freed credit reaches it from the
 * release path within the same event.
 *
 * The budget bounds the entries a tenant can have parsed and waiting, so the
 * number of open sockets does not have to. Credit prices the commit ops; the
 * subscribe ops carry no entries and cost none.
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

	// Sums the credit the live sessions hold unspent and re-seeds the rotation
	// from the same attachments, optionally excluding one session. A cold start,
	// whether a wake from hibernation or a fresh object, remembers neither the
	// sum nor the rotation, and both are recorded per socket, so the attachments
	// are a complete source. The rotation takes `getWebSockets()` order, which
	// round-robin makes fair from the next cycle on.
	//
	// The rebuild has to be total because the object can genuinely hibernate with
	// a session waiting: the budget can be exhausted by sessions holding
	// granted-but-unspent credit, with nothing executing to keep the object
	// awake. Persisted demand makes any later event enough to resume granting,
	// and the idle close grants on every pass, so its alarm is always one.
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

	// The momentary count of sessions before this one in the rotation. It is
	// diagnostic only: the rotation moves as soon as any entry settles.
	private sessionsAhead(sessionId: SessionId): number {
		const index = this.rotation.indexOf(sessionId);

		return index === -1 ? this.rotation.length : index;
	}

	// Marks a session as closing and zeroes its credit when it has any. A socket
	// the server has closed stays listed until the client completes the close
	// handshake. Every later sum reads the attachment, so credit left there would
	// be counted both for this session and for the session that received it next.
	//
	// The mark also covers an unpaced session closed at its authentication
	// deadline. The alarm skips marked sessions even if the peer never completes
	// the close handshake.
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
	 * Answers a `request-credit` op: records the declared demand, which replaces
	 * whatever the session declared before, grants what the tenant can spare in
	 * this same event, and answers `queued` when it can spare nothing. A client
	 * with nothing left to commit withdraws its demand by closing the connection,
	 * which returns its credit along with it. Returns false for a session that
	 * never negotiated credit, which was never told the op exists.
	 *
	 * A client asks for credit only when it holds none, so credit still unspent
	 * at a session's first request is credit the client never learned it had: the
	 * opening grant is advertised on the 101 response, and a hop that answers the
	 * handshake itself can drop that header. That credit returns to the tenant
	 * here, and the grant below re-offers it as a `credit` frame, which travels
	 * over the connection and so cannot be stripped the way a handshake header
	 * can. Messages arrive in the order the client sent them, so a commit made
	 * against the opening grant is debited before this request is read. A later
	 * request can race a grant already on its way to the client, but by then the
	 * session has asked once, so this reclaim no longer applies.
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
	 * Closes the commit sockets that are doing nothing the tenant should wait
	 * for: idle in the sense {@link isIdle} defines, holding no entry in flight,
	 * and waiting on no upload's verdict. Closing returns a session's credit to
	 * the pool, and the client reopens the connection when it next has something
	 * to commit, so the close costs it one upgrade. The close is also what keeps
	 * the client's own count of its credit honest: a grant lives only for the
	 * connection it was made on, so losing the connection is how the client
	 * learns the grant is gone.
	 *
	 * A session that never negotiated credit is left alone entirely. Before this
	 * accounting existed the server never closed a commit socket, and a client
	 * built for that server treats a close as the end of its session, so closing
	 * one would break a publication that is doing nothing wrong. Such a session
	 * holds no credit to reclaim, and the tenant may hold only
	 * {@link maxUncreditedCommitSessions} of them, which is the bound those
	 * clients have always had. This exemption is transitional and comes out with
	 * the gate that still admits them.
	 *
	 * A session waiting on a verdict is silent for a good reason. Its entries
	 * were answered with `deferred`, which returned their credit, and the verify
	 * pass can take longer than the idle period, so the session may rightly send
	 * nothing at all until its verdict arrives. Closing it would make exactly the
	 * well-behaved clients reconnect for nothing.
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
