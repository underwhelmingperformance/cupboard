import type { RequestError } from '@octokit/request-error';

type RequestErrorStatus = RequestError['status'];

export function requestErrorStatus(
	error: unknown
): RequestErrorStatus | undefined {
	if (
		!(error instanceof Error) ||
		error.name !== 'HttpError' ||
		!('status' in error) ||
		typeof error.status !== 'number'
	) {
		return undefined;
	}

	return error.status;
}
