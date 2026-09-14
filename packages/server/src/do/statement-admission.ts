import { StatementParameterLimitError } from '../errors.ts';

import { maxBoundParameters } from './bulk.ts';

/**
 * Refuses a statement that binds more parameters than Cloudflare's SQLite
 * accepts. The D1 binding applies this when a statement is bound and the
 * Durable Object's storage binding applies it when a statement runs, so both
 * report an overrun as a {@link StatementParameterLimitError} carrying the
 * count and the limit, before the runtime sees the statement. The limit in
 * force is therefore `maxBoundParameters`, whatever the SQLite build
 * underneath was compiled with.
 */
export function admitBoundParameters(parameters: number): void {
	if (parameters > maxBoundParameters) {
		throw new StatementParameterLimitError(parameters, maxBoundParameters);
	}
}
