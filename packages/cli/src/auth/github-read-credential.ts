import { type CacheScope } from '@cupboard/nix-store/scalars';
import {
	type ReadResource,
	readTokenBasicUser,
	readTokenPasswordPrefix
} from '@cupboard/protocol/read-access';

import { type Audience } from '../audience.ts';
import { CupboardClient } from '../client/client.ts';

import {
	fetchGithubOidcToken,
	type GithubOidcEnvironment
} from './github-oidc.ts';
import { type ReadCredentialLease } from './read-credential-session.ts';

export interface IssueGithubReadCredentialInput {
	readonly tenantUrl: URL;
	readonly cache?: CacheScope;
	readonly audience: Audience;
	readonly resources: readonly ReadResource[];
	readonly signal?: AbortSignal;
	readonly now?: () => number;
	readonly fetcher?: typeof fetch;
	readonly environment?: GithubOidcEnvironment;
}

/**
Exchanges the job's GitHub identity for read access to the requested resources.
*/
export async function issueGithubReadCredential(
	input: IssueGithubReadCredentialInput
): Promise<ReadCredentialLease> {
	const requestedAtMs = (input.now ?? Date.now)();
	const client = new CupboardClient(
		input.tenantUrl,
		input.fetcher,
		input.cache ?? { kind: 'default' },
		input.signal
	);
	const subject = await fetchGithubOidcToken({
		audience: input.audience,
		...(input.signal !== undefined && { signal: input.signal }),
		fetcher: client.fetcher,
		...(input.environment !== undefined && { environment: input.environment })
	});
	const exchanged = await client.acquireReadAccess(subject, input.resources);
	return {
		user: readTokenBasicUser,
		password: `${readTokenPasswordPrefix}${exchanged.access_token}`,
		expiresAtMs: requestedAtMs + exchanged.expires_in * 1000,
		resources: exchanged.read_resources,
		authorizationDetails: exchanged.authorization_details
	};
}
