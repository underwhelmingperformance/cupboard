import {
	nixSha256HashSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	commitSessionRequestSchema,
	uploadIdSchema
} from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import { FakeCommitSocket } from './commit-socket.test-support.ts';
import {
	type CommitSessionTarget,
	type CommitSocket,
	runCommitSession
} from './commit-socket.ts';

const storePathHash = storePathHashSchema.parse(
	'0123456789abcdfghijklmnpqrsvwxyz'
);
const narHash = nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`);
const path = '/cache/_default/commit';

// A socket that hands what the client sends to the server standing behind it,
// rather than only recording it.
class ServerDrivenSocket extends FakeCommitSocket {
	constructor(private readonly deliver: (text: string) => void) {
		super();
	}

	override send(data: string): void {
		super.send(data);
		this.deliver(data);
	}
}

interface FakeServerSession {
	readonly socket: ServerDrivenSocket;
	credit: number;
	demand: number;
}

/**
 * A commit server that enforces credit the way the real one does: a tenant-wide
 * budget, an opening grant of whatever is free, a debit per entry admitted, and
 * a release per entry answered that is handed straight to the next session
 * waiting in the rotation. It settles every entry it admits, so the only thing
 * a publication can be held up by here is capacity.
 */
class CreditServerFake {
	private available: number;
	private readonly rotation: FakeServerSession[] = [];
	upgrades = 0;
	queuedFrames = 0;

	readonly connect = (): CommitSocket => {
		this.upgrades += 1;
		const session: FakeServerSession = {
			socket: new ServerDrivenSocket((text) => {
				this.receive(session, text);
			}),
			credit: 0,
			demand: 0
		};
		// Half of what is free, as the real server grants it: the opening grant is
		// speculative, so it may not take a pool the session has not asked for.
		const grant = Math.floor(this.available / 2);
		this.available -= grant;
		session.credit = grant;

		queueMicrotask(() => {
			session.socket.emit('upgrade', {
				headers: {
					'x-cupboard-commit-capabilities': `commit-batch;max=${String(this.batchMax)},commit-credit;grant=${String(grant)}`
				}
			});
			session.socket.emit('open');
		});

		return session.socket;
	};

	constructor(
		private readonly budget: number,
		private readonly batchMax: number
	) {
		this.available = budget;
	}

	private receive(session: FakeServerSession, text: string): void {
		if (text === 'ping') {
			return;
		}

		const request = commitSessionRequestSchema.parse(JSON.parse(text));

		if (request.op === 'request-credit') {
			session.demand = request.entries;

			if (!this.rotation.includes(session)) {
				this.rotation.push(session);
			}

			const isGranted = this.grantWaiting(session);

			if (!isGranted) {
				this.queuedFrames += 1;
				this.send(session, {
					ev: 'queued',
					ahead: this.rotation.indexOf(session)
				});
			}

			return;
		}

		const entries =
			request.op === 'commit-batch'
				? request.commits.map((entry) => entry.uploadId)
				: request.op === 'commit'
					? [request.uploadId]
					: [];

		if (entries.length > session.credit) {
			throw new Error('the client overdrew its credit');
		}

		session.credit -= entries.length;

		for (const uploadId of entries) {
			queueMicrotask(() => {
				this.send(session, {
					ev: 'settled',
					uploadId,
					response: { storePathHash, narHash, status: 'committed' }
				});
				this.available += 1;
				this.grantWaiting();
			});
		}
	}

	// Hands free credit to the waiting sessions a quantum at a time, in rotation
	// order. Returns whether `observed` was among those granted.
	private grantWaiting(observed?: FakeServerSession): boolean {
		let isGrantedObserved = false;

		while (this.available > 0 && this.rotation.length > 0) {
			const session = this.rotation.shift();

			if (session === undefined || session.demand === 0) {
				continue;
			}

			const quantum = Math.min(session.demand, this.batchMax, this.available);
			this.available -= quantum;
			session.credit += quantum;
			session.demand -= quantum;
			this.send(session, { ev: 'credit', grant: quantum });
			isGrantedObserved ||= session === observed;

			if (session.demand > 0) {
				this.rotation.push(session);
			}
		}

		return isGrantedObserved;
	}

	private send(session: FakeServerSession, frame: unknown): void {
		session.socket.emit('message', JSON.stringify(frame));
	}
}

function targetsFor(
	publication: number,
	count: number
): readonly CommitSessionTarget[] {
	return Array.from({ length: count }, (_, index) => ({
		uploadId: uploadIdSchema.parse(
			`upload-${String(publication)}-${String(index)}`
		),
		storePathHash,
		narHash
	}));
}

// Every publication runs the real client against a server whose budget cannot
// cover even one of them, let alone all of them at once. None of them may fail:
// capacity is the server's business to pace, and a client that is paced simply
// takes longer.
describe('publications that oversubscribe the server budget', () => {
	it('settles every path of every publication over one upgrade each', async () => {
		const publications = 5;
		const pathsEach = 6;
		const server = new CreditServerFake(4, 2);

		const runs = Array.from({ length: publications }, async (_, index) => {
			const session = runCommitSession(
				server.connect,
				new URL(`wss://cupboard.test${path}`),
				{},
				{ path, timeoutSeconds: 600 }
			);

			try {
				const outcomes = await Promise.all(
					targetsFor(index, pathsEach).map((target) => session.commit(target))
				);

				return outcomes.map((outcome) => outcome.status);
			} finally {
				session.close();
			}
		});

		const settled = await Promise.all(runs);

		expect({
			publications: settled.length,
			statuses: [...new Set(settled.flat())],
			settledPaths: settled.flat().length,
			// One upgrade per publication: waiting happened on open sockets, and no
			// client re-dialled because it was told to wait.
			upgrades: server.upgrades,
			// The budget really was exhausted, so the run proves what it claims to.
			wasSaturated: server.queuedFrames > 0
		}).toStrictEqual({
			publications,
			statuses: ['committed'],
			settledPaths: publications * pathsEach,
			upgrades: publications,
			wasSaturated: true
		});
	});
});
