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
	 * Match the close events and ordering from `ws`. Closing during the handshake
	 * emits an error followed by an abnormal close with status 1006. Closing an
	 * open socket emits only status 1005, which `ws` uses when no close frame
	 * supplies a status. Queue the events so tests can deliver a late event from
	 * a superseded connection after the session has changed state.
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
