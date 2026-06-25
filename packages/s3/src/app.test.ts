import { AwsClient } from 'aws4fetch';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { createS3App } from './app.ts';
import {
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

/** A minimal in-memory object store, standing in for a backing S3 service. */
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

		uploadPart: async (context, uploadId, partNumber, body) => {
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

describe('createS3App via the passthrough loop', () => {
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
			streamOf(new TextEncoder().encode('part-one-'))
		);
		const part2 = await passthrough.uploadPart(
			context,
			upload.uploadId,
			2,
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
			method: 'GET',
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
