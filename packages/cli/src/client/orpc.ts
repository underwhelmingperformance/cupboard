import { controlContract, tenantContract } from '@cupboard/protocol/contract';
import { type AuthzMeta } from '@cupboard/protocol/contract';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { readResponseText } from '@cupboard/shared/response-body';
import { type ReplaySafety, retryingFetcher } from '@cupboard/shared/retry';
import {
	createORPCClient,
	createORPCErrorFromJson,
	isORPCErrorJson
} from '@orpc/client';
import {
	type AnyContractRouter,
	type ContractRouterClient,
	isContractProcedure
} from '@orpc/contract';
import { ResponseValidationPlugin } from '@orpc/contract/plugins';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { StatusCodes } from 'http-status-codes';

import { throwIfAborted } from '../abort.ts';
import { CupboardHttpError } from '../errors.ts';

import {
	type AccessCredential,
	type BearerAttempt,
	bearerAttempt
} from './credentials.ts';
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
const maximumServerErrorBytes = 64 * 1024;

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
	const link = new OpenAPILink(contract, {
		url,
		headers: () => {
			// The credential fetch is the first thing every admin command does;
			// honour an abort here so Ctrl-C is prompt.
			throwIfAborted(signal);

			return {};
		},
		fetch: async (request, init, _options, path) => {
			const requestHeaders = Object.fromEntries(request.headers.entries());
			let attempt = await bearerAttempt(credential, requestHeaders);
			let canRefresh = typeof credential === 'object';
			let current = new Request(request, { headers: attempt.headers });
			const replaySafety = replaySafetyFor(contract, path);
			const transport = reachableFetcher(
				retryingFetcher(fetcher, replaySafety)
			);

			for (;;) {
				throwIfAborted(signal);
				const response = await transport(current.clone(), { ...init, signal });

				if (
					canRefresh &&
					replaySafety === 'replay-safe' &&
					response.status === unauthorizedStatusCode
				) {
					canRefresh = false;
					await discardResponseBody(response);
					const refreshed: BearerAttempt | undefined =
						await attempt.refreshAfterAuthenticationFailure();

					if (refreshed !== undefined) {
						attempt = refreshed;
						current = new Request(current, { headers: attempt.headers });
						continue;
					}
				}

				return await settleServerError(current, response);
			}
		},
		plugins: [new ResponseValidationPlugin(contract)]
	});

	return createORPCClient(link);
}

function replaySafetyFor(
	contract: AnyContractRouter,
	path: readonly string[]
): ReplaySafety {
	let procedure: unknown = contract;

	for (const segment of path) {
		if (typeof procedure !== 'object' || procedure === null) {
			return 'replay-unsafe';
		}

		procedure = (procedure as Readonly<Record<string, unknown>>)[segment];
	}

	if (!isContractProcedure(procedure)) {
		return 'replay-unsafe';
	}

	const metadata = procedure['~orpc'].meta as AuthzMeta;

	return metadata.replaySafety ?? 'replay-unsafe';
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
		await serverErrorDetail(response, request.signal),
		response.headers.get('cf-ray') ?? undefined
	);
}

// Use the decoded message when the body is an oRPC error envelope. Otherwise
// preserve the trimmed response text without attributing its source.
async function serverErrorDetail(
	response: Response,
	signal: AbortSignal
): Promise<string> {
	const body = await readResponseText(response, {
		description: 'Cupboard server error response',
		maximumBytes: maximumServerErrorBytes,
		signal
	});

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
