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

import { type ExactWorkflowReference } from './convention.ts';

/**
 * Confirms that an exact workflow reference resolves to a workflow file on
 * GitHub and, for a tag, an immutable published release.
 */
export async function verifyWorkflowReference(
	parsed: ExactWorkflowReference,
	options: LookupRepositoryOptions = {}
): Promise<void> {
	const octokit = githubApi(options);

	try {
		if (parsed.pin.kind === 'tag') {
			const release = await octokit.rest.repos.getReleaseByTag({
				owner: parsed.owner,
				repo: parsed.repo,
				tag: parsed.pin.tag
			});

			if (!release.data.immutable) {
				throw new WorkflowReferenceMutableError(
					parsed.reference,
					parsed.pin.value
				);
			}
		}

		const content = await octokit.rest.repos.getContent({
			owner: parsed.owner,
			repo: parsed.repo,
			path: parsed.path,
			ref: parsed.pin.value
		});

		if (Array.isArray(content.data) || content.data.type !== 'file') {
			throw new WorkflowReferenceNotFoundError(parsed.reference);
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
			throw new WorkflowReferenceNotFoundError(parsed.reference);
		}

		if (isGithubRateLimitResponse(error)) {
			throw new GithubRateLimitError();
		}

		if (
			isStatus(error, StatusCodes.UNAUTHORIZED) ||
			isStatus(error, StatusCodes.FORBIDDEN)
		) {
			throw new GithubPermissionError(
				`workflow reference '${parsed.reference}'`
			);
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
