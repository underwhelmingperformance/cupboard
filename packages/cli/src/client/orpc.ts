import { controlContract, tenantContract } from '@cupboard/protocol/contract';
import { createORPCClient } from '@orpc/client';
import type { AnyContractRouter, ContractRouterClient } from '@orpc/contract';
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
 * The control-plane admin client, derived from the control contract the same
 * way {@link TenantRpc} derives from the tenant one.
 */
export type ControlRpc = JsonifiedClient<
	ContractRouterClient<typeof controlContract>
>;

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
	return derivedClient(tenantContract, new URL(baseUrl), options);
}

/**
 * Builds the derived control client against the deployment's bare host; the
 * contract's procedures live under its `/control` prefix.
 */
export function controlRpc(
	baseUrl: string | URL,
	options: TenantRpcOptions = {}
): ControlRpc {
	const url = new URL(baseUrl);
	url.pathname = `${url.pathname.replace(/\/$/, '')}/control`;

	return derivedClient(controlContract, url, options);
}

function derivedClient<C extends AnyContractRouter>(
	contract: C,
	url: URL,
	options: TenantRpcOptions
): JsonifiedClient<ContractRouterClient<C>> {
	const { credential, signal, fetcher = fetch } = options;

	const link = new OpenAPILink(contract, {
		url,
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
		plugins: [new ResponseValidationPlugin(contract)]
	});

	return createORPCClient(link);
}
