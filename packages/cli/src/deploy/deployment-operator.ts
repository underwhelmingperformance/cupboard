import { subjectTokenTypeIdToken } from '@cupboard/protocol/oidc';

import { CupboardClient } from '../client/client.ts';
import { controlRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';

import type { DeploymentRunnerClient } from './deployment-runner.ts';

export class DeploymentOperatorIdentityRequiredError extends Error {
	constructor() {
		super(
			'An OIDC identity is required to migrate an existing deployment; sign in with cupboard login and retry'
		);
		this.name = 'DeploymentOperatorIdentityRequiredError';
	}
}

export class DeploymentOperatorUrlUnavailableError extends Error {
	constructor() {
		super(
			'The existing control Worker has no reachable custom domain or workers.dev URL'
		);
		this.name = 'DeploymentOperatorUrlUnavailableError';
	}
}

/**
 * Exchanges the operator's external identity before deployment changes begin.
 * The resulting token retains the verified global-administrator principal
 * which the deployment procedures require in addition to their grants.
 */
export async function deploymentOperatorClient(
	url: string,
	idToken: string,
	signal?: AbortSignal
): Promise<DeploymentRunnerClient> {
	const parsed = parseWorkerUrl(url);
	const raw = CupboardClient.fromUrl(parsed, {
		cache: { kind: 'default' },
		signal
	});
	const token = await raw.tokenExchange(idToken, subjectTokenTypeIdToken);
	const control = controlRpc(parsed, {
		credential: token.access_token,
		signal
	});

	return {
		status: (input) => control.deployment.status(input),
		advance: (input) => control.deployment.advance(input)
	};
}
