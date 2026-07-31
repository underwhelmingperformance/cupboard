import { CliError, transientExitCode } from '../errors.ts';

/**
 * A destination or reuse-view availability probe answered with a non-2xx
 * status or a body that does not match the shared schema. A network or
 * server condition, not a misuse of the command, so a retry may succeed.
 */
export class DestinationProbeResponseError extends CliError {
	constructor(
		public readonly url: string,
		public readonly status: number,
		cause?: unknown
	) {
		super(
			`Could not read ${url}: HTTP ${String(status)}`,
			cause === undefined ? undefined : { cause }
		);
		this.name = 'DestinationProbeResponseError';
	}

	override get exitCode(): number {
		return transientExitCode;
	}
}
