import { fetch as undiciFetch, Headers, Response } from 'undici';
import { describe, expect, it } from 'vitest';

import {
	PublicNarAccessError,
	verifyPublicNarAccess
} from './public-nar-access.ts';

const archive = new URL('https://cache.example/nar/app.nar.xz');

describe('verifyPublicNarAccess', () => {
	it.each([
		{
			description: 'a refused GET',
			status: 403,
			body: new Uint8Array([1]),
			headers: {}
		},
		{
			description: 'an empty response',
			status: 200,
			body: new Uint8Array(),
			headers: {}
		},
		{
			description: 'a login page',
			status: 200,
			body: '<html>Sign in</html>',
			headers: { 'content-type': 'text/html' }
		},
		{
			description: 'a provider error document',
			status: 200,
			body: '<Error>Denied</Error>',
			headers: { 'content-type': 'Application/XML; charset=utf-8' }
		},
		{
			description: 'a missing range',
			status: 206,
			body: new Uint8Array([1]),
			headers: {}
		},
		{
			description: 'a different archive length',
			status: 206,
			body: new Uint8Array([1]),
			headers: { 'content-range': 'bytes 0-0/401' }
		},
		{
			description: 'a contradictory full archive length',
			status: 200,
			body: new Uint8Array([1]),
			headers: { 'content-length': '1' }
		},
		{
			description: 'a malformed full archive length',
			status: 200,
			body: new Uint8Array([1]),
			headers: { 'content-length': 'invalid' }
		},
		{
			description: 'an unsafe full archive length',
			status: 200,
			body: new Uint8Array([1]),
			headers: { 'content-length': '9007199254740992' }
		},
		{
			description: 'an empty declared archive',
			status: 200,
			body: new Uint8Array([1]),
			headers: { 'content-length': '0' }
		},
		{
			description: 'a contradictory partial length',
			status: 206,
			body: new Uint8Array([1]),
			headers: { 'content-length': '2', 'content-range': 'bytes 0-0/400' }
		},
		{
			description: 'a malformed partial length',
			status: 206,
			body: new Uint8Array([1]),
			headers: { 'content-length': 'invalid', 'content-range': 'bytes 0-0/400' }
		},
		{
			description: 'an oversized partial response',
			status: 206,
			body: new Uint8Array([1, 2]),
			headers: { 'content-range': 'bytes 0-0/400' }
		}
	])('rejects $description', async ({ status, body, headers }) => {
		const fetcher: typeof undiciFetch = () =>
			Promise.resolve(new Response(body, { status, headers }));
		await expect(
			verifyPublicNarAccess(archive, 400, {
				fetch: fetcher,
				signal: new AbortController().signal
			})
		).rejects.toThrow(PublicNarAccessError);
	});

	it.each([
		{ status: 200, downloadSize: 400, contentLength: '400', bodySize: 400 },
		{ status: 200, downloadSize: 0, contentLength: '1', bodySize: 1 },
		{ status: 200, downloadSize: 400, contentLength: undefined, bodySize: 400 },
		{ status: 206, downloadSize: 400, contentLength: '1', bodySize: 1 }
	])(
		'accepts valid length headers for status $status and size $downloadSize',
		async ({ status, downloadSize, contentLength, bodySize }) => {
			const headers = new Headers();
			if (contentLength !== undefined) {
				headers.set('content-length', contentLength);
			}
			if (status === 206) {
				headers.set('content-range', 'bytes 0-0/400');
			}
			const fetcher: typeof undiciFetch = () =>
				Promise.resolve(
					new Response(new Uint8Array(bodySize), { status, headers })
				);
			await expect(
				verifyPublicNarAccess(archive, downloadSize, {
					fetch: fetcher,
					signal: new AbortController().signal
				})
			).resolves.toBeUndefined();
		}
	);

	it.each([
		'http://127.0.0.1/nar/app',
		'http://10.0.0.1/nar/app',
		'https://runner:secret@private.example/nar/app'
	])('refuses redirect to %s before requesting it', async (destination) => {
		const requested: string[] = [];
		const fetcher: typeof undiciFetch = (input) => {
			requested.push(requestUrl(input).href);
			return Promise.resolve(
				new Response(undefined, {
					status: 302,
					headers: { location: destination }
				})
			);
		};
		await expect(
			verifyPublicNarAccess(archive, 400, {
				fetch: fetcher,
				signal: new AbortController().signal
			})
		).rejects.toThrow(PublicNarAccessError);
		expect(requested).toStrictEqual([archive.href]);
	});

	it('follows a public CDN redirect with an anonymous range GET', async () => {
		const requested: {
			url: string;
			authorization: string | undefined;
			range: string | undefined;
		}[] = [];
		const fetcher: typeof undiciFetch = (input, init) => {
			const url = requestUrl(input).href;
			const headers = new Headers(init?.headers);
			requested.push({
				url,
				authorization: headers.get('authorization') ?? undefined,
				range: headers.get('range') ?? undefined
			});
			const response =
				url === archive.href
					? new Response(undefined, {
							status: 302,
							headers: { location: 'https://cdn.example/app.nar.xz' }
						})
					: new Response(new Uint8Array([1]), {
							status: 206,
							headers: { 'content-range': 'bytes 0-0/400' }
						});
			return Promise.resolve(response);
		};
		await verifyPublicNarAccess(archive, 400, {
			fetch: fetcher,
			signal: new AbortController().signal
		});
		expect(requested).toStrictEqual([
			{ url: archive.href, authorization: undefined, range: 'bytes=0-0' },
			{
				url: 'https://cdn.example/app.nar.xz',
				authorization: undefined,
				range: 'bytes=0-0'
			}
		]);
	});

	it('preserves cancellation and cancels the response stream', async () => {
		const controller = new AbortController();
		const reason = new Error('cancel consumer probe');
		let isCancelled = false;
		const stream = new ReadableStream({
			type: 'bytes',
			pull(streamController) {
				controller.abort(reason);
				streamController.enqueue(new Uint8Array([1]));
			},
			cancel() {
				isCancelled = true;
			}
		});
		const fetcher: typeof undiciFetch = () =>
			Promise.resolve(new Response(stream));
		await expect(
			verifyPublicNarAccess(archive, 400, {
				fetch: fetcher,
				signal: controller.signal
			})
		).rejects.toBe(reason);
		expect(isCancelled).toBe(true);
	});
});

function requestUrl(input: Parameters<typeof undiciFetch>[0]): URL {
	if (typeof input === 'string' || input instanceof URL) {
		return new URL(input);
	}
	return new URL(input.url);
}
