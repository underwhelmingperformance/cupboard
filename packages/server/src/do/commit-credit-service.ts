import { type CacheScope, cacheScopeSchema } from '@cupboard/nix-store/scalars';
import {
	cacheWriterEpoch,
	legacyCacheWriterEpoch
} from '@cupboard/protocol/cache-deployment-manifest';
import { writerEpochSchema } from '@cupboard/protocol/deployment-manifest';
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

// Runtime keepalive responses bypass the Durable Object, so only client frames
// count as activity. This interval allows ordinary pauses between commits while
// ensuring that the server reclaims unused credit before the client's
// 600-second commit wait expires.
export const commitSocketIdleMs = 150 * 1000;

// An idle close is retryable. The client treats 1002 as a fatal protocol error.
const idleCloseCode = 1001;

const entryCountSchema = z.number().int().nonnegative();
const epochMillisSchema = z.number().int().nonnegative();

// `unspentSince` starts when a balance changes from zero to positive.
// `hasRequested` distinguishes a confirmed credit exchange from a possibly lost
// opening grant, and `isClosing` prevents reclaimed credit from being counted
// again. Older attachments can omit these fields.
const commitCreditStateSchema = z.object({
	granted: entryCountSchema,
	demand: entryCountSchema,
	hasRequested: z.boolean().optional(),
	isClosing: z.boolean().optional(),
	unspentSince: epochMillisSchema.optional()
});
type CommitCreditState = z.infer<typeof commitCreditStateSchema>;

// The scheduler rebuilds its in-memory totals and queue from socket attachments
// after hibernation. An absent `credit` field denotes an unpaced session, and
// older deployments can omit the other optional fields.
export const commitSessionAttachmentSchema = z.object({
	cache: cacheScopeSchema,
	sessionId: sessionIdSchema,
	writerEpoch: writerEpochSchema.default(legacyCacheWriterEpoch),
	authenticatedUntil: epochMillisSchema.optional(),
	isClosing: z.boolean().optional(),
	credit: commitCreditStateSchema.optional(),
	lastActivityAt: epochMillisSchema.optional()
});
export type CommitSessionAttachment = z.infer<
	typeof commitSessionAttachmentSchema
>;

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

// Cloudflare can continue to list a socket until its peer completes the close
// handshake. The closing marker excludes its reclaimed balance during that
// interval.
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

export function isSessionClosing(attachment: CommitSessionAttachment): boolean {
	return attachment.isClosing === true || attachment.credit?.isClosing === true;
}

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
 * For a positive balance, the idle interval starts when the balance changes
 * from zero to positive. Partial spending and further requests do not reset that
 * interval. For a zero balance, the latest client frame starts the interval.
 *
 * Declared demand with a zero balance is a server-side wait, not client idleness.
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
	// Old attachments use the activity timestamp as their holding timestamp.
	const since = isHolding
		? (credit.unspentSince ?? lastActivityAt)
		: lastActivityAt;

	return now - since >= commitSocketIdleMs;
}

/**
 * Admission moves each entry from a session's unused balance to the in-flight
 * total. Sending the entry's first frame removes it from the in-flight total and
 * immediately makes that unit available to another waiting session.
 *
 * This bounds parsed commit work across all sessions for a tenant. Subscribe
 * operations resume durable work and therefore consume no entry credit.
 */
export class CommitCreditService {
	// `undefined` means this instance has not rebuilt the unused balances from
	// socket attachments since waking.
	private grantedTotal: number | undefined;

	// In-flight entries exist only while this object instance executes them. A
	// hibernation wake therefore starts with no in-flight work to restore.
	private inFlightTotal = 0;
	private readonly inFlightPerSession = new Map<SessionId, number>();

	private rotation: SessionId[] = [];

	// The binding is stable for the lifetime of this object, and release calls are
	// frequent enough to justify parsing it once.
	private budgetValue: number | undefined;

	constructor(private readonly context: ServerContext) {}

	private budget(): number {
		this.budgetValue ??= commitEntryCreditBudget(this.context.env);

		return this.budgetValue;
	}

	private available(): number {
		return Math.max(0, this.budget() - this.granted() - this.inFlightTotal);
	}

