import { bestEffort } from './cleanup.ts';

interface ResponseBodyReader {
	cancel(reason?: unknown): Promise<void>;
	read(): Promise<
		| { readonly done: true; readonly value?: Uint8Array }
		| { readonly done: false; readonly value: Uint8Array }
	>;
}

interface ResponseBodyStream {
	cancel(reason?: unknown): Promise<void>;
	getReader(): ResponseBodyReader;
}

export interface ReadableResponseBody {
	readonly body: ResponseBodyStream | null;
	readonly headers: Pick<Headers, 'get'>;
}

export interface BoundedResponseBodyOptions {
	readonly description: string;
	readonly maximumBytes: number;
	readonly signal?: AbortSignal;
}

export class RemoteBodyTooLargeError extends Error {
	constructor(
		public readonly description: string,
		public readonly maximumBytes: number,
		public readonly observedBytes: number
	) {
		super(
			`${description} exceeded the ${String(maximumBytes)}-byte limit after ${String(observedBytes)} bytes`
		);
		this.name = 'RemoteBodyTooLargeError';
	}
}

type BodyLimitMode = 'reject' | 'truncate';

/**
Collects bytes up to one limit, either rejecting or retaining a preview.
*/
export class BoundedBodyCollector {
	readonly #chunks: Uint8Array[] = [];
	readonly #description: string;
	readonly #maximumBytes: number;
	readonly #mode: BodyLimitMode;
	#byteLength = 0;
	#truncated = false;

	constructor(
		maximumBytes: number,
		mode: BodyLimitMode = 'reject',
		description = 'response body'
	) {
		if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
			throw new RangeError(
				'The response body limit must be a non-negative integer'
			);
		}

		this.#maximumBytes = maximumBytes;
		this.#mode = mode;
		this.#description = description;
	}

	get byteLength(): number {
		return this.#byteLength;
	}

	get truncated(): boolean {
		return this.#truncated;
	}

	append(chunk: Uint8Array): boolean {
		const observedBytes = this.#byteLength + chunk.byteLength;

		if (observedBytes <= this.#maximumBytes) {
			this.#chunks.push(chunk);
			this.#byteLength = observedBytes;

			return true;
		}

		if (this.#mode === 'reject') {
			throw new RemoteBodyTooLargeError(
				this.#description,
				this.#maximumBytes,
				observedBytes
			);
		}

		const remaining = this.#maximumBytes - this.#byteLength;

		if (remaining > 0) {
			this.#chunks.push(chunk.subarray(0, remaining));
			this.#byteLength += remaining;
		}

		this.#truncated = true;

		return false;
	}

	bytes(): Uint8Array {
		const bytes = new Uint8Array(this.#byteLength);
		let offset = 0;

		for (const chunk of this.#chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}

		return bytes;
	}

	text(): string {
		const text = new TextDecoder().decode(this.bytes());

		return this.#truncated ? `${text}\n[response body truncated]` : text;
	}
}

function declaredBodyBytes(response: ReadableResponseBody): number | undefined {
	const value = response.headers.get('content-length');

	if (value === null || !/^\d+$/.test(value)) {
		return undefined;
	}

	return Number(value);
}

/**
Reads a response body without allowing the peer to exceed a byte limit.
*/
export async function readResponseBytes(
	response: ReadableResponseBody,
	options: BoundedResponseBodyOptions
): Promise<Uint8Array> {
	options.signal?.throwIfAborted();
	const declaredBytes = declaredBodyBytes(response);

	if (declaredBytes !== undefined && declaredBytes > options.maximumBytes) {
		const body = response.body;

		if (body !== null) {
			await bestEffort(() => body.cancel());
		}
		throw new RemoteBodyTooLargeError(
			options.description,
			options.maximumBytes,
			declaredBytes
		);
	}

	if (response.body === null) {
		return new Uint8Array();
	}

	const reader = response.body.getReader();
	const collector = new BoundedBodyCollector(
		options.maximumBytes,
		'reject',
		options.description
	);
	const abort = (): void => {
		void bestEffort(() => reader.cancel(options.signal?.reason));
	};
	options.signal?.addEventListener('abort', abort, { once: true });

	try {
		for (;;) {
			options.signal?.throwIfAborted();
			const chunk = await reader.read();
			options.signal?.throwIfAborted();

			if (chunk.done) {
				return collector.bytes();
			}

			collector.append(chunk.value);
		}
	} catch (error) {
		await bestEffort(() => reader.cancel());
		options.signal?.throwIfAborted();
		throw error;
	} finally {
		options.signal?.removeEventListener('abort', abort);
	}
}

/**
Reads a bounded response body and decodes it as UTF-8 text.
*/
export async function readResponseText(
	response: ReadableResponseBody,
	options: BoundedResponseBodyOptions
): Promise<string> {
	return new TextDecoder().decode(await readResponseBytes(response, options));
}

/**
Reads bounded UTF-8 response text and parses it as JSON.
*/
export async function readResponseJson(
	response: ReadableResponseBody,
	options: BoundedResponseBodyOptions
): Promise<unknown> {
	return JSON.parse(await readResponseText(response, options));
}
