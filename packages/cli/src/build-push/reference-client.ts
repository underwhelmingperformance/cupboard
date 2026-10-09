import type { CacheAccessMode, CacheScope } from '@cupboard/nix-store/scalars';

import { contentReadAuthorizationDetails } from '../auth/attenuate.ts';
import { authenticateForPush, type PushAuthOptions } from '../auth/auth.ts';
import { CupboardClient } from '../client/client.ts';
import { cacheAccessFetcher } from '../commands/github.ts';
import {
	CupboardHttpError,
	ReferenceSourceReadRefusedError
} from '../errors.ts';
import type { PushClient } from '../push/push.ts';
import { pushClientFor } from '../push/push-client.ts';
import { referenceSourceReadIntents } from '../push/reference-source-read.ts';

interface ReferenceClientOptions {
	readonly tenantUrl: URL;
	readonly cache: CacheScope;
	readonly client: PushClient;
	readonly auth: PushAuthOptions;
	readonly signal?: AbortSignal;
}
interface ReferenceClientDependencies {
	readonly authenticate?: typeof authenticateForPush;
	readonly createClient?: typeof pushClientFor;
	readonly fetchAccess?: (url: URL) => Promise<CacheAccessMode>;
}

export async function referenceBuildPushClient(
	sources: readonly URL[],
	options: ReferenceClientOptions,
	dependencies: ReferenceClientDependencies = {}
): Promise<PushClient> {
	const sourceReads = await referenceSourceReadIntents(
		sources,
		options,
		dependencies.fetchAccess ?? cacheAccessFetcher({ signal: options.signal })
	);
	if (sourceReads.intents.length === 0) {
		return options.client;
	}
	const client = CupboardClient.fromUrl(options.tenantUrl, {
		cache: options.cache,
		signal: options.signal
	});
	try {
		const credential = await (dependencies.authenticate ?? authenticateForPush)(
			client,
			{
				...options.auth,
				authorizationDetails: [
					...(options.auth.authorizationDetails ?? []),
					...sourceReads.intents.flatMap((intent) =>
						contentReadAuthorizationDetails(intent)
					)
				]
			}
		);
		return (dependencies.createClient ?? pushClientFor)(
			options.tenantUrl,
			credential,
			{
				cache: options.cache,
				signal: options.signal
			}
		);
	} catch (error) {
		if (
			error instanceof CupboardHttpError &&
			error.oauthError?.error === 'invalid_authorization_details' &&
			error.oauthError.problem === 'not-permitted'
		) {
			throw new ReferenceSourceReadRefusedError(sourceReads.sources, {
				cause: error
			});
		}
		throw error;
	}
}
