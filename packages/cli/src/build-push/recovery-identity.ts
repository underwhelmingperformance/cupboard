const publicGitHubIdentityVariables = [
	'GITHUB_SERVER_URL',
	'GITHUB_JOB',
	'GITHUB_ACTION',
	'GITHUB_ACTION_REPOSITORY',
	'GITHUB_ACTION_REF',
	'GITHUB_RUN_ID',
	'GITHUB_RUN_ATTEMPT',
	'GITHUB_SHA',
	'GITHUB_REPOSITORY',
	'GITHUB_REPOSITORY_ID',
	'GITHUB_WORKFLOW',
	'GITHUB_WORKFLOW_REF',
	'GITHUB_WORKFLOW_SHA',
	'GITHUB_REF',
	'GITHUB_EVENT_NAME',
	'GITHUB_HEAD_REF',
	'GITHUB_BASE_REF',
	'GITHUB_WORKSPACE'
] as const;

/**
Recovery binds public execution identity, never arbitrary child environment or credentials.
*/
export function publicGitHubRecoveryIdentity(
	environment: Readonly<Record<string, string | undefined>>
): Readonly<
	Partial<Record<(typeof publicGitHubIdentityVariables)[number], string>>
> {
	return Object.fromEntries(
		publicGitHubIdentityVariables.flatMap((name) => {
			const value = environment[name];
			return value === undefined ? [] : [[name, value]];
		})
	);
}
