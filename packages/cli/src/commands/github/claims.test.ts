import { describe, expect, it } from 'vitest';

import { githubBranchClaims, githubPullRequestClaims } from './claims.ts';

const workflowPath = 'acme/app/.github/workflows/publish.yml';
const identity = {
	repositoryId: 1234,
	repositoryOwnerId: 5678,
	fullName: 'acme/app'
};
const audience = 'https://cupboard.example.workers.dev/t/acme';
const exactWorkflowReference = `${workflowPath}@refs/tags/v1.2.3`;

describe('GitHub Actions claims', () => {
	it('returns the default pull-request claim set', () => {
		expect(
			githubPullRequestClaims(audience, identity, {
				pullRequestNumber: 42,
				workflowReference: exactWorkflowReference
			})
		).toStrictEqual({
			iss: 'https://token.actions.githubusercontent.com',
			aud: audience,
			repository_id: '1234',
			repository_owner_id: '5678',
			repository: 'acme/app',
			repository_owner: 'acme',
			sub: 'repo:acme/app:pull_request',
			event_name: 'pull_request',
			ref: 'refs/pull/42/merge',
			ref_type: 'branch',
			job_workflow_ref: exactWorkflowReference
		});
	});

	it('returns the default branch claim set', () => {
		expect(
			githubBranchClaims(audience, identity, {
				branch: 'main',
				eventName: 'push',
				workflowReference: exactWorkflowReference
			})
		).toStrictEqual({
			iss: 'https://token.actions.githubusercontent.com',
			aud: audience,
			repository_id: '1234',
			repository_owner_id: '5678',
			repository: 'acme/app',
			repository_owner: 'acme',
			sub: 'repo:acme/app:ref:refs/heads/main',
			event_name: 'push',
			ref: 'refs/heads/main',
			ref_type: 'branch',
			job_workflow_ref: exactWorkflowReference
		});
	});

	it('omits claims that setup cannot determine for tag patterns', () => {
		expect({
			pullRequest: githubPullRequestClaims(audience, identity),
			branch: githubBranchClaims(audience, identity, { branch: 'main' })
		}).toStrictEqual({
			pullRequest: {
				iss: 'https://token.actions.githubusercontent.com',
				aud: audience,
				repository_id: '1234',
				repository_owner_id: '5678',
				repository: 'acme/app',
				repository_owner: 'acme',
				sub: 'repo:acme/app:pull_request',
				event_name: 'pull_request',
				ref_type: 'branch'
			},
			branch: {
				iss: 'https://token.actions.githubusercontent.com',
				aud: audience,
				repository_id: '1234',
				repository_owner_id: '5678',
				repository: 'acme/app',
				repository_owner: 'acme',
				sub: 'repo:acme/app:ref:refs/heads/main',
				ref: 'refs/heads/main',
				ref_type: 'branch'
			}
		});
	});
});
