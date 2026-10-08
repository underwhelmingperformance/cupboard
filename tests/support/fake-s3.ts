import { createHash, randomUUID } from 'node:crypto';
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
	STATUS_CODES
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { StatusCodes } from 'http-status-codes';

/**
 * The S3 operations that the fake serves.
 */
export type FakeS3Operation =
	| 'CreateMultipartUpload'
	| 'UploadPart'
	| 'CompleteMultipartUpload'
	| 'AbortMultipartUpload'
	| 'PutObject'
	| 'HeadObject';

/**
 * A failure that the fake returns once, for the next request that matches
 * `operation` and, for `UploadPart`, `partNumber`:
 *
 * - `reset` closes the connection once `afterBytes` bytes of the body have
 *   arrived, as R2 does to a body that stops or ends early.
 * - `error` returns the status and S3 error code once `afterBytes` bytes have
 *   arrived, or after the whole body. It closes the connection once the
 *   client has sent the rest of the body or stopped sending it, as an HTTP
 *   server's lingering close does, so the client can read the response.
 * - `refuse-before-body` answers a request that expects `100 Continue` with the
 *   status and code, so its body is never sent.
 * - `lost-response` performs the request and then closes the connection
 *   without responding.
 * - `error-after-effect` performs the request and then returns the status and
 *   code, as an edge server can after R2 has completed the request.
 * - `no-response` performs the request and never responds.
 */
export interface FakeS3Fault {
	readonly operation: FakeS3Operation;
	readonly partNumber?: number;
	readonly afterBytes?: number;
	readonly response:
		| { readonly kind: 'reset' }
		| { readonly kind: 'lost-response' }
		| { readonly kind: 'no-response' }
		| {
				readonly kind: 'error' | 'refuse-before-body' | 'error-after-effect';
				readonly status: number;
				readonly code: string;
		  };
}

/**
 * One request that the fake handled. `outcome` is `reset` when the fake closed
 * the connection, `aborted` when the client did, `error` when the fake
 * returned an S3 error, and `ok` otherwise. `bytes` counts the body bytes that
 * arrived.
 */
export interface FakeS3Request {
	readonly operation: FakeS3Operation;
	readonly key: string;
	readonly partNumber?: number;
	readonly bytes: number;
	readonly outcome: 'ok' | 'reset' | 'aborted' | 'error' | 'unanswered';
	readonly code?: string;
	readonly accessKeyId?: string;
}

/**
 * Schedules `run` after `ms` milliseconds and returns a function that cancels
 * it. Tests pass a manual scheduler so no assertion depends on a real clock.
 */
export type FakeS3Schedule = (run: () => void, ms: number) => () => void;

export interface FakeS3Options {
	/**
	 * Closes the connection of a request whose body receives no bytes for this
	 * long, as R2 does after about 15 seconds. Without it, the fake waits.
	 */
	readonly idleTimeoutMs?: number;
	readonly schedule?: FakeS3Schedule;
	/**
	 * Receives each stored object, from a `PutObject` or a completed multipart
	 * upload.
	 */
	readonly onObject?: (key: string, bytes: Uint8Array) => Promise<void>;
	/**
	 * Keeps only the length and digest of each part and object when false, so
	 * a measurement can send gigabytes through the fake.
	 */
	readonly retainBytes?: boolean;
	/**
	 * Limits each request body to this many bytes per second.
	 */
	readonly bytesPerSecond?: number;
	/**
	 * Receives each event as it happens: `start` when a request's headers
	 * arrive, `data` for each piece of a body, and `end` with the handled
	 * request.
	 */
	readonly onEvent?: (event: FakeS3Event) => void;
}

export type FakeS3Event =
	| {
			readonly kind: 'start';
			readonly operation: FakeS3Operation;
			readonly key: string;
			readonly partNumber?: number;
	  }
	| {
			readonly kind: 'data';
			readonly operation: FakeS3Operation;
			readonly key: string;
			readonly partNumber?: number;
			readonly bytes: number;
	  }
	| { readonly kind: 'end'; readonly request: FakeS3Request };

interface StoredBytes {
	readonly length: number;
	readonly sha256: string;
	readonly etag: string;
	readonly bytes?: Uint8Array;
}

// The ETag of a single body is its MD5 in hex. The ETag of a completed
// multipart upload is the MD5 of the parts' binary MD5s, a hyphen and the
// number of parts, as R2 documents.
function bodyEtag(md5: Buffer): string {
	return `"${md5.toString('hex')}"`;
}

const partNumberPattern = /<PartNumber>(?<value>\d+)<\/PartNumber>/u;

