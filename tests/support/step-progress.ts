import process from 'node:process';

/**
Where a {@link StepProgress} sends its lines and where it reads the time.
Tests pass both to record the lines and to make the durations predictable.
*/
interface StepProgressOptions {
	/**
	Receives one line of progress, without a trailing newline. The default
	writes the line to standard error.
	*/
	readonly write?: (line: string) => void;
	/**
	Returns the current time in milliseconds. The default is
	`performance.now`.
	*/
	readonly now?: () => number;
}

function writeToStandardError(line: string): void {
	process.stderr.write(`${line}\n`);
}

/**
Reports the steps of a long setup. Each step writes one line when it starts
and one when it finishes or fails. When a hook times out, the step that was
running has a start line and no finish line before the timeout report. The
step keeps running after the timeout, so it can write its finish or failure
line later, for example when the teardown stops the container it waits on.
*/
export class StepProgress {
	private readonly write: (line: string) => void;
	private readonly now: () => number;

	constructor(
		private readonly label: string,
		options: StepProgressOptions = {}
	) {
		this.write = options.write ?? writeToStandardError;
		this.now = options.now ?? (() => performance.now());
	}

	private elapsed(startedAt: number): string {
		return Math.round(this.now() - startedAt).toString();
	}

	/**
	Runs `run` and returns its result. `name` is a noun phrase that completes
	the sentence "<label>: <name> started". A failure of `run` is reported and
	then thrown again unchanged.
	*/
	async step<T>(name: string, run: () => Promise<T>): Promise<T> {
		this.write(`${this.label}: ${name} started`);
		const startedAt = this.now();

		try {
			const result = await run();
			this.write(
				`${this.label}: ${name} finished in ${this.elapsed(startedAt)} ms`
			);

			return result;
		} catch (error) {
			this.write(
				`${this.label}: ${name} failed after ${this.elapsed(startedAt)} ms`
			);

			throw error;
		}
	}
}
