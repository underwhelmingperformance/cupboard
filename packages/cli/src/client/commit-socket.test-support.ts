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
	private isOpen = false;
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

	override emit<E extends keyof CommitSocketEvents>(
		event: E,
		...eventArguments: CommitSocketEvents[E]
	): void {
		if (event === 'open') {
			this.isOpen = true;
		}

		super.emit(event, ...eventArguments);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	/**
	 * Closes the connection as `ws` does, so that a session which closes a
	 * connection itself still sees the events a real close delivers. A socket
	 * still in its handshake is aborted, which `ws` reports as an error followed
	 * by an abnormal close; an open socket reports the close alone, with the
	 * status `ws` uses when no close frame carried one. Both events arrive after
	 * the caller's turn, so a test can reach the state where a late event from a
	 * superseded connection meets the session's guards.
	 */
	close(): void {
		if (this.closed) {
			return;
		}

		this.closed = true;
		const wasOpen = this.isOpen;

		queueMicrotask(() => {
			if (!wasOpen) {
				this.emit(
					'error',
					new Error(
						'WebSocket was closed before the connection was established'
					)
				);
			}

			this.emit('close', wasOpen ? 1005 : 1006, '');
		});
	}
}

/**
The HTTP response of a refused upgrade, scripted the same way.
*/
export class FakeUpgradeFailure
	extends FakeEmitter<UpgradeFailureEvents>
	implements UpgradeFailure
{
	destroyed = false;

	constructor(
		readonly statusCode?: number,
		readonly headers: Readonly<
			Record<string, string | string[] | undefined>
		> = {}
	) {
		super({ data: [], end: [] });
	}

	destroy(): void {
		this.destroyed = true;
	}
}