const etagPattern = /<ETag>(?<value>.*?)<\/ETag>/u;

// Returns the stored part that a completion request lists, or `undefined`
// when no part has that number and ETag.
function listedPart(
	upload: MultipartUpload,
	listing: string
): StoredBytes | undefined {
	const partNumber = partNumberPattern.exec(listing)?.groups?.value;
	const etag = etagPattern.exec(listing)?.groups?.value ?? '';
	const part = upload.parts.get(Number(partNumber));

	return part !== undefined &&
		unquoted(etag.replaceAll('&quot;', '"')) === unquoted(part.etag)
		? part
		: undefined;
}

function unquoted(etag: string): string {
	return etag.replaceAll('"', '');
}

function outcomeAfterEffect(
	fault: FakeS3Fault['response']
): FakeS3Request['outcome'] {
	if (fault.kind === 'lost-response') {
		return 'reset';
	}

	return fault.kind === 'no-response' ? 'unanswered' : 'error';
}

function multipartEtag(parts: readonly StoredBytes[]): string {
	const digests = parts.map((part) =>
		Buffer.from(part.etag.replaceAll('"', ''), 'hex')
	);
	const digest = createHash('md5').update(Buffer.concat(digests)).digest('hex');

	return `"${digest}-${String(parts.length)}"`;
}

interface ReceivedBody extends StoredBytes {
	readonly outcome: 'ok' | 'reset' | 'aborted';
}

interface MultipartUpload {
	readonly key: string;
	readonly parts: Map<number, StoredBytes>;
}

class FakeS3RequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: string
	) {
		super(code);
		this.name = 'FakeS3RequestError';
	}
}

const credentialPattern = /Credential=(?<accessKeyId>[^/]+)\//u;

/**
 * An S3 endpoint on the loopback interface that serves the operations of a
 * multipart upload and enforces the rules that R2 applies to them: every part
 * except the last has the same length, the last part is no longer than the
 * others, a body that stops for longer than the idle timeout is reset, and an
 * aborted upload stores nothing. It ignores request signatures, but records
 * the access key that signed each request.
 */
export class FakeS3 {
	static async start(options: FakeS3Options = {}): Promise<FakeS3> {
		const handler: { fake?: FakeS3 } = {};
		const server = createServer((request, response) => {
			void handler.fake?.handle(request, response);
		});
		server.on('checkContinue', (request, response) => {
			void handler.fake?.handleContinue(request, response);
		});
		const endpoint = await listen(server);
		const fake = new FakeS3(server, endpoint, options);
		handler.fake = fake;

		return fake;
	}

	private readonly faults: FakeS3Fault[] = [];

	private readonly stored = new Map<string, StoredBytes>();

	private readonly uploads = new Map<string, MultipartUpload>();

	readonly requests: FakeS3Request[] = [];

	private constructor(
		private readonly server: Server,
		readonly endpoint: string,
		private readonly options: FakeS3Options
	) {}

	// Answers a request that waits for `100 Continue`, refusing it when the
	// next matching fault says so.
	private async handleContinue(
		request: IncomingMessage,
		response: ServerResponse
	): Promise<void> {
		const target = targetOf(request);
		const next = this.nextFault(target.operation, target.partNumber);
		const fault =
			next?.response.kind === 'refuse-before-body'
				? this.takeFault(target.operation, target.partNumber)
				: undefined;

		if (fault?.response.kind !== 'refuse-before-body') {
			response.writeContinue();
			await this.handle(request, response);
			return;
		}

		this.options.onEvent?.({
			kind: 'start',
			operation: target.operation,
			key: target.key,
			...(target.partNumber !== undefined && {
				partNumber: target.partNumber
			})
		});
		sendError(response, fault.response.status, fault.response.code, {
			isClosing: true
		});
		this.finish({
			...target,
			bytes: 0,
			outcome: 'error',
			code: fault.response.code
		});
	}

