import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';

import { cloudflareAccountIdSchema } from './identifiers.ts';
import {
	accessKeyIdProblem,
	checkR2Credentials,
	r2AccessKeyIdSchema,
	r2SecretAccessKeySchema,
	secretAccessKeyProblem
} from './r2-credentials.ts';

const options = {
	accountId: cloudflareAccountIdSchema.parse('acc-hex'),
	bucketName: 'cupboard-blobs',
	credentials: {
		accessKeyId: r2AccessKeyIdSchema.parse('a'.repeat(32)),
		secretAccessKey: r2SecretAccessKeySchema.parse('b'.repeat(64))
	}
};

const initiateBody =
	'<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult>' +
	'<UploadId>UP-1</UploadId></InitiateMultipartUploadResult>';

function respondingWith(
	status: number,
	body?: string
): {
	fetcher: typeof fetch;
	requests: Request[];
} {
	const requests: Request[] = [];

	const fetcher: typeof fetch = (input, init) => {
		requests.push(new Request(input, init));

		return Promise.resolve(new Response(body, { status }));
	};

	return { fetcher, requests };
}

describe('checkR2Credentials', () => {
	it('accepts a begun multipart upload as proof of write access', async () => {
		const { fetcher } = respondingWith(200, initiateBody);

		expect(await checkR2Credentials(options, fetcher)).toStrictEqual({
			kind: 'valid'
		});
	});

	it.each([
		[
			'an absent upload id',
			'<InitiateMultipartUploadResult></InitiateMultipartUploadResult>'
		],
		[
			'duplicate upload ids',
			'<InitiateMultipartUploadResult><UploadId>UP-1</UploadId><UploadId>UP-2</UploadId></InitiateMultipartUploadResult>'
		],
		[
			'a truncated result',
			'<InitiateMultipartUploadResult><UploadId>UP-1</UploadId>'
		]
	])('rejects %s in a successful response', async (_name, body) => {
		const { fetcher, requests } = respondingWith(200, body);

		const result = await checkR2Credentials(options, fetcher);

		expect({
			kind: result.kind,
			causeName:
				result.kind === 'invalid-response' && result.cause instanceof Error
					? result.cause.name
					: undefined,
			requests: requests.map((request) => request.method)
		}).toStrictEqual({
			kind: 'invalid-response',
			causeName: 'R2CredentialResponseError',
			requests: ['POST']
		});
	});

	it.each([[401], [403], [404]])('reports a %i as rejected', async (status) => {
		const cancelled = vi.fn();
		const body = new ReadableStream({
			cancel: cancelled,
			start(controller) {
				controller.enqueue(new TextEncoder().encode('denied'));
			}
		});
		const fetcher: typeof fetch = () =>
			Promise.resolve(new Response(body, { status }));

		expect(await checkR2Credentials(options, fetcher)).toStrictEqual({
			kind: 'rejected',
			status
		});
		expect(cancelled).toHaveBeenCalledOnce();
	});

	it('begins then aborts a multipart upload against the bucket', async () => {
		const { fetcher, requests } = respondingWith(200, initiateBody);

		await checkR2Credentials(options, fetcher);

		expect(
			requests.map((request) => ({
				method: request.method,
				url: request.url,
				signed: request.headers
					.get('authorization')
					?.startsWith('AWS4-HMAC-SHA256 Credential=')
			}))
		).toStrictEqual([
			{
				method: 'POST',
				url: 'https://acc-hex.r2.cloudflarestorage.com/cupboard-blobs/.cupboard-credential-probe?uploads',
				signed: true
			},
			{
				method: 'DELETE',
				url: 'https://acc-hex.r2.cloudflarestorage.com/cupboard-blobs/.cupboard-credential-probe?uploadId=UP-1',
				signed: true
			}
		]);
	});

	it('reports a network failure as unreachable', async () => {
		const cause = new Error('offline');
		const fetcher: typeof fetch = () => Promise.reject(cause);

		const result = await checkR2Credentials(options, fetcher);

		expect({
			kind: result.kind,
			cause:
				result.kind === 'unreachable' && result.cause instanceof Error
					? { name: result.cause.name }
					: undefined
		}).toStrictEqual({
			kind: 'unreachable',
			cause: { name: 'Error' }
		});
	});

	it('passes the caller signal to the begin and cleanup requests', async () => {
		const controller = new AbortController();
		const signals: (AbortSignal | null | undefined)[] = [];
		const fetcher: typeof fetch = (_input, init) => {
			signals.push(init?.signal);

			return Promise.resolve(
				new Response(initiateBody, { status: StatusCodes.OK })
			);
		};

		await checkR2Credentials(
			{ ...options, signal: controller.signal },
			fetcher
		);

		expect(signals).toStrictEqual([controller.signal, controller.signal]);
	});

	it('propagates cancellation while beginning an upload', async () => {
		const controller = new AbortController();
		const reason = new Error('stop the deploy');
		const fetcher: typeof fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				if (init?.signal?.aborted === true) {
					reject(reason);
					return;
				}

				init?.signal?.addEventListener(
					'abort',
					() => {
						reject(reason);
					},
					{ once: true }
				);
			});
		const result = checkR2Credentials(
			{ ...options, signal: controller.signal },
			fetcher
		);

		controller.abort(reason);

		await expect(result).rejects.toBe(reason);
	});

	it('discards the cleanup response body', async () => {
		const cancelled = vi.fn();
		const cleanupBody = new ReadableStream({
			cancel: cancelled,
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
			}
		});
		let requestNumber = 0;
		const fetcher: typeof fetch = () => {
			requestNumber += 1;

			return Promise.resolve(
				requestNumber === 1
					? new Response(initiateBody, { status: StatusCodes.OK })
					: new Response(cleanupBody, { status: StatusCodes.OK })
			);
		};

		await checkR2Credentials(options, fetcher);

		expect(cancelled).toHaveBeenCalledOnce();
	});
});

describe('credential shape problems', () => {
	it.each([
		['a'.repeat(32), undefined],
		['A0'.repeat(16), undefined],
		['too-short', 'invalid-hex32']
	])('access key id %s -> %s', (value, problem) => {
		expect(accessKeyIdProblem(value)).toBe(problem);
	});

	it.each([
		['b'.repeat(64), undefined],
		['zz'.repeat(32), 'invalid-hex64']
	])('secret %s -> %s', (value, problem) => {
		expect(secretAccessKeyProblem(value)).toBe(problem);
	});
});
