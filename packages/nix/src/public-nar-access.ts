import { discardResponseBody, withCleanup } from '@cupboard/shared/cleanup';
import { fetch as undiciFetch, type Response } from 'undici';

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
		const response = await (options.fetch ?? undiciFetch)(url, {
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