	private async handle(
		request: IncomingMessage,
		response: ServerResponse
	): Promise<void> {
		const url = new URL(request.url ?? '/', 'http://fake-s3');
		const base = targetOf(request);
		const { operation, key, partNumber } = base;
		const fault = this.takeFault(operation, partNumber);

		this.options.onEvent?.({
			kind: 'start',
			operation,
			key,
			...(partNumber !== undefined && { partNumber })
		});

		const body = await this.receive(request, base, fault);

		if (body.outcome !== 'ok') {
			this.finish({ ...base, bytes: body.length, outcome: body.outcome });
			return;
		}

		if (
			fault?.response.kind === 'lost-response' ||
			fault?.response.kind === 'no-response' ||
			fault?.response.kind === 'error-after-effect'
		) {
			await this.respond(operation, key, url.searchParams, body, response, {
				isAnswered: false
			});
			this.answerAfterEffect(fault.response, response);
			this.finish({
				...base,
				bytes: body.length,
				outcome: outcomeAfterEffect(fault.response),
				...(fault.response.kind === 'error-after-effect' && {
					code: fault.response.code
				})
			});
			return;
		}

		if (fault?.response.kind === 'error') {
			sendLingeringError(
				request,
				response,
				fault.response.status,
				fault.response.code
			);
			this.finish({
				...base,
				bytes: body.length,
				outcome: 'error',
				code: fault.response.code
			});
			return;
		}

		try {
			await this.respond(operation, key, url.searchParams, body, response, {
				isAnswered: true
			});
			this.finish({ ...base, bytes: body.length, outcome: 'ok' });
		} catch (error) {
			if (!(error instanceof FakeS3RequestError)) {
				throw error;
			}

			sendError(response, error.status, error.code, { isClosing: false });
			this.finish({
				...base,
				bytes: body.length,
				outcome: 'error',
				code: error.code
			});
		}
	}

	private answerAfterEffect(
		fault: FakeS3Fault['response'],
		response: ServerResponse
	): void {
		if (fault.kind === 'lost-response') {
			response.socket?.destroy();
			return;
		}

		if (fault.kind === 'error-after-effect') {
			sendError(response, fault.status, fault.code, { isClosing: false });
		}
	}

	private nextFault(
		operation: FakeS3Operation,
		partNumber: number | undefined
	): FakeS3Fault | undefined {
		return this.faults.find((fault) =>
			isMatchingFault(fault, operation, partNumber)
		);
	}

	private takeFault(
		operation: FakeS3Operation,
		partNumber: number | undefined
	): FakeS3Fault | undefined {
		const index = this.faults.findIndex((fault) =>
			isMatchingFault(fault, operation, partNumber)
		);

		return index === -1 ? undefined : this.faults.splice(index, 1)[0];
	}

	private receive(
		request: IncomingMessage,
		target: {
			readonly operation: FakeS3Operation;
			readonly key: string;
			readonly partNumber?: number;
		},
		fault: FakeS3Fault | undefined
	): Promise<ReceivedBody> {
		const { promise, resolve } = Promise.withResolvers<ReceivedBody>();
		const chunks: Buffer[] = [];
		const hash = createHash('sha256');
		const md5 = createHash('md5');
		// A completion request lists the parts, so its body is always kept.
		const isRetain =
			this.options.retainBytes !== false ||
			target.operation === 'CompleteMultipartUpload';
		const resetAfter =
			fault?.response.kind === 'reset' ? (fault.afterBytes ?? 0) : undefined;
		const answerAfter =
			fault?.response.kind === 'error' ? fault.afterBytes : undefined;

		let length = 0;
		let isSettled = false;
		let cancelIdle: (() => void) | undefined;
		const settle = (outcome: ReceivedBody['outcome']): void => {
			if (isSettled) {
				return;
			}

			isSettled = true;
			cancelIdle?.();
			resolve({
				outcome,
				length,
				sha256: hash.digest('hex'),
				etag: bodyEtag(md5.digest()),
				...(isRetain && { bytes: Buffer.concat(chunks) })
			});
		};
		const reset = (): void => {
			settle('reset');
			request.socket.destroy();
		};

		if (resetAfter === 0) {
			reset();
			return promise;
		}

		const watchIdle = (): void => {
			cancelIdle?.();

			if (this.options.idleTimeoutMs === undefined) {
				return;
			}

			cancelIdle = (this.options.schedule ?? realSchedule)(
				reset,
				this.options.idleTimeoutMs
			);
		};

		watchIdle();
		request.on('data', (chunk: Buffer) => {
			if (isSettled) {
				return;
			}

			const accepted =
				resetAfter === undefined
					? chunk
					: chunk.subarray(0, resetAfter - length);
			length += accepted.byteLength;
			hash.update(accepted);
			md5.update(accepted);

			if (isRetain) {
				chunks.push(accepted);
			}

			this.options.onEvent?.({
				kind: 'data',
				operation: target.operation,
				key: target.key,
				...(target.partNumber !== undefined && {
					partNumber: target.partNumber
				}),
				bytes: accepted.byteLength
			});

			if (resetAfter !== undefined && length >= resetAfter) {
				reset();
				return;
			}

			if (answerAfter !== undefined && length >= answerAfter) {
				settle('ok');
				return;
			}

			watchIdle();
			this.throttle(request, chunk.byteLength);
		});
		request.once('end', () => {
			settle('ok');
		});
		request.once('close', () => {
			settle('aborted');
		});

		return promise;
	}

