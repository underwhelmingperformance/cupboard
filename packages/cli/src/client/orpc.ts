import { controlContract, tenantContract } from '@cupboard/protocol/contract';
import {
	backoffDelay,
	isTransientResponse,
	maxTransientRetries,
	transientResponseDelay
} from '@cupboard/shared/retry';
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

import { type AccessCredential, bearerAttempt } from './credentials.ts';
import { reachableFetcher } from './transport.ts';

export type TenantRpc = JsonifiedClient<
	ContractRouterClient<typeof tenantContract>
>;

export interface TenantRpcOptions {
	readonly credential?: AccessCredential;
	readonly signal?: AbortSignal;
	readonly fetcher?: typeof fetch;
}

const unauthorizedStatusCode = 401;

export type ControlRpc = JsonifiedClient<
	ContractRouterClient<typeof controlContract>
>;

/**
 * Creates a tenant admin client from the protocol contract and validates each
 * successful response against the procedure's output schema. The client
 * preserves a tenant path prefix in the base URL. After a 401, it refreshes a
 * provider-backed credential once and retries the request.
 */
export function tenantRpc(
	baseUrl: URL,
	options: TenantRpcOptions = {}
): TenantRpc {
	return derivedClient(tenantContract, new URL(baseUrl), options);
}

/**
 * Creates a control-plane client from the protocol contract and validates each
 * successful response against the procedure's output schema. The client appends
 * `/control` to the deployment's bare URL.
 */
export function controlRpc(
	baseUrl: URL,
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
	const reachable = reachableFetcher(fetcher);

	const link = new OpenAPILink(contract, {
		url,
		headers: () => {
			// The credential fetch is the first thing every admin command does;
			// honour an abort here so Ctrl-C is prompt.
			throwIfAborted(signal);

			return {};
		},
		// Each attempt clones the buffered JSON request. A 401 refreshes the bearer
		// once. A rejected fetch or a 429, 502, 503 or 504 response uses the shared
		// transient retry budget.
		fetch: async (request, init) => {
			const requestHeaders = Object.fromEntries(request.headers.entries());
			let attempt = await bearerAttempt(credential, requestHeaders);
			let current = new Request(request, { headers: attempt.headers });
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

				if (response.status === unauthorizedStatusCode) {
					const refreshed = await attempt.refreshAfterAuthenticationFailure();

					if (refreshed !== undefined) {
						attempt = refreshed;
						current = new Request(current, { headers: attempt.headers });
						continue;
					}
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

// Leave 503 and 507 responses for oRPC to decode. Of these statuses,
// `translateRpcError` converts only 507 to a CLI quota error; 503 remains an
// ORPCError so callers can inspect its code and data.
const typedServerErrorStatuses = new Set<number>([
	StatusCodes.SERVICE_UNAVAILABLE,
	StatusCodes.INSUFFICIENT_STORAGE
]);

/**
 * For an unmapped 5xx response, throws {@link CupboardHttpError} with the
 * decoded oRPC message or raw response body and the `cf-ray` header when
 * present. Contract-declared 503 and 507 responses pass through for oRPC to
 * decode.
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

// Use the decoded message when the body is an oRPC error envelope. Otherwise
// preserve the trimmed response text without attributing its source.
async function serverErrorDetail(response: Response): Promise<string> {
	const body = await response.text();

	try {
		const json: unknown = JSON.parse(body);

		if (isORPCErrorJson(json)) {
			return createORPCErrorFromJson(json).message;
		}
	} catch {
		// Preserve non-JSON response text below.
	}

	return body.trim();
}
