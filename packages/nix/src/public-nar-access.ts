import { discardResponseBody, withCleanup } from '@cupboard/shared/cleanup';
import type { fetch as undiciFetch, Response } from 'undici';

import { keepAliveUndiciFetch } from './keep-alive-undici-fetch.ts';
import { NixStoreError } from './nix-store.ts';
import { isReachableElsewhere } from './substituter-reach.ts';

export class PublicNarAccessError extends NixStoreError {
	constructor(
		readonly status?: number,
		options?: ErrorOptions
	) {
		super('Could not verify anonymous access to the advertised NAR', options);
		this.name = 'PublicNarAccessError';
	}
}

interface PublicFetchOptions {
	readonly fetch?: typeof undiciFetch;
	readonly signal: AbortSignal;
	readonly headers?: Readonly<Record<string, string>>;
}

export async function fetchPublicObject(
	requested: URL,
	options: PublicFetchOptions
): Promise<Response> {
	let url = requested;
	for (let redirects = 0; redirects <= 5; redirects += 1) {
		options.signal.throwIfAborted();
		if (
			!isReachableElsewhere(url.href) ||
			url.username !== '' ||
			url.password !== ''
		) {
			throw new PublicNarAccessError();
		}
		const response = await (options.fetch ?? keepAliveUndiciFetch)(url, {
			redirect: 'manual',
			signal: options.signal,
			headers: options.headers
		});
		if (![301, 302, 303, 307, 308].includes(response.status)) {
			return response;
		}
		await discardResponseBody(response);
		const location = response.headers.get('location');
		if (location === null) {
			throw new PublicNarAccessError(response.status);
		}
		url = new URL(location, url);
	}
	throw new PublicNarAccessError();
}

/**
The answer to an anonymous request for an object:

- `public`: a status from 200 to 299 with a body that is not an HTML page.
- `private`: a definite refusal. That is 401, 403, 404, 410 or 451, an HTML
  page such as a sign-in form, or a URL or redirect that `fetchPublicObject`
  refuses to request. GitHub answers an anonymous request for a private
  repository with 404.
- `unavailable`: a 403 that reports a rate limit with `x-ratelimit-remaining:
  0` or `retry-after`, any other status, or a failed request. A later request
  can get a definite answer.
*/
export type PublicObjectAccess = 'public' | 'private' | 'unavailable';

const refusalStatuses = new Set([401, 403, 404, 410, 451]);

/**
Sends an anonymous GET for the URL and classifies the answer. The request has
no credentials, and `fetchPublicObject` follows redirects only to public
hosts. An abort of `options.signal` rejects with its reason.
*/
export async function probePublicObject(
	url: URL,
	options: PublicFetchOptions
): Promise<PublicObjectAccess> {
	let response: Response;

	try {
		response = await fetchPublicObject(url, options);
	} catch (error) {
		options.signal.throwIfAborted();

		return error instanceof PublicNarAccessError ? 'private' : 'unavailable';
	}

	await discardResponseBody(response);

	if (response.ok) {
		return isHtml(response) ? 'private' : 'public';
	}

	if (isRateLimited(response)) {
		return 'unavailable';
	}

	return refusalStatuses.has(response.status) ? 'private' : 'unavailable';
}

// GitHub answers an exhausted primary rate limit with 403 and
// `x-ratelimit-remaining: 0`, and a secondary rate limit with 403 or 429 and
// `retry-after`.
function isRateLimited(response: Response): boolean {
	return (
		response.headers.get('x-ratelimit-remaining') === '0' ||
		response.headers.has('retry-after')
	);
}

function isHtml(response: Response): boolean {
	const mediaType = response.headers
		.get('content-type')
		?.split(';', 1)[0]
		?.trim()
		.toLowerCase();

	return mediaType === 'text/html';
}

async function probePublicNarAccess(
	url: URL,
	downloadSize: number,
	options: PublicFetchOptions
): Promise<void> {
	const response = await fetchPublicObject(url, {
		...options,
		headers: { range: 'bytes=0-0', 'accept-encoding': 'identity' }
	});
	return withCleanup(
		async () => {
			options.signal.throwIfAborted();
			if (response.status !== 200 && response.status !== 206) {
				throw new PublicNarAccessError(response.status);
			}
			const contentType = response.headers
				.get('content-type')
				?.split(';', 1)[0]
				?.trim()
				.toLowerCase();
			if (
				contentType === 'application/json' ||
				contentType === 'application/xml' ||
				contentType?.startsWith('text/') ||
				contentType?.endsWith('+json') ||
				contentType?.endsWith('+xml')
			) {
				throw new PublicNarAccessError(response.status);
			}
			if (response.status === 206) {
				const range = /^bytes 0-0\/(\d+)$/.exec(
					response.headers.get('content-range') ?? ''
				);
				if (
					range === null ||
					!Number.isSafeInteger(Number(range[1])) ||
					Number(range[1]) < 1 ||
					(downloadSize > 0 && Number(range[1]) !== downloadSize)
				) {
					throw new PublicNarAccessError(response.status);
				}
			}
			const contentLength = response.headers.get('content-length');
			if (contentLength !== null) {
				const length = Number(contentLength);
				const expectedLength = response.status === 206 ? 1 : downloadSize;
				if (
					!/^\d+$/.test(contentLength) ||
					!Number.isSafeInteger(length) ||
					length < 1 ||
					(length !== expectedLength && expectedLength > 0)
				) {
					throw new PublicNarAccessError(response.status);
				}
			}
			const body = response.body;
			if (body === null) {
				throw new PublicNarAccessError(response.status);
			}
			const reader = body.getReader({ mode: 'byob' });
			await withCleanup(
				async () => {
					const first = await reader.read(new Uint8Array(1));
					options.signal.throwIfAborted();
					if (
						first.done ||
						!(first.value instanceof Uint8Array) ||
						first.value.byteLength === 0
					) {
						throw new PublicNarAccessError(response.status);
					}
					if (response.status !== 206) {
						return;
					}
					const end = await reader.read(new Uint8Array(1));
					options.signal.throwIfAborted();
					if (!end.done) {
						throw new PublicNarAccessError(response.status);
					}
				},
				async () => {
					try {
						await reader.cancel();
					} finally {
						reader.releaseLock();
					}
				}
			);
		},
		() => discardResponseBody(response)
	);
}

export async function verifyPublicNarAccess(
	url: URL,
	downloadSize: number,
	options: PublicFetchOptions
): Promise<void> {
	try {
		await probePublicNarAccess(url, downloadSize, options);
	} catch (error) {
		options.signal.throwIfAborted();
		if (error instanceof PublicNarAccessError) {
			throw error;
		}
		throw new PublicNarAccessError(undefined, { cause: error });
	}
}
