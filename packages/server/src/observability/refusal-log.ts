import { type Logger } from '@cupboard/logger';
import { StatusCodes } from 'http-status-codes';

import { ExpectedRefusalError, type ServerHttpError } from '../errors.ts';

/**
The properties of an error that are safe to log. Error messages and stacks can
contain provider text and URLs, so a record that uses these facts leaves them
out.
*/
export interface ErrorFacts {
	readonly errorName?: string;
	readonly errorCode?: string | number;
	readonly errorStatus?: number;
}

const serverErrorStatus: number = StatusCodes.INTERNAL_SERVER_ERROR;

/**
Returns the class name, code and status of `error`, for the properties that
exist. A value that is not an object has none of them.
*/
export function errorFacts(error: unknown): ErrorFacts {
	if (typeof error !== 'object' || error === null) {
		return {};
	}

	return {
		...(error instanceof Error && { errorName: error.name }),
		...('code' in error &&
			(typeof error.code === 'string' || typeof error.code === 'number') && {
				errorCode: error.code
			}),
		...('status' in error &&
			typeof error.status === 'number' && { errorStatus: error.status })
	};
}

/**
Whether a refusal that the server answers with `error` is a server fault that
an operator needs to see. That is an error with status 500 or above that is
not an `ExpectedRefusalError`. Every 4xx status is part of normal protocol
flow, and an expected refusal is normal at any status.
*/
export function isServerFault(error: ServerHttpError): boolean {
	return (
		error.status >= serverErrorStatus &&
		!(error instanceof ExpectedRefusalError)
	);
}

/**
Logs a warning for a refusal that is a server fault. The record has `context`
and the error's class name, code and status, but not its message or stack.
Logs nothing for any other refusal.
*/
export function warnOfRefusal(
	logger: Logger,
	message: string,
	error: ServerHttpError,
	context: Readonly<Record<string, unknown>>
): void {
	if (!isServerFault(error)) {
		return;
	}

	logger.warn(message, { ...context, ...errorFacts(error) });
}
