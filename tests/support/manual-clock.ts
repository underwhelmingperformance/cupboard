import { abortable, throwIfAborted } from '../../packages/cli/src/abort.ts';

interface PendingDelay {
	readonly milliseconds: number;
	readonly dueAtMs: number;
	readonly signal: AbortSignal;
	readonly resolve: () => void;
}

export class ManualClock {
	#nowMs = 0;
	readonly #delays = new Set<PendingDelay>();
	#changed = Promise.withResolvers<undefined>();

	readonly now = (): number => this.#nowMs;

	readonly wait = async (
		milliseconds: number,
		signal: AbortSignal
	): Promise<void> => {
		throwIfAborted(signal);
		const pending = Promise.withResolvers<undefined>();
		const delay: PendingDelay = {
			milliseconds,
			dueAtMs: this.#nowMs + milliseconds,
			signal,
			resolve: () => {
				pending.resolve(undefined);
			}
		};
		this.#delays.add(delay);
		this.#notify();

		try {
			await abortable(pending.promise, signal);
		} finally {
			this.#delays.delete(delay);
			this.#notify();
		}
	};

	#findDelay(milliseconds: number): PendingDelay | undefined {
		return [...this.#delays].find(
			(delay) => delay.milliseconds === milliseconds && !delay.signal.aborted
		);
	}

	#notify(): void {
		const changed = this.#changed;
		this.#changed = Promise.withResolvers<undefined>();
		changed.resolve(undefined);
	}

	async waitForDelay(milliseconds: number): Promise<void> {
		while (this.#findDelay(milliseconds) === undefined) {
			await this.#changed.promise;
		}
	}

	async advanceThroughDelay(milliseconds: number): Promise<void> {
		await this.waitForDelay(milliseconds);
		const delay = this.#findDelay(milliseconds);

		if (delay === undefined) {
			throw new Error(
				'The expected clock delay was cancelled before advancement'
			);
		}

		this.advanceTo(delay.dueAtMs);
	}

	advanceTo(nowMs: number): void {
		if (nowMs < this.#nowMs) {
			throw new Error('The manual clock cannot move backwards');
		}

		this.#nowMs = nowMs;

		for (const delay of this.#delays) {
			if (delay.dueAtMs > nowMs) {
				continue;
			}

			this.#delays.delete(delay);
			delay.resolve();
		}

		this.#notify();
	}
}