	private throttle(request: IncomingMessage, bytes: number): void {
		const rate = this.options.bytesPerSecond;

		if (rate === undefined) {
			return;
		}

		request.pause();
		setTimeout(() => request.resume(), (bytes / rate) * 1000);
	}

	private async respond(
		operation: FakeS3Operation,
		key: string,
		query: URLSearchParams,
		body: StoredBytes,
		response: ServerResponse,
		{ isAnswered }: { readonly isAnswered: boolean }
	): Promise<void> {
		switch (operation) {
			case 'CreateMultipartUpload': {
				const uploadId = randomUUID();
				this.uploads.set(uploadId, { key, parts: new Map() });
				sendXml(
					response,
					`<InitiateMultipartUploadResult><Bucket>bucket</Bucket><Key>${escapeXml(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`
				);
				return;
			}
			case 'UploadPart': {
				const upload = this.requireUpload(query);
				upload.parts.set(Number(query.get('partNumber')), body);
				response.writeHead(StatusCodes.OK, { etag: body.etag });
				response.end();
				return;
			}
			case 'CompleteMultipartUpload': {
				const upload = this.requireUpload(query);
				const object = completedObject(upload, body);
				this.uploads.delete(query.get('uploadId') ?? '');
				await this.store(upload.key, object);

				if (!isAnswered) {
					return;
				}

				sendXml(
					response,
					`<CompleteMultipartUploadResult><Bucket>bucket</Bucket><Key>${escapeXml(upload.key)}</Key><ETag>${object.etag}</ETag></CompleteMultipartUploadResult>`
				);
				return;
			}
			case 'AbortMultipartUpload': {
				this.uploads.delete(query.get('uploadId') ?? '');
				response.writeHead(StatusCodes.NO_CONTENT);
				response.end();
				return;
			}
			case 'PutObject': {
				await this.store(key, body);
				response.writeHead(StatusCodes.OK, { etag: body.etag });
				response.end();
				return;
			}
			case 'HeadObject': {
				const object = this.stored.get(key);

				if (object === undefined) {
					response.writeHead(StatusCodes.NOT_FOUND);
					response.end();
					return;
				}

				response.writeHead(StatusCodes.OK, {
					'content-length': String(object.length),
					etag: object.etag
				});
				response.end();
			}
		}
	}

	private requireUpload(query: URLSearchParams): MultipartUpload {
		const upload = this.uploads.get(query.get('uploadId') ?? '');

		if (upload === undefined) {
			throw new FakeS3RequestError(StatusCodes.NOT_FOUND, 'NoSuchUpload');
		}

		return upload;
	}

	private async store(key: string, object: StoredBytes): Promise<void> {
		this.stored.set(key, object);

		if (object.bytes !== undefined) {
			await this.options.onObject?.(key, object.bytes);
		}
	}

	private finish(request: FakeS3Request): void {
		this.requests.push(request);
		this.options.onEvent?.({ kind: 'end', request });
	}

	/**
	 * Fails the next request that matches `fault`.
	 */
	fail(fault: FakeS3Fault): void {
		this.faults.push(fault);
	}

	/**
	 * Returns the bytes of each stored object, by key.
	 */
	objects(): ReadonlyMap<string, Uint8Array> {
		return new Map(
			[...this.stored].map(([key, object]) => [
				key,
				object.bytes ?? new Uint8Array()
			])
		);
	}

	/**
	 * Stores `bytes` at `key` as a single `PutObject` would, or removes the
	 * object when `bytes` is undefined. A test uses it to simulate another
	 * writer.
	 */
	replaceObject(key: string, bytes: Uint8Array | undefined): void {
		if (bytes === undefined) {
			this.stored.delete(key);
			return;
		}

		this.stored.set(key, {
			length: bytes.byteLength,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			etag: bodyEtag(createHash('md5').update(bytes).digest()),
			bytes
		});
	}

	/**
	 * The keys of multipart uploads that were neither completed nor aborted.
	 */
	openUploads(): string[] {
		return this.uploads
			.values()
			.map((upload) => upload.key)
			.toArray();
	}

	async stop(): Promise<void> {
		this.server.closeAllConnections();
		await new Promise<void>((resolve, reject) => {
			this.server.close((error) => {
				if (error === undefined) {
					resolve();
					return;
				}

				reject(error);
			});
		});
	}
}

function isMatchingFault(
	fault: FakeS3Fault,
	operation: FakeS3Operation,
	partNumber: number | undefined
): boolean {
	return (
		fault.operation === operation &&
		(fault.partNumber === undefined || fault.partNumber === partNumber)
	);
}

