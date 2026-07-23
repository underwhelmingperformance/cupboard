import { audienceSchema } from '../../audience.ts';

export const githubActionsIssuer =
	'https://token.actions.githubusercontent.com';

export type GithubActionsClaims = Readonly<Record<string, string>>;

export interface GithubRepositoryClaimsIdentity {
	readonly repositoryId: number;
	readonly repositoryOwnerId: number;
	readonly fullName: string;
}

interface PullRequestClaimsOptions {
	readonly pullRequestNumber?: number;
	readonly workflowReference?: string;
}

interface BranchClaimsOptions {
	readonly branch: string;
	readonly eventName?: 'push';
	readonly workflowReference?: string;
}

function repositoryClaims(
	audience: string | URL,
	identity: GithubRepositoryClaimsIdentity
): GithubActionsClaims {
	const repositoryOwner =
		identity.fullName.split('/', 1)[0] ?? identity.fullName;

	return {
		iss: githubActionsIssuer,
		aud: audienceSchema.parse(audience),
		repository_id: String(identity.repositoryId),
		repository_owner_id: String(identity.repositoryOwnerId),
		repository: identity.fullName,
		repository_owner: repositoryOwner
	};
}

export function githubPullRequestClaims(
	audience: string | URL,
	identity: GithubRepositoryClaimsIdentity,
	options: PullRequestClaimsOptions = {}
): GithubActionsClaims {
	return {
		...repositoryClaims(audience, identity),
		sub: `repo:${identity.fullName}:pull_request`,
		event_name: 'pull_request',
		...(options.pullRequestNumber !== undefined && {
			ref: `refs/pull/${String(options.pullRequestNumber)}/merge`
		}),
		ref_type: 'branch',
		...(options.workflowReference !== undefined && {
			job_workflow_ref: options.workflowReference
		})
	};
}

export function githubBranchClaims(
	audience: string | URL,
	identity: GithubRepositoryClaimsIdentity,
	options: BranchClaimsOptions
): GithubActionsClaims {
	const reference = `refs/heads/${options.branch}`;

	return {
		...repositoryClaims(audience, identity),
		sub: `repo:${identity.fullName}:ref:${reference}`,
		...(options.eventName !== undefined && {
			event_name: options.eventName
		}),
		ref: reference,
		ref_type: 'branch',
		...(options.workflowReference !== undefined && {
			job_workflow_ref: options.workflowReference
		})
	};
}
