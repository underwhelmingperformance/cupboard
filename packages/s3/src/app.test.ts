import { AwsClient } from 'aws4fetch';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { createS3App } from './app.ts';
import {
	MissingContentLengthError,
	RequestNotSignedError,
	S3Error,
	UnsupportedOperationError
} from './errors.ts';
import { createPassthroughStore } from './passthrough.ts';
import type {
	CredentialResolver,
	GetObjectResult,
	ListObjectsQuery,
	ObjectContext,
	ObjectStore,
	PutObjectMeta,
	UploadedPart
} from './ports.ts';

const accessKeyId = 'AKIDTEST';
const secretAccessKey = 'super-secret-key';
const endpoint = 'https://s3.example.com';

const resolver: CredentialResolver = {
	resolve: (id) =>
		Promise.resolve(
			id === accessKeyId
				? {
						secretAccessKey,
						principal: {
							accessKeyId,
							tenant: 'acme',
							cache: 'default',
							grants: ['upload:commit']
						}
					}
				: undefined
		)
};

async function readAll(
	stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { done: isDone, value } = await reader.read();
		if (isDone) {
			break;
		}
		chunks.push(value);
	}

	return concat(chunks);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

function byteOrder(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function requireResult(result: GetObjectResult | undefined): GetObjectResult {
	if (result === undefined) {
		throw new Error('expected the object to exist');
	}
	return result;
}

interface StoredObject {
	bytes: Uint8Array;
	etag: string;
	contentType: string | undefined;
	lastModified: Date;
}

function keyOf(context: ObjectContext): string {
	return `${context.bucket}/${context.key}`;
}

/**
A minimal in-memory object store, standing in for a backing S3 service.
*/
function memoryStore(): ObjectStore {
	const objects = new Map<string, StoredObject>();
	const uploads = new Map<string, Map<number, Uint8Array>>();

	async function store(key: string, bytes: Uint8Array, contentType?: string) {
		const object: StoredObject = {
			bytes,
			etag: await sha256Hex(bytes),
			contentType,
			lastModified: new Date('2026-01-01T00:00:00.000Z')
		};
		objects.set(key, object);
		return object;
	}

	function statOf(object: StoredObject) {
		return {
			size: object.bytes.length,
			etag: object.etag,
			contentType: object.contentType,
			lastModified: object.lastModified
		};
	}

	return {
		stat: (context) => {
			const object = objects.get(keyOf(context));
			return Promise.resolve(object === undefined ? undefined : statOf(object));
		},

		get: (context, range) => {
			const object = objects.get(keyOf(context));
			if (object === undefined) {
				return Promise.resolve(undefined);
			}

			if (range === undefined) {
				return Promise.resolve({
					stat: statOf(object),
					body: streamOf(object.bytes)
				});
			}

			let start: number;
			let end: number;
			if ('suffix' in range) {
				start = object.bytes.length - range.suffix;
				end = object.bytes.length - 1;
			} else {
				start = range.offset;
				end =
					(range.length === undefined
						? object.bytes.length
						: range.offset + range.length) - 1;
			}

			return Promise.resolve({
				stat: statOf(object),
				body: streamOf(object.bytes.slice(start, end + 1)),
				range: { start, end }
			});
		},

		put: async (context, body, meta: PutObjectMeta) => {
			const object = await store(
				keyOf(context),
				await readAll(body),
				meta.contentType
			);
			return { etag: object.etag };
		},

		delete: (context) => {
			objects.delete(keyOf(context));
			return Promise.resolve();
		},

		list: (bucket, query: ListObjectsQuery) => {
			const prefixed = objects
				.keys()
				.filter((key) => key.startsWith(`${bucket}/`))
				.map((key) => key.slice(bucket.length + 1))
				.filter((key) => key.startsWith(query.prefix))
				.toArray()
				.toSorted(byteOrder);

			const commonPrefixes = new Set<string>();
			const keys: string[] = [];
			for (const key of prefixed) {
				const rest = key.slice(query.prefix.length);
				const index =
					query.delimiter === undefined ? -1 : rest.indexOf(query.delimiter);
				if (index !== -1 && query.delimiter !== undefined) {
					commonPrefixes.add(
						query.prefix + rest.slice(0, index + query.delimiter.length)
					);
					continue;
				}
				keys.push(key);
			}

			const token = query.continuationToken;
			const after =
				token === undefined ? keys : keys.filter((key) => key > token);
			const page = after.slice(0, query.maxKeys);
			const isTruncated = page.length < after.length;

			return Promise.resolve({
				objects: page.map((key) => {
					const object = objects.get(`${bucket}/${key}`);
					if (object === undefined) {
						throw new Error('listing referenced a missing object');
					}
					return {
						key,
						size: object.bytes.length,
						etag: object.etag,
						lastModified: object.lastModified
					};
				}),
				commonPrefixes: [...commonPrefixes],
				isTruncated,
				nextContinuationToken: isTruncated ? page.at(-1) : undefined
			});
		},

		bucketExists: () => Promise.resolve(true),

		createMultipartUpload: (context) => {
			const uploadId = `up-${String(uploads.size + 1)}`;
			uploads.set(`${keyOf(context)}#${uploadId}`, new Map());
			return Promise.resolve({ uploadId });
		},

		uploadPart: async (context, uploadId, partNumber, _contentLength, body) => {
			const parts = uploads.get(`${keyOf(context)}#${uploadId}`);
			if (parts === undefined) {
				throw new Error('no such upload');
			}
			const bytes = await readAll(body);
			parts.set(partNumber, bytes);
			return { partNumber, etag: await sha256Hex(bytes) };
		},

		completeMultipartUpload: async (
			context,
			uploadId,
			parts: readonly UploadedPart[]
		) => {
			const stored = uploads.get(`${keyOf(context)}#${uploadId}`);
			if (stored === undefined) {
				throw new Error('no such upload');
			}
			const ordered = parts
				.toSorted((left, right) => left.partNumber - right.partNumber)
				.map((part) => stored.get(part.partNumber) ?? new Uint8Array());
			uploads.delete(`${keyOf(context)}#${uploadId}`);
			const object = await store(keyOf(context), concat(ordered));
			return { etag: object.etag };
		},

		abortMultipartUpload: (context, uploadId) => {
			uploads.delete(`${keyOf(context)}#${uploadId}`);
			return Promise.resolve();
		}
	};
}

function appFetcher(store: ObjectStore): typeof fetch {
	const app = createS3App({ resolver, store, requestId: () => 'req-test' });
	return (input, init) =>
		Promise.resolve(
			app.fetch(input instanceof Request ? input : new Request(input, init))
		);
}

function signer(): AwsClient {
	return new AwsClient({
		accessKeyId,
		secretAccessKey,
		service: 's3',
		region: 'auto'
	});
}

describe('createS3App with a passthrough store', () => {
	it('round-trips put, stat, ranged get, list, multipart and delete', async () => {
		const store = memoryStore();
		const passthrough = createPassthroughStore({
			endpoint,
			accessKeyId,
			secretAccessKey,
			fetch: appFetcher(store)
		});

		const bytes = new TextEncoder().encode('hello cupboard');
		const put = await passthrough.put(
			{ bucket: 'acme', key: 'a.narinfo', principal: undefined },
			streamOf(bytes),
			{
				contentType: 'text/x-nix-narinfo',
				contentLength: bytes.length,
				checksumSha256: undefined
			}
		);
		expect(put.etag).toBe(await sha256Hex(bytes));

		const stat = await passthrough.stat({
			bucket: 'acme',
			key: 'a.narinfo',
			principal: undefined
		});
		expect(stat).toStrictEqual({
			size: bytes.length,
			etag: await sha256Hex(bytes),
			contentType: 'text/x-nix-narinfo',
			lastModified: new Date('2026-01-01T00:00:00.000Z')
		});

		const ranged = requireResult(
			await passthrough.get(
				{ bucket: 'acme', key: 'a.narinfo', principal: undefined },
				{ offset: 0, length: 5 }
			)
		);
		expect(ranged.range).toStrictEqual({ start: 0, end: 4 });
		expect(new TextDecoder().decode(await readAll(ranged.body))).toBe('hello');

		await passthrough.put(
			{ bucket: 'acme', key: 'nar/x.nar.zst', principal: undefined },
			streamOf(new TextEncoder().encode('nar')),
			{ contentType: undefined, contentLength: 3, checksumSha256: undefined }
		);

		const listing = await passthrough.list(
			'acme',
			{
				prefix: '',
				delimiter: '/',
				continuationToken: undefined,
				maxKeys: 1000
			},
			undefined
		);
		expect(listing.objects.map((object) => object.key)).toStrictEqual([
			'a.narinfo'
		]);
		expect(listing.commonPrefixes).toStrictEqual(['nar/']);

		const context = {
			bucket: 'acme',
			key: 'big.nar.zst',
			principal: undefined
		};
		const upload = await passthrough.createMultipartUpload(context, {
			contentType: undefined,
			contentLength: undefined,
			checksumSha256: undefined
		});
		const part1 = await passthrough.uploadPart(
			context,
			upload.uploadId,
			1,
			9,
			streamOf(new TextEncoder().encode('part-one-'))
		);
		const part2 = await passthrough.uploadPart(
			context,
			upload.uploadId,
			2,
			8,
			streamOf(new TextEncoder().encode('part-two'))
		);
		await passthrough.completeMultipartUpload(context, upload.uploadId, [
			part1,
			part2
		]);

		const assembled = requireResult(await passthrough.get(context, undefined));
		expect(new TextDecoder().decode(await readAll(assembled.body))).toBe(
			'part-one-part-two'
		);

		await passthrough.delete(context);
		expect(await passthrough.stat(context)).toBeUndefined();
	});
});

describe('createS3App direct protocol behaviour', () => {
	it('renders a missing decoded length as the S3 411 response', async () => {
		const response = new MissingContentLengthError().toResponse('request-1');

		expect({
			status: response.status,
			body: await response.text()
		}).toStrictEqual({
			status: StatusCodes.LENGTH_REQUIRED,
			body: '<?xml version="1.0" encoding="UTF-8"?><Error><Code>MissingContentLength</Code><Message>You must provide the Content-Length HTTP header.</Message><RequestId>request-1</RequestId></Error>'
		});
	});

	it('rejects a body that does not match its signed fixed digest', async () => {
		const fetcher = appFetcher(memoryStore());
		const expected = new TextEncoder().encode('expected');
		const altered = new TextEncoder().encode('altered');
		const response = await fetcher(
			await signer().sign('https://s3.example.com/acme/k', {
				method: 'PUT',
				headers: { 'x-amz-content-sha256': await sha256Hex(expected) },
				body: altered,
				aws: { service: 's3', region: 'auto' }
			})
		);

		expect(response.status).toBe(StatusCodes.FORBIDDEN);
		expect(await response.text()).toContain(
			'<Code>SignatureDoesNotMatch</Code>'
		);
	});

	it.each([
		{
			name: 'DeleteObject',
			url: 'https://s3.example.com/acme/k',
			method: 'DELETE'
		},
		{
			name: 'CreateMultipartUpload',
			url: 'https://s3.example.com/acme/k?uploads',
			method: 'POST'
		},
		{
			name: 'AbortMultipartUpload',
			url: 'https://s3.example.com/acme/k?uploadId=u',
			method: 'DELETE'
		}
	])(
		'rejects an altered fixed-digest body for $name',
		async ({ url, method }) => {
			const expected = new TextEncoder().encode('expected');
			const altered = new TextEncoder().encode('altered');
			const invocations: string[] = [];
			const base = memoryStore();
			const store: ObjectStore = {
				...base,
				delete: (context) => {
					invocations.push('DeleteObject');
					return base.delete(context);
				},
				createMultipartUpload: (context, meta) => {
					invocations.push('CreateMultipartUpload');
					return base.createMultipartUpload(context, meta);
				},
				abortMultipartUpload: (context, uploadId) => {
					invocations.push('AbortMultipartUpload');
					return base.abortMultipartUpload(context, uploadId);
				}
			};
			const response = await appFetcher(store)(
				await signer().sign(url, {
					method,
					headers: { 'x-amz-content-sha256': await sha256Hex(expected) },
					body: altered,
					aws: { service: 's3', region: 'auto' }
				})
			);

			expect({
				status: response.status,
				body: await response.text(),
				invocations
			}).toStrictEqual({
				status: StatusCodes.FORBIDDEN,
				body: '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code><Message>The request signature does not match.</Message><RequestId>req-test</RequestId></Error>',
				invocations: []
			});
		}
	);

	it('accepts a fixed digest while streaming the body to the store', async () => {
		const bytes = new TextEncoder().encode('payload');
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.subarray(0, 3));
				controller.enqueue(bytes.subarray(3));
				controller.close();
			}
		});
		const response = await appFetcher(memoryStore())(
			await signer().sign('https://s3.example.com/acme/k', {
				method: 'PUT',
				headers: { 'x-amz-content-sha256': await sha256Hex(bytes) },
				body,
				aws: { service: 's3', region: 'auto' }
			})
		);

		expect(response.status).toBe(StatusCodes.OK);
	});

	it('rejects signed aws-chunked payloads whose chunks are not verified', async () => {
		const response = await appFetcher(memoryStore())(
			await signer().sign('https://s3.example.com/acme/k', {
				method: 'PUT',
				headers: {
					'content-encoding': 'aws-chunked',
					'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
					'x-amz-decoded-content-length': '7'
				},
				body: '7;chunk-signature=altered\r\npayload\r\n0;chunk-signature=altered\r\n\r\n',
				aws: { service: 's3', region: 'auto' }
			})
		);

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
		expect(await response.text()).toContain('<Code>InvalidRequest</Code>');
	});

	it('rejects an unrecognised signed payload mode', async () => {
		const response = await appFetcher(memoryStore())(
			await signer().sign('https://s3.example.com/acme/k', {
				method: 'PUT',
				headers: { 'x-amz-content-sha256': 'not-a-payload-digest' },
				body: 'payload',
				aws: { service: 's3', region: 'auto' }
			})
		);

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
		expect(await response.text()).toContain('<Code>InvalidRequest</Code>');
	});

	it('accepts explicitly unsigned aws-chunked payloads', async () => {
		const store = memoryStore();
		const fetcher = appFetcher(store);
		const response = await fetcher(
			await signer().sign('https://s3.example.com/acme/k', {
				method: 'PUT',
				headers: {
					'content-encoding': 'aws-chunked',
					'x-amz-content-sha256': 'STREAMING-UNSIGNED-PAYLOAD-TRAILER',
					'x-amz-decoded-content-length': '7'
				},
				body: '7\r\npayload\r\n0\r\n\r\n',
				aws: { service: 's3', region: 'auto' }
			})
		);

		expect(response.status).toBe(StatusCodes.OK);
		const stored = requireResult(
			await store.get(
				{ bucket: 'acme', key: 'k', principal: undefined },
				undefined
			)
		);
		expect(new TextDecoder().decode(await readAll(stored.body))).toBe(
			'payload'
		);
	});

	it.each(['6', '8'])(
		'rejects an aws-chunked body that does not match decoded length %s',
		async (decodedLength) => {
			const response = await appFetcher(memoryStore())(
				await signer().sign('https://s3.example.com/acme/k', {
					method: 'PUT',
					headers: {
						'content-encoding': 'aws-chunked',
						'x-amz-content-sha256': 'STREAMING-UNSIGNED-PAYLOAD-TRAILER',
						'x-amz-decoded-content-length': decodedLength
					},
					body: '7\r\npayload\r\n0\r\n\r\n',
					aws: { service: 's3', region: 'auto' }
				})
			);

			expect(response.status).toBe(StatusCodes.BAD_REQUEST);
			expect(await response.text()).toContain('<Code>InvalidRequest</Code>');
		}
	);

	it.each([
		{
			name: 'a fixed-length body',
			headers: {
				'content-length': '7',
				'x-amz-content-sha256':
					'239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5'
			},
			body: 'payload'
		},
		{
			name: 'an unsigned aws-chunked body',
			headers: {
				'content-encoding': 'aws-chunked',
				'content-length': '17',
				'x-amz-content-sha256': 'STREAMING-UNSIGNED-PAYLOAD-TRAILER',
				'x-amz-decoded-content-length': '7'
			},
			body: '7\r\npayload\r\n0\r\n\r\n'
		}
	])(
		'passes the decoded length for $name to the store',
		async ({ headers, body }) => {
			let receivedLength: number | undefined;
			const base = memoryStore();
			const fetcher = appFetcher({
				...base,
				uploadPart: async (
					context,
					uploadId,
					partNumber,
					contentLength,
					stream
				) => {
					receivedLength = contentLength;

					return base.uploadPart(
						context,
						uploadId,
						partNumber,
						contentLength,
						stream
					);
				}
			});
			const initiated = await fetcher(
				await signer().sign('https://s3.example.com/acme/k?uploads', {
					method: 'POST',
					aws: { service: 's3', region: 'auto' }
				})
			);
			expect(initiated.status).toBe(StatusCodes.OK);
			const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(
				await initiated.text()
			)?.[1];
			if (uploadId === undefined) {
				throw new Error('initiate response omitted the upload id');
			}

			const response = await fetcher(
				await signer().sign(
					`https://s3.example.com/acme/k?partNumber=1&uploadId=${uploadId}`,
					{
						method: 'PUT',
						headers,
						body,
						aws: { service: 's3', region: 'auto' }
					}
				)
			);

			expect({ status: response.status, receivedLength }).toStrictEqual({
				status: StatusCodes.OK,
				receivedLength: 7
			});
		}
	);

	it('returns a 304 for a matching If-None-Match', async () => {
		const fetcher = appFetcher(memoryStore());
		const bytes = new TextEncoder().encode('body');
		const etag = `"${await sha256Hex(bytes)}"`;

		await fetcher(
			await signer().sign('https://s3.example.com/acme/k', {
				method: 'PUT',
				body: bytes,
				aws: { service: 's3', region: 'auto' }
			})
		);

		const conditional = await fetcher(
			await signer().sign('https://s3.example.com/acme/k', {
				method: 'GET',
				headers: { 'if-none-match': etag },
				aws: { service: 's3', region: 'auto' }
			})
		);
		expect(conditional.status).toBe(StatusCodes.NOT_MODIFIED);
	});

	it('answers NoSuchKey with an S3 error document', async () => {
		const fetcher = appFetcher(memoryStore());
		const response = await fetcher(
			await signer().sign('https://s3.example.com/acme/missing', {
				method: 'GET',
				aws: { service: 's3', region: 'auto' }
			})
		);

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
		expect(response.headers.get('content-type')).toBe('application/xml');
		expect(await response.text()).toContain('<Code>NoSuchKey</Code>');
	});

	it('rejects a tampered signature with 403', async () => {
		const fetcher = appFetcher(memoryStore());
		const signed = await signer().sign('https://s3.example.com/acme/k', {
			method: 'GET',
			aws: { service: 's3', region: 'auto' }
		});
		const tampered = new Request('https://s3.example.com/acme/OTHER', {
			headers: signed.headers
		});

		const response = await fetcher(tampered);
		expect(response.status).toBe(StatusCodes.FORBIDDEN);
		expect(await response.text()).toContain('SignatureDoesNotMatch');
	});

	it('answers 416 for a range beyond the object size', async () => {
		const fetcher = appFetcher(memoryStore());
		await fetcher(
			await signer().sign('https://s3.example.com/acme/k', {
				method: 'PUT',
				body: new TextEncoder().encode('tiny'),
				aws: { service: 's3', region: 'auto' }
			})
		);

		const response = await fetcher(
			await signer().sign('https://s3.example.com/acme/k', {
				method: 'GET',
				headers: { range: 'bytes=100-200' },
				aws: { service: 's3', region: 'auto' }
			})
		);
		expect(response.status).toBe(StatusCodes.REQUESTED_RANGE_NOT_SATISFIABLE);
		expect(await response.text()).toContain('<Code>InvalidRange</Code>');
	});

	it('answers MalformedXML for a malformed completion body', async () => {
		const fetcher = appFetcher(memoryStore());
		const response = await fetcher(
			await signer().sign(
				'https://s3.example.com/acme/nar/x.nar.zst?uploadId=u',
				{
					method: 'POST',
					body: '<not-well-formed',
					aws: { service: 's3', region: 'auto' }
				}
			)
		);
		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
		expect(await response.text()).toContain('<Code>MalformedXML</Code>');
	});

	it.each([
		{
			name: 'out-of-order parts',
			body: '<CompleteMultipartUpload><Part><PartNumber>2</PartNumber><ETag>"b"</ETag></Part><Part><PartNumber>1</PartNumber><ETag>"a"</ETag></Part></CompleteMultipartUpload>'
		},
		{
			name: 'duplicate parts',
			body: '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"a"</ETag></Part><Part><PartNumber>1</PartNumber><ETag>"b"</ETag></Part></CompleteMultipartUpload>'
		}
	])('answers InvalidPartOrder for $name', async ({ body }) => {
		const response = await appFetcher(memoryStore())(
			await signer().sign(
				'https://s3.example.com/acme/nar/x.nar.zst?uploadId=u',
				{
					method: 'POST',
					body,
					aws: { service: 's3', region: 'auto' }
				}
			)
		);

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
		expect(await response.text()).toContain('<Code>InvalidPartOrder</Code>');
	});

	it.each([
		{
			name: 'a hexadecimal part number',
			part: '<PartNumber>0x1</PartNumber><ETag>"a"</ETag>'
		},
		{
			name: 'an exponential part number',
			part: '<PartNumber>1e1</PartNumber><ETag>"a"</ETag>'
		},
		{
			name: 'a nested ETag value',
			part: '<PartNumber>1</PartNumber><ETag><Value>a</Value></ETag>'
		}
	])('answers MalformedXML for $name', async ({ part }) => {
		const response = await appFetcher(memoryStore())(
			await signer().sign(
				'https://s3.example.com/acme/nar/x.nar.zst?uploadId=u',
				{
					method: 'POST',
					body: `<CompleteMultipartUpload><Part>${part}</Part></CompleteMultipartUpload>`,
					aws: { service: 's3', region: 'auto' }
				}
			)
		);

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
		expect(await response.text()).toContain('<Code>MalformedXML</Code>');
	});

	it('counts control-body limits in encoded bytes', async () => {
		const body = `<Delete><!--${'🙂'.repeat(262_145)}--></Delete>`;
		const response = await appFetcher(memoryStore())(
			await signer().sign('https://s3.example.com/acme?delete', {
				method: 'POST',
				body,
				aws: { service: 's3', region: 'auto' }
			})
		);

		expect(body.length).toBeLessThan(1024 * 1024);
		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
		expect(await response.text()).toContain('<Code>MalformedXML</Code>');
	});

	it('cancels a streamed control body when it crosses the byte limit', async () => {
		let isCancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(600_000));
			},
			cancel() {
				isCancelled = true;
			}
		});
		const response = await appFetcher(memoryStore())(
			await signer().sign('https://s3.example.com/acme?delete', {
				method: 'POST',
				body,
				aws: { service: 's3', region: 'auto' }
			})
		);

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
		expect(await response.text()).toContain('<Code>MalformedXML</Code>');
		expect(isCancelled).toBe(true);
	});

	it.each(['abc', '-1', '1.5', '9007199254740992'])(
		'rejects the invalid Content-Length %s',
		async (contentLength) => {
			const response = await appFetcher(memoryStore())(
				await signer().sign('https://s3.example.com/acme?delete', {
					method: 'POST',
					headers: { 'content-length': contentLength },
					body: '<Delete></Delete>',
					aws: { service: 's3', region: 'auto' }
				})
			);

			expect(response.status).toBe(StatusCodes.BAD_REQUEST);
			expect(await response.text()).toContain('<Code>InvalidRequest</Code>');
		}
	);

	it('rejects a control body shorter than its Content-Length', async () => {
		const response = await appFetcher(memoryStore())(
			await signer().sign('https://s3.example.com/acme?delete', {
				method: 'POST',
				headers: { 'content-length': '100' },
				body: '<Delete></Delete>',
				aws: { service: 's3', region: 'auto' }
			})
		);

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
		expect(await response.text()).toContain('<Code>InvalidRequest</Code>');
	});

	it('rejects a DeleteObjects batch over 1000 keys', async () => {
		const fetcher = appFetcher(memoryStore());
		const objects = Array.from(
			{ length: 1001 },
			(_, index) => `<Object><Key>k${String(index)}</Key></Object>`
		).join('');
		const response = await fetcher(
			await signer().sign('https://s3.example.com/acme?delete', {
				method: 'POST',
				body: `<Delete>${objects}</Delete>`,
				aws: { service: 's3', region: 'auto' }
			})
		);
		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
		expect(await response.text()).toContain('<Code>MalformedXML</Code>');
	});

	it.each<{ name: string; error: S3Error; status: number; code: string }>([
		{
			name: 'an unauthorised delete',
			error: new RequestNotSignedError(),
			status: StatusCodes.FORBIDDEN,
			code: 'AccessDenied'
		},
		{
			name: 'an unsupported delete',
			error: new UnsupportedOperationError(),
			status: StatusCodes.NOT_IMPLEMENTED,
			code: 'NotImplemented'
		}
	])(
		'fails the whole DeleteObjects request on $name',
		async ({ error, status, code }) => {
			const store: ObjectStore = {
				...memoryStore(),
				delete() {
					throw error;
				}
			};
			const response = await appFetcher(store)(
				await signer().sign('https://s3.example.com/acme?delete', {
					method: 'POST',
					body: '<Delete><Object><Key>k</Key></Object></Delete>',
					aws: { service: 's3', region: 'auto' }
				})
			);

			expect(response.status).toBe(status);
			expect(await response.text()).toContain(`<Code>${code}</Code>`);
		}
	);

	it('rejects a copy PUT with NotImplemented', async () => {
		const fetcher = appFetcher(memoryStore());
		const response = await fetcher(
			await signer().sign('https://s3.example.com/acme/k', {
				method: 'PUT',
				headers: { 'x-amz-copy-source': '/acme/other' },
				body: new TextEncoder().encode(''),
				aws: { service: 's3', region: 'auto' }
			})
		);
		expect(response.status).toBe(StatusCodes.NOT_IMPLEMENTED);
		expect(await response.text()).toContain('<Code>NotImplemented</Code>');
	});
});
