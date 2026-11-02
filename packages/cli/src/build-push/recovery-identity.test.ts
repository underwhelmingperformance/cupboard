import { expect, it } from 'vitest';

import { publicGitHubRecoveryIdentity } from './recovery-identity.ts';

it('allowlists available public GitHub identity without retaining credentials or arbitrary environment', () => {
	expect(
		publicGitHubRecoveryIdentity({
			GITHUB_SERVER_URL: 'https://github.com',
			GITHUB_RUN_ID: '123',
			GITHUB_RUN_ATTEMPT: '1',
			GITHUB_SHA: 'a'.repeat(40),
			GITHUB_REPOSITORY: 'acme/app',
			GITHUB_REPOSITORY_ID: '42',
			GITHUB_WORKFLOW_REF:
				'acme/app/.github/workflows/build.yml@refs/heads/main',
			GITHUB_WORKFLOW_SHA: 'b'.repeat(40),
			GITHUB_REF: 'refs/heads/main',
			GITHUB_TOKEN: 'secret',
			ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-secret',
			AWS_SECRET_ACCESS_KEY: 'aws-secret',
			CUPBOARD_AUTH_TOKEN: 'cupboard-secret',
			ARBITRARY: 'not identity',
			GITHUB_HEAD_REF: undefined
		})
	).toEqual({
		GITHUB_SERVER_URL: 'https://github.com',
		GITHUB_RUN_ID: '123',
		GITHUB_RUN_ATTEMPT: '1',
		GITHUB_SHA: 'a'.repeat(40),
		GITHUB_REPOSITORY: 'acme/app',
		GITHUB_REPOSITORY_ID: '42',
		GITHUB_WORKFLOW_REF: 'acme/app/.github/workflows/build.yml@refs/heads/main',
		GITHUB_WORKFLOW_SHA: 'b'.repeat(40),
		GITHUB_REF: 'refs/heads/main'
	});
	expect(publicGitHubRecoveryIdentity({})).toEqual({});
});
