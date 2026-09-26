import { controlContract, tenantContract } from '@cupboard/protocol/contract';
import { type AuthzMeta } from '@cupboard/protocol/contract';
import { bestEffort, discardResponseBody } from '@cupboard/shared/cleanup';
import {
	BoundedBodyCollector,
	RemoteBodyTooLargeError,
	responseWithBufferedBoundedBody
} from '@cupboard/shared/response-body';
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
import { CupboardHttpError, QuotaExceededError } from '../errors.ts';

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
const maximumErrorBodyBytes = 64 * 1024;
const errorBodyPreviewBytes = 4 * 1024;

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

				return await checkResponse(current, response);
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
const insufficientStorageStatus: number = StatusCodes.INSUFFICIENT_STORAGE;

// Leave a 503 or 507 with a decodable body for oRPC to decode, so callers can
// inspect its oRPC code and data.
const typedServerErrorStatuses = new Set<number>([
	StatusCodes.SERVICE_UNAVAILABLE,
	StatusCodes.INSUFFICIENT_STORAGE
]);

/**
 * Checks an error response before oRPC decodes it, so that the error keeps the
 * response's HTTP status. `fetch` follows redirects, so every response that is
 * not a 2xx has an error status. {@link statusError} turns a 507 into a
 * {@link QuotaExceededError}.
 */
async function checkResponse(
	request: Request,
	response: Response
): Promise<Response> {
	if (response.ok) {
		return response;
	}

	const buffered = await bufferedErrorResponse(request, response);

	if (
		buffered.status < serverErrorThreshold ||
		typedServerErrorStatuses.has(buffered.status)
	) {
		return await checkErrorBody(request, buffered);
	}

	throw statusError(request, buffered, await serverErrorDetail(buffered));
}

async function bufferedErrorResponse(
	request: Request,
	response: Response
): Promise<Response> {
	// A clone shares its source stream with the original. Cancelling one of
	// the two bodies finishes only when the other body is also cancelled or
	// the source closes. The bounded read waits for its cancellation of the
	// original when the body is over the limit, so cancel the clone first.
	const preview = await bodyPreview(response.clone());

	try {
		return await responseWithBufferedBoundedBody(response, {
			description: 'Cupboard error response',
			maximumBytes: maximumErrorBodyBytes,
			signal: request.signal
		});
	} catch (error) {
		if (!(error instanceof RemoteBodyTooLargeError)) {
			throw error;
		}

		const detail = response.status === insufficientStorageStatus ? '' : preview;

		throw statusError(request, response, detail, { cause: error });
	}
}

async function bodyPreview(response: Response): Promise<string> {
	if (response.body === null) {
		return '';
	}

	const reader = response.body.getReader();
	const collector = new BoundedBodyCollector(errorBodyPreviewBytes, 'truncate');

	try {
		for (;;) {
			const chunk = await reader.read();

			if (chunk.done || !collector.append(chunk.value)) {
				return previewText(collector);
			}
		}
	} catch {
		// The clone fails with the same error as the original, and the bounded
		// read of the original reports it.
		return '';
	} finally {
		// The cancellation finishes only after the bounded read has read or
		// cancelled the original, which happens after this function returns.
		void bestEffort(() => reader.cancel());
	}
}

function textPreview(text: string): string {
	const collector = new BoundedBodyCollector(errorBodyPreviewBytes, 'truncate');

	collector.append(new TextEncoder().encode(text));

	return previewText(collector);
}

// Decode with `stream: true` so that a multi-byte character cut by the byte
// limit is left out instead of becoming U+FFFD.
function previewText(collector: BoundedBodyCollector): string {
	const text = new TextDecoder().decode(collector.bytes(), { stream: true });

	return (
		collector.truncated ? `${text}\n[response body truncated]` : text
	).trim();
}

// When JSON decoding fails, the error that oRPC throws does not include the
// HTTP status, so check an error body before passing it to oRPC. The checks
// below match the JSON branch of `toStandardBody` in
// `@orpc/standard-server-fetch` and `parseEmptyableJSON` in `@orpc/shared`:
// oRPC reads a body with a `content-disposition` header as a file, parses a
// body with a missing, empty or application/json content type, and treats only
// an empty string as no body. When upgrading oRPC, check that these functions
// still behave this way.
async function checkErrorBody(
	request: Request,
	response: Response
): Promise<Response> {
	const contentType = response.headers.get('content-type');

	const body = await response.clone().text();

	if (
		response.headers.has('content-disposition') ||
		(contentType !== null &&
			contentType !== '' &&
			!contentType.startsWith('application/json'))
	) {
		return response;
	}

	if (body === '') {
		return response;
	}

	try {
		JSON.parse(body);
		return response;
	} catch {
		// Report the HTTP status, which oRPC's error would not include.
	}

	throw statusError(request, response, textPreview(body));
}

function statusError(
	request: Request,
	response: Response,
	detail: string,
	options?: ErrorOptions
): QuotaExceededError | CupboardHttpError {
	if (response.status === insufficientStorageStatus) {
		return new QuotaExceededError(detail, options);
	}

	return new CupboardHttpError(
		request.method,
		new URL(request.url).pathname,
		response.status,
		detail,
		response.headers.get('cf-ray') ?? undefined,
		options
	);
}

// Use the decoded message when the body is an oRPC error envelope. Otherwise
// preserve the start of the response text without attributing its source.
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

	return textPreview(body);
}
