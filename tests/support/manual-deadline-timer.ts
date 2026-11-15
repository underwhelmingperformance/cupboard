import type { DeadlineTimer } from '@cupboard/shared/timeout';

interface ArmedDeadline {
	readonly attempt: AbortSignal;
	readonly expire: () => void;
}

/**
Identifies a deadline of a duration that the test does not expect. The code
under test armed it through the timer, and the attempt that armed it fails
with this error. A timer that the code under test arms another way, such as
with `setTimeout`, does not reach the class.
*/
export class UnexpectedDeadlineError extends Error {
	constructor(
		public readonly milliseconds: number,
		public readonly expectedMilliseconds: number
	) {
		super(
			`The code armed a deadline of ${String(milliseconds)} ms, but the test expects ${String(expectedMilliseconds)} ms.`
		);
		this.name = 'UnexpectedDeadlineError';
	}
}

/**
Identifies an attempt to expire a deadline when the number of matching armed
deadlines is not one.
*/
export class DeadlineSelectionError extends Error {
	constructor(
		public readonly matching: number,
		public readonly armed: number
	) {
		super(
			`Expected one armed deadline to expire, found ${String(matching)} of ${String(armed)} armed deadlines.`
		);
		this.name = 'DeadlineSelectionError';
	}
}

/**
A deadline timer that a test expires on purpose. Pass `arm` as the
`deadlineTimer` of the code under test. The timer arms no real timer, so the
test needs no fake global timers and no wall-clock time.

`arm` accepts only deadlines of `expectedMilliseconds`. Any other duration
makes the attempt that armed it fail with {@link UnexpectedDeadlineError}.
*/
export class ManualDeadlineTimer {
	readonly #armed = new Set<ArmedDeadline>();

	readonly arm: DeadlineTimer = (expire, milliseconds, attempt) => {
		if (milliseconds !== this.expectedMilliseconds) {
			throw new UnexpectedDeadlineError(
				milliseconds,
				this.expectedMilliseconds
			);
		}

		const deadline: ArmedDeadline = { attempt, expire };
		this.#armed.add(deadline);

		return () => {
			this.#armed.delete(deadline);
		};
	};

	constructor(readonly expectedMilliseconds: number) {}

	#expireOne(matching: readonly ArmedDeadline[]): void {
		const [deadline] = matching;

		if (deadline === undefined || matching.length !== 1) {
			throw new DeadlineSelectionError(matching.length, this.#armed.size);
		}

		this.#armed.delete(deadline);
		deadline.expire();
	}

	/**
	Expires the deadline of the attempt that received `attempt` as its
	signal. It throws {@link DeadlineSelectionError} unless exactly one armed
	deadline belongs to that signal.
	*/
	expire(attempt: AbortSignal | null | undefined): void {
		this.#expireOne(
			[...this.#armed].filter((deadline) => deadline.attempt === attempt)
		);
	}

	/**
	Expires the only armed deadline. It throws {@link DeadlineSelectionError}
	unless exactly one deadline is armed.
	*/
	expireOnly(): void {
		this.#expireOne([...this.#armed]);
	}
}
