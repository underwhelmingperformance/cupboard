import { StatementParameterLimitError } from '../errors.ts';

import { maxBoundParameters } from './bulk.ts';

/**
 * Refuses a statement that binds more parameters than Cloudflare's SQLite
 * accepts. The D1 binding applies this when a statement is bound and the
 * Durable Object's storage binding applies it when a statement runs, so both
 * report an overrun as a {@link StatementParameterLimitError} carrying the
 * count and the limit.
 *
 * The limit a statement is held to is therefore this repository's constant.
 * SQLite enforces a limit of its own, but which limit depends on how the build
 * was configured: workerd sets 100 and SQLite's own default is 32,766.
 */
export function admitBoundParameters(parameters: number): void {
	if (parameters > maxBoundParameters) {
		throw new StatementParameterLimitError(parameters, maxBoundParameters);
	}
}
