import { controlContract, tenantContract } from '@cupboard/protocol/contract';
import {
	createORPCClient,
	createORPCErrorFromJson,
	isORPCErrorJson
} from '@orpc/client';
import type { AnyContractRouter, ContractRouterClient } from '@orpc/contract';
import { ResponseValidationPlugin } from '@orpc/contract/plugins';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { StatusCodes } from 'http-status-codes';

import { throwIfAborted } from '../abort.ts';
import { CupboardHttpError } from '../errors.ts';

import {
	type AccessCredential,
	bearerHeaders,
	isTokenProvider,
	resolveBearer
} from './credentials.ts';
import {
	backoffDelay,
	isTransientResponse,
	maxTransientRetries,
	transientResponseDelay
} from './retry.ts';
import { parseWorkerUrl, reachableFetcher } from './transport.ts';

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
	return derivedClient(tenantContract, parseWorkerUrl(baseUrl), options);
}

/**
 * Builds the derived control client against the deployment's bare host; the
 * contract's procedures live under its `/control` prefix.
 */
export function controlRpc(
	baseUrl: string | URL,
	options: TenantRpcOptions = {}
): ControlRpc {
	const url = parseWorkerUrl(baseUrl);
	url.pathname = `${url.pathname.replace(/\/$/, '')}/control`;

	return derivedClient(controlContract, url, options);
}

function derivedClient<C extends AnyContractRouter>(
	contract: C,
	url: URL,
	options: TenantRpcOptions
): JsonifiedClient<ContractRouterClient<C>> {
	const { credential, signal, fetcher = fetch } = options;
	const reachable = reachableFetcher(fetcher);

	const link = new OpenAPILink(contract, {
		url,
		headers: async () => {
			// The credential fetch is the first thing every admin command does;
			// honour an abort here so Ctrl-C is prompt.
			throwIfAborted(signal);

			return bearerHeaders(await resolveBearer(credential));
		},
		// Bodies are buffered JSON, so cloning the request per attempt is cheap. A
		// 401 refreshes the bearer once; a transient failure (a network fault or a
		// gateway/overload status: 429, 502, 503, 504) backs off and retries, so a
		// single Durable Object blip does not fail a long push of negotiate and
		// commit calls. The contract's procedures are idempotent or self-healing
		// under a repeat (a re-negotiate's unused rows are reaped), so a retried
		// call is safe.
		fetch: async (request, init) => {
			let current = request;
			let isBearerRefreshed = false;
			let retries = 0;

			for (;;) {
				throwIfAborted(signal);

				let response: Response;
				try {
					response = await reachable(current.clone(), { ...init, signal });
				} catch (error) {
					if (signal?.aborted === true || retries >= maxTransientRetries) {
						throw error;
					}

					retries += 1;
					await backoffDelay(retries, signal);
					continue;
				}

				if (
					response.status === unauthorizedStatusCode &&
					isTokenProvider(credential) &&
					!isBearerRefreshed
				) {
					isBearerRefreshed = true;
					const headers = new Headers(current.headers);
					headers.set('authorization', `Bearer ${await credential.refresh()}`);
					current = new Request(current, { headers });
					continue;
				}

				if (isTransientResponse(response) && retries < maxTransientRetries) {
					retries += 1;
					await transientResponseDelay(response, retries, signal);
					continue;
				}

				return await settleServerError(current, response);
			}
		},
		plugins: [new ResponseValidationPlugin(contract)]
	});

	return createORPCClient(link);
}

const serverErrorThreshold: number = StatusCodes.INTERNAL_SERVER_ERROR;

// The 5xx statuses the contract maps to typed errors the CLI acts on; they are
// left for oRPC to decode so `translateRpcError` can turn them into their
// actionable forms (an over-quota write, a deployment in maintenance).
const typedServerErrorStatuses = new Set<number>([
	StatusCodes.SERVICE_UNAVAILABLE,
	StatusCodes.INSUFFICIENT_STORAGE
]);

/**
 * Turns an unmapped server failure into a {@link CupboardHttpError} carrying the
 * request, status and Cloudflare ray id, so a bare `500 Internal server error`
 * arrives with the handle that ties it to its server log line. Statuses the
 * contract maps to typed errors pass through
 * unchanged for oRPC to decode.
 */
async function settleServerError(
	request: Request,
	response: Response
): Promise<Response> {
	if (
		response.status < serverErrorThreshold ||
		typedServerErrorStatuses.has(response.status)
	) {
		return response;
	}

	throw new CupboardHttpError(
		request.method,
		new URL(request.url).pathname,
		response.status,
		await serverErrorDetail(response),
		response.headers.get('cf-ray') ?? undefined
	);
}

// A worker 5xx is an oRPC error envelope; let oRPC decode it so the message is
// the one it would have surfaced. A raw gateway 5xx is not, so keep its body.
async function serverErrorDetail(response: Response): Promise<string> {
	const body = await response.text();

	try {
		const json: unknown = JSON.parse(body);

		if (isORPCErrorJson(json)) {
			return createORPCErrorFromJson(json).message;
		}
	} catch {
		// Not JSON; fall back to the raw body below.
	}

	return body.trim();
}
