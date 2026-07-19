import { StatusCodes } from 'http-status-codes';

import { abortReason } from '../../abort.ts';
import {
	WorkflowReferenceMutableError,
	WorkflowReferenceNotFoundError
} from '../../errors.ts';
import {
	githubApi,
	GithubPermissionError,
	GithubRateLimitError,
	isGithubRateLimitResponse,
	type LookupRepositoryOptions
} from '../oidc-trust/github.ts';

import { parsePinnedWorkflowReference } from './convention.ts';

/**
 * Confirms that a workflow pin resolves to a file on GitHub and that a tag is
 * protected by an immutable published release.
 */
export async function verifyPinnedWorkflowReference(
	reference: string,
	options: LookupRepositoryOptions = {}
): Promise<void> {
	const parsed = parsePinnedWorkflowReference(reference);
	const octokit = githubApi(options);

	try {
		if (parsed.pin.kind === 'tag') {
			const release = await octokit.rest.repos.getReleaseByTag({
				owner: parsed.owner,
				repo: parsed.repo,
				tag: parsed.pin.tag
			});

			if (!release.data.immutable) {
				throw new WorkflowReferenceMutableError(reference, parsed.pin.value);
			}
		}

		const content = await octokit.rest.repos.getContent({
			owner: parsed.owner,
			repo: parsed.repo,
			path: parsed.path,
			ref: parsed.pin.value
		});

		if (Array.isArray(content.data) || content.data.type !== 'file') {
			throw new WorkflowReferenceNotFoundError(reference);
		}
	} catch (error) {
		if (options.signal?.aborted === true) {
			throw abortReason(options.signal);
		}

		if (
			error instanceof WorkflowReferenceMutableError ||
			error instanceof WorkflowReferenceNotFoundError
		) {
			throw error;
		}

		if (isStatus(error, StatusCodes.NOT_FOUND)) {
			throw new WorkflowReferenceNotFoundError(reference);
		}

		if (isGithubRateLimitResponse(error)) {
			throw new GithubRateLimitError();
		}

		if (
			isStatus(error, StatusCodes.UNAUTHORIZED) ||
			isStatus(error, StatusCodes.FORBIDDEN)
		) {
			throw new GithubPermissionError(`workflow reference '${reference}'`);
		}

		throw error;
	}
}

function isStatus(error: unknown, status: number): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		error.status === status
	);
}