function targetOf(request: IncomingMessage): {
	readonly operation: FakeS3Operation;
	readonly key: string;
	readonly partNumber?: number;
	readonly accessKeyId?: string;
} {
	const url = new URL(request.url ?? '/', 'http://fake-s3');
	const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
	const operation = operationOf(request.method, url.searchParams);
	const partNumber =
		operation === 'UploadPart'
			? Number(url.searchParams.get('partNumber'))
			: undefined;
	const accessKeyId = credentialPattern.exec(
		request.headers.authorization ?? ''
	)?.groups?.accessKeyId;

	return {
		operation,
		key,
		...(partNumber !== undefined && { partNumber }),
		...(accessKeyId !== undefined && { accessKeyId })
	};
}

function operationOf(
	method: string | undefined,
	query: URLSearchParams
): FakeS3Operation {
	if (method === 'POST' && query.has('uploads')) {
		return 'CreateMultipartUpload';
	}

	if (method === 'POST') {
		return 'CompleteMultipartUpload';
	}

	if (method === 'DELETE') {
		return 'AbortMultipartUpload';
	}

	if (method === 'HEAD') {
		return 'HeadObject';
	}

	return query.has('partNumber') ? 'UploadPart' : 'PutObject';
}

// Joins the parts that the completion request lists, and refuses parts that
// break R2's length rules with the error that R2 returns.
function completedObject(
	upload: MultipartUpload,
	request: StoredBytes
): StoredBytes {
	const listed = new TextDecoder()
		.decode(request.bytes ?? new Uint8Array())
		.matchAll(/<Part>(?<part>.*?)<\/Part>/gsu)
		.map((match) => listedPart(upload, match.groups?.part ?? ''))
		.toArray();
	const parts = listed.filter((part) => part !== undefined);
	const [first] = parts;
	const last = parts.at(-1);

	if (
		first === undefined ||
		last === undefined ||
		parts.length !== listed.length ||
		parts.slice(0, -1).some((part) => part.length !== first.length) ||
		last.length > first.length
	) {
		throw new FakeS3RequestError(StatusCodes.BAD_REQUEST, 'InvalidPart');
	}

	const length = parts.reduce((total, part) => total + part.length, 0);
	const retained = parts.flatMap((part) =>
		part.bytes === undefined ? [] : [part.bytes]
	);

	const etag = multipartEtag(parts);

	if (retained.length !== parts.length) {
		return {
			length,
			sha256: createHash('sha256')
				.update(parts.map((part) => part.sha256).join(''))
				.digest('hex'),
			etag
		};
	}

	const bytes = Buffer.concat(retained);

	return {
		length,
		sha256: createHash('sha256').update(bytes).digest('hex'),
		etag,
		bytes
	};
}

function sendXml(response: ServerResponse, body: string): void {
	response.writeHead(StatusCodes.OK, { 'content-type': 'application/xml' });
	response.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
}

function sendError(
	response: ServerResponse,
	status: number,
	code: string,
	{ isClosing }: { readonly isClosing: boolean }
): void {
	response.writeHead(status, {
		'content-type': 'application/xml',
		...(isClosing && { connection: 'close' })
	});
	response.end(errorDocument(code));
}

// Writes the response to the socket directly. Node destroys the socket as soon
// as a response with `connection: close` ends, and a client that is still
// sending the body can then see the reset before it reads the response.
function sendLingeringError(
	request: IncomingMessage,
	response: ServerResponse,
	status: number,
	code: string
): void {
	const socket = response.socket;

	if (socket === null) {
		return;
	}

	const document = errorDocument(code);
	socket.write(
		[
			`HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ''}`,
			'content-type: application/xml',
			`content-length: ${String(Buffer.byteLength(document))}`,
			'connection: close',
			'',
			document
		].join('\r\n')
	);

	if (request.complete) {
		socket.end();
		return;
	}

	request.once('end', () => {
		socket.end();
	});
}

function errorDocument(code: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

const realSchedule: FakeS3Schedule = (run, ms) => {
	const timer = setTimeout(run, ms);

	return () => {
		clearTimeout(timer);
	};
};

function isAddressInfo(
	address: string | AddressInfo | null
): address is AddressInfo {
	return address !== null && typeof address !== 'string';
}

function listen(server: Server): Promise<string> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			const address = server.address();

			if (!isAddressInfo(address)) {
				reject(new TypeError('The fake S3 server is not listening on TCP'));
				return;
			}

			resolve(`http://127.0.0.1:${String(address.port)}`);
		});
	});
}
