import type {
	CommitSocket,
	CommitSocketData,
	UpgradeFailure,
	UpgradeResponse
} from './commit-socket.ts';

interface CommitSocketEvents {
	open: [];
	upgrade: [response: UpgradeResponse];
	message: [data: CommitSocketData];
	close: [code: number, reason: CommitSocketData];
	error: [error: Error];
	'unexpected-response': [request: unknown, response: UpgradeFailure];
}

interface UpgradeFailureEvents {
	data: [chunk: CommitSocketData];
	end: [];
}

class FakeEmitter<Events extends Record<keyof Events, readonly unknown[]>> {
	constructor(
		private readonly listeners: {
			[E in keyof Events]: ((...eventArguments: Events[E]) => void)[];
		}
	) {}

	on<E extends keyof Events>(
		event: E,
		listener: (...eventArguments: Events[E]) => void
	): this {
		this.listeners[event].push(listener);

		return this;
	}

	emit<E extends keyof Events>(event: E, ...eventArguments: Events[E]): void {
		const listeners = this.listeners[event];
		for (const listener of listeners) {
			listener(...eventArguments);
		}
	}
}

/**
 * A scriptable commit socket standing in for a `ws` connection: tests play
 * the server's side through {@link FakeEmitter.emit} and observe the traffic
 * the client sent and whether it closed the socket.
 */
export class FakeCommitSocket
	extends FakeEmitter<CommitSocketEvents>
	implements CommitSocket
{
	readonly sent: string[] = [];
	closed = false;

	constructor() {
		super({
			open: [],
			upgrade: [],
			message: [],
			close: [],
			error: [],
			'unexpected-response': []
		});
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.closed = true;
	}
}

/** The HTTP response of a refused upgrade, scripted the same way. */
export class FakeUpgradeFailure
	extends FakeEmitter<UpgradeFailureEvents>
	implements UpgradeFailure
{
	constructor(readonly statusCode?: number) {
		super({ data: [], end: [] });
	}
}
