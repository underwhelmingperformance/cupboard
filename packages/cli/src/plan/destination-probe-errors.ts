import { CliError, transientExitCode } from '../errors.ts';

/**
 * The destination or reuse-view availability probe returned a non-2xx status
 * or a body that does not match the shared schema. The failure is transient
 * because a retry may succeed without changing the command.
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
