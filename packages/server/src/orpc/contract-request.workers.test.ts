import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { RequestBodyTooLargeError, UnauthenticatedError } from '../errors.ts';
import {
	adminGrants,
	controlWorkerFetch,
	currentOrigin,
	currentServer,
	issueControlAdminToken,
	issueServerSignedToken,
	resetTestServer
} from '../test-support.ts';

import {
	ContractRequest,
	contractRequestMaxBytes
} from './contract-request.ts';

const encoder = new TextEncoder();

interface Surface {
	readonly name: string;
	readonly send: (init: RequestInit) => Promise<Response>;
	readonly token: () => Promise<string>;
}

const surfaces: readonly Surface[] = [
	{
		name: 'a tenant procedure',
		send: (init) =>
			currentServer().fetch(new Request(`${currentOrigin()}/oidc-trust`, init)),
		token: () => issueServerSignedToken(adminGrants())
	},
	{
		name: 'a control procedure',
		send: (init) =>
			controlWorkerFetch(
				new Request(`${currentOrigin()}/control/oidc-trust`, init)
			),
		token: () => issueControlAdminToken()
	}
];

const oversizeText = '{}'.padEnd(contractRequestMaxBytes + 1, ' ');

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			controller.close();
		}
	});
}

interface RecordedBody {
	readonly stream: ReadableStream<Uint8Array>;
	readonly pulls: () => number;
	readonly isCancelled: () => boolean;
}

// A body of `chunks` chunks of `chunkBytes` spaces. It records how often its
// reader pulled and whether the reader cancelled it. A high-water mark of 0
// stops the stream pulling before anything reads it.
function recordedBody(chunkBytes: number, chunks: number): RecordedBody {
	let pulls = 0;
	let isCancelled = false;

	return {
		pulls: () => pulls,
		isCancelled: () => isCancelled,
		stream: new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					controller.enqueue(encoder.encode(' '.repeat(chunkBytes)));
					pulls += 1;

					if (pulls === chunks) {
						controller.close();
					}
				},
				cancel() {
					isCancelled = true;
				}
			},
			{ highWaterMark: 0 }
		)
	};
}

function postRequest(
	body: ReadableStream<Uint8Array> | string,
	headers: Readonly<Record<string, string>> = {}
): Request {
	return new Request('https://cupboard.test/oidc-trust', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body
	});
}

const limit = 1024;
const authenticated = (): Promise<unknown> => Promise.resolve({});
const unauthenticated = (): Promise<unknown> =>
	Promise.reject(new UnauthenticatedError());

function refusalOf(contract: ContractRequest): unknown {
	try {
		contract.refuseOversizeBody();
	} catch (error) {
		return error;
	}

	return undefined;
}

describe('ContractRequest', () => {
	it('reads the body after authentication succeeds', async () => {
		const contract = new ContractRequest(
			postRequest('{"name":"a"}'),
			authenticated,
			limit
		);

		expect({
			body: await contract.request.text(),
			refusal: refusalOf(contract)
		}).toStrictEqual({ body: '{"name":"a"}', refusal: undefined });
	});

	it('leaves the original body unread when authentication fails', async () => {
		const body = recordedBody(8, 1);
		const original = postRequest(body.stream);
		const contract = new ContractRequest(original, unauthenticated, limit);
		const copied = await contract.request.text();

		expect({
			copied,
			pulls: body.pulls(),
			isOriginalBodyUsed: original.bodyUsed
		}).toStrictEqual({ copied: '', pulls: 0, isOriginalBodyUsed: false });
	});

	it('leaves the original body unread until the copy is read', async () => {
		let authentications = 0;
		const original = postRequest('{"name":"a"}');
		new ContractRequest(
			original,
			() => {
				authentications += 1;
				return Promise.resolve({});
			},
			limit
		);

		expect({
			body: await original.text(),
			authentications
		}).toStrictEqual({ body: '{"name":"a"}', authentications: 0 });
	});

	it.each<{
		readonly name: string;
		readonly headers: Readonly<Record<string, string>>;
		readonly chunkBytes: number;
		readonly chunks: number;
		readonly pulls: number;
	}>([
		{
			name: 'Content-Length',
			headers: { 'content-length': String(limit + 1) },
			chunkBytes: 1,
			chunks: 1,
			pulls: 0
		},
		{
			name: 'the streamed body',
			headers: {},
			chunkBytes: limit / 2,
			chunks: 4,
			pulls: 3
		}
	])(
		'refuses the body when $name exceeds the limit',
		async ({ headers, chunkBytes, chunks, pulls }) => {
			const body = recordedBody(chunkBytes, chunks);
			const contract = new ContractRequest(
				postRequest(body.stream, headers),
				authenticated,
				limit
			);
			await expect(contract.request.text()).rejects.toThrow();

			expect({
				refusal: refusalOf(contract),
				pulls: body.pulls(),
				isCancelled: body.isCancelled()
			}).toStrictEqual({
				refusal: new RequestBodyTooLargeError(limit),
				pulls,
				isCancelled: true
			});
		}
	);
});

describe('admin API request bodies', () => {
	beforeEach(resetTestServer);

	it.each(
		surfaces.flatMap((surface) => [
			{ ...surface, delivery: 'declared', body: () => oversizeText },
			{ ...surface, delivery: 'streamed', body: () => streamOf(oversizeText) }
		])
	)(
		'refuses a $delivery body over the limit for $name',
		async ({ send, token, body }) => {
			const response = await send({
				method: 'POST',
				headers: {
					authorization: `Bearer ${await token()}`,
					'content-type': 'application/json'
				},
				body: body()
			});
			await response.body?.cancel();

			expect({
				status: response.status,
				contentType: response.headers.get('content-type')
			}).toStrictEqual({
				status: StatusCodes.REQUEST_TOO_LONG,
				contentType: 'text/plain;charset=UTF-8'
			});
		}
	);

	it.each(['/uploads', '/uploads/preview'])(
		'reads a body over the default limit at %s',
		async (path) => {
			const token = await issueServerSignedToken(adminGrants());
			const response = await currentServer().fetch(
				new Request(`${currentOrigin()}${path}`, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json'
					},
					body: oversizeText
				})
			);
			await response.body?.cancel();

			expect(response.status).toBe(StatusCodes.BAD_REQUEST);
		}
	);

	it.each(
		surfaces.flatMap((surface) => [
			{ ...surface, credential: 'no credential', headers: {} },
			{
				...surface,
				credential: 'an invalid credential',
				headers: { authorization: 'Bearer not-a-token' }
			}
		])
	)(
		'refuses $name with $credential before parsing a malformed body',
		async ({ send, headers }) => {
			const response = await send({
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body: '{'.padEnd(contractRequestMaxBytes + 1, ' ')
			});
			await response.body?.cancel();

			expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
		}
	);
});
