import { tenantContract } from '@cupboard/protocol/contract';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { ResponseValidationPlugin } from '@orpc/contract/plugins';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';

import { throwIfAborted } from '../abort.ts';

import {
	type AccessCredential,
	bearerHeaders,
	isTokenProvider,
	resolveBearer
} from './credentials.ts';

/**
 * The tenant admin client, derived entirely from the contract: every
 * procedure, path, input and output comes from @cupboard/protocol/contract,
 * and every response is validated against the contract's output schemas
 * before the caller sees it.
 */
export type TenantRpc = JsonifiedClient<
	ContractRouterClient<typeof tenantContract>
>;

export interface TenantRpcOptions {
	readonly credential?: AccessCredential;
	readonly signal?: AbortSignal;
	/** Test hook standing in for global fetch. */
	readonly fetcher?: typeof fetch;
}

const unauthorizedStatusCode = 401;

/**
 * Builds the derived client against a tenant base URL (the worker origin, or
 * `https://host/t/<slug>` for a hosted tenant; the link preserves the path
 * prefix). The credential binds at construction; a provider-backed credential
 * is refreshed once on a 401 and the request retried, matching the long-push
 * behaviour of the hand-written client.
 */
export function tenantRpc(
	baseUrl: string | URL,
	options: TenantRpcOptions = {}
): TenantRpc {
	const { credential, signal, fetcher = fetch } = options;

	const link = new OpenAPILink(tenantContract, {
		url: new URL(baseUrl),
		headers: async () => bearerHeaders(await resolveBearer(credential)),
		fetch: async (request, init) => {
			throwIfAborted(signal);

			// Bodies are buffered JSON, so the clone held back for a retry is
			// cheap.
			const retryable = request.clone();
			const response = await fetcher(request, { ...init, signal });

			if (
				response.status !== unauthorizedStatusCode ||
				!isTokenProvider(credential)
			) {
				return response;
			}

			const headers = new Headers(retryable.headers);
			headers.set('authorization', `Bearer ${await credential.refresh()}`);

			return fetcher(new Request(retryable, { headers }), {
				...init,
				signal
			});
		},
		plugins: [new ResponseValidationPlugin(tenantContract)]
	});

	return createORPCClient(link);
}