	// Each pass gives at most one batch-sized quantum to a session before moving
	// it behind the other waiters. This prevents a large publication from taking
	// newly released credit before smaller publications receive a turn. The
	// return value tells `declareDemand` whether the observed session received
	// credit during this pass.
	//
	// Waiting must remain durable without keeping the object active. The rotation
	// and each attachment's demand are sufficient to resume allocation on a later
	// release or alarm. A promise, timer, or held request for each waiter would
	// prevent hibernation and incur active-duration charges.
	private grantWaiting(now: number, observed?: SessionId): boolean {
		let isGrantedObserved = false;

		// Rebuilding the total also reconstructs the rotation after hibernation, so
		// it must precede the loop condition. Test the rotation before calling
		// `available()` so a pass with no waiters does not read a misconfigured
		// budget unnecessarily.
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
					// Start a new holding interval only on a zero-to-positive
					// transition. Otherwise a long queue wait would consume the next
					// grant's idle interval, while a top-up could extend an existing
					// interval indefinitely.
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

	// Socket attachments are authoritative after hibernation, and the next cycle
	// begins in `getWebSockets()` order. Excluding a closing session makes its
	// balance available even while Cloudflare still lists the socket.
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

	// Releases advance the rotation after a `queued` frame is sent. Its `ahead`
	// value is therefore a snapshot rather than a scheduling guarantee.
	private sessionsAhead(sessionId: SessionId): number {
		const index = this.rotation.indexOf(sessionId);

		return index === -1 ? this.rotation.length : index;
	}

	// Mark before closing because Cloudflare can keep the socket listed until the
	// peer completes the handshake. Later accounting and alarm passes must exclude
	// its reclaimed balance and must not repeat the close if the peer never replies.
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

	// A downgrade is permanent for this connection. Removing its credit state
	// returns the unused balance and subjects the session to the legacy unpaced
	// session limit.
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
	 * The server grants half of the currently available budget. The grant is
	 * speculative because the client has not declared demand yet. Reserving the
	 * whole budget could block every later session until idle reclamation, while
	 * half lets an uncontended client start immediately and leaves capacity for a
	 * concurrent publication. The client can request the remainder.
	 *
	 * A legacy session has no credit state and receives no opening grant.
	 */
	openSession(
		socket: WebSocket,
		session: {
			readonly cache: CacheScope;
			readonly sessionId: SessionId;
			readonly authenticatedUntil: number;
		},
		hasNegotiated: boolean,
		now: number
	): number {
		if (!hasNegotiated) {
			writeCommitSessionAttachment(socket, {
				...session,
				writerEpoch: cacheWriterEpoch,
				lastActivityAt: now
			});

			return 0;
		}

		const granted = this.granted();
		const opening = Math.floor(this.available() / 2);
		writeCommitSessionAttachment(socket, {
			...session,
			writerEpoch: cacheWriterEpoch,
			credit: { granted: opening, demand: 0, unspentSince: now },
			lastActivityAt: now
		});
		this.grantedTotal = granted + opening;

		return opening;
	}

	// Subscribe operations pass zero because they resume durable work and have no
	// entry whose first result frame could release credit.
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

			// A downgraded session has the same unbounded entry rate as a legacy
			// session. Apply the legacy session limit here or a client could escape
			// entry accounting on every socket up to the general socket ceiling.
			if (
				unpacedSessions(this.context.ctx.getWebSockets()) >=
				maxUncreditedCommitSessions
			) {
				return 'refused';
			}

			// The capability request reached the server, but an intermediary can
			// remove the opening grant from the 101 response. Before the first
			// `request-credit`, an overdraw can therefore mean that the client never
			// learned about credit. Preserve compatibility by downgrading the session.
			this.downgradeSession(socket, attachment, now);

			return 'unaccounted';
		}

		// Initialise the cached total before changing its authoritative attachment.
		// Rebuilding after the write and then subtracting would debit these entries
		// twice.
		const granted = this.granted();

		writeCommitSessionAttachment(socket, {
			...attachment,
			credit: {
				...attachment.credit,
				granted: attachment.credit.granted - entries
			},
			lastActivityAt: now
		});
		this.grantedTotal = granted - entries;

		// Subscribe operations have no first commit frame and therefore no matching
		// release call.
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
	 * Admission charges the whole message before execution, so the caller must also
	 * release entries left unstarted by the batch runner.
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
	 * An intermediary can remove the opening grant from the 101 response. The
	 * first request therefore replaces any unused opening balance with credit sent
	 * over the established WebSocket. Message ordering ensures that any earlier
	 * commit is debited before this replacement. Later requests retain the
	 * session's existing balance.
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
		// Initialise the cached total before changing its authoritative attachment.
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

	// In-flight entries remain charged until their own first frames are sent.
	closeSession(sessionId: SessionId, now: number): void {
		this.markSessionClosing(sessionId);
		// A close callback may run before or after Cloudflare removes the socket.
		// Rebuilding while explicitly excluding this session produces the same total
		// in both cases and reconstructs the rotation at the same time.
		this.grantedTotal = this.sumGranted(sessionId);
		this.grantWaiting(now);
	}

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

	closeExpiredSessions(now: number): void {
		for (const socket of this.context.ctx.getWebSockets()) {
			const attachment = readCommitSessionAttachment(socket);

			if (attachment !== undefined && !isSessionClosing(attachment)) {
				this.closeIfAuthenticationExpired(socket, attachment, now);
			}
		}
	}

	/**
	 * Legacy clients treat any close as the end of publication. Their sessions
	 * hold no credit, and {@link maxUncreditedCommitSessions} bounds them, so this
	 * pass leaves them open. Remove this exception with legacy admission.
	 *
	 * An outstanding commit or upload verdict also protects a session. Commit
	 * execution still occupies credit, while verification can legitimately exceed
	 * the idle interval after the `deferred` frame returned that entry's credit.
	 *
	 * Close a session awaiting a verdict only when another session is waiting for
	 * its unused balance. Opening grants are speculative, so a small publication
	 * can finish sending and retain a surplus while it waits for verdicts. Without
	 * competing demand, reclaiming that surplus would force periodic reconnects
	 * without increasing throughput. With competing demand, the client can recover
	 * its durable pending entries by subscribing again after reconnecting.
	 *
	 * Every pass grants all currently available credit. This lets an alarm resume
	 * a rotation rebuilt after hibernation even when no session is closed.
	 *
	 * The pass reads verdict state lazily and at most once.
	 */
	closeIdleSessions(
		now: number,
		awaitingVerdict: () => ReadonlySet<SessionId>
	): void {
		let parked: ReadonlySet<SessionId> | undefined;
		// Rebuild the rotation before deciding whether unused credit has a waiter.
		this.granted();

		for (const socket of this.context.ctx.getWebSockets()) {
			const attachment = readCommitSessionAttachment(socket);

			// The marker exists because a socket can remain listed after reclamation.
			// Reprocessing it would repeat the close and verdict lookup on every alarm.
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

		// Hibernation discards in-flight counters but preserves declared demand. The
		// alarm must distribute any newly visible capacity even when it closes no
		// session, because no other event may be due for the recorded waiter.
		this.grantWaiting(now);
	}
}
