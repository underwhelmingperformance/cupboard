import {
	closeSync,
	createReadStream,
	createWriteStream,
	fchmodSync,
	mkdirSync,
	openSync
} from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { PassThrough, type Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
	constants,
	createGunzip,
	createGzip,
	createZstdCompress,
	createZstdDecompress
} from 'node:zlib';

import type { LogRecord, Sink } from '@logtape/logtape';

import { jsonLinesSink } from './sinks.ts';

const mebibyte = 1024 * 1024;
const maximumReadBytes = 32 * mebibyte;

export interface FileSinkOptions {
	readonly maximumBytes?: number;
	readonly maximumQueuedBytes?: number;
	readonly onError?: (error: unknown) => void;
}

export interface FileLogging {
	readonly sink: Sink;
	drain(): Promise<void>;
	close(): Promise<void>;
}

interface PendingRecord {
	readonly line: string;
	readonly bytes: number;
	readonly shouldFlush: boolean;
}

interface LogOutput {
	readonly stream: Transform;
	readonly completed: Promise<void>;
	flush(): Promise<void>;
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function write(stream: Writable, text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.write(text, (error) => {
			if (error !== undefined && error !== null) {
				reject(error);
				return;
			}

			resolve();
		});
	});
}

function createOutput(filename: string): LogOutput {
	const stream = filename.endsWith('.zst')
		? createZstdCompress({
				params: {
					[constants.ZSTD_c_compressionLevel]: 3,
					[constants.ZSTD_c_checksumFlag]: 1
				}
			})
		: filename.endsWith('.gz')
			? createGzip({ level: 1 })
			: new PassThrough();
	const descriptor = openSync(filename, 'w', 0o600);

	try {
		fchmodSync(descriptor, 0o600);
	} catch (error) {
		closeSync(descriptor);
		throw error;
	}

	const file = createWriteStream(filename, { fd: descriptor, autoClose: true });
	const completed = pipeline(stream, file);

	return {
		stream,
		completed,
		flush: async () => {
			if ('flush' in stream && typeof stream.flush === 'function') {
				const kind = filename.endsWith('.zst')
					? constants.ZSTD_e_flush
					: constants.Z_SYNC_FLUSH;

				await new Promise<void>((resolve, reject) => {
					stream.flush(kind, (error?: Error | null) => {
						if (error !== undefined && error !== null) {
							reject(error);
							return;
						}

						resolve();
					});
				});
			}

			await write(file, '');
		}
	};
}

/**
Writes JSON logs with optional streaming compression and bounded rotation.
*/
export function createFileSink(
	filename: string,
	options: FileSinkOptions = {}
): FileLogging {
	return new RotatingLogFile(filename, options);
}

class RotatingLogFile implements FileLogging {
	readonly #filename: string;
	readonly #options: FileSinkOptions;
	readonly #pending: PendingRecord[] = [];
	readonly #timer: ReturnType<typeof setInterval>;
	#output: LogOutput;
	#bytes = 0;
	#queuedBytes = 0;
	#dropped = 0;
	#working: Promise<void> | undefined;
	#isClosing = false;
	#closing: Promise<void> | undefined;
	#hasFailed = false;
	#shouldFlush = false;
	#shouldFlushAtEnd = false;

	readonly sink: Sink;

	constructor(filename: string, options: FileSinkOptions) {
		this.#filename = filename;
		this.#options = options;

		mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
		this.#output = this.#open();
		this.sink = (record) => {
			if (this.#isClosing) {
				return;
			}

			const shouldFlush = record.level === 'error' || record.level === 'fatal';
			const serialise = jsonLinesSink((line) => {
				this.#enqueue(line, shouldFlush);
			});

			serialise(record);
		};
		this.#timer = setInterval(() => {
			this.#shouldFlush = true;
			this.#start();
		}, 1000);
		this.#timer.unref();
	}

	#report(error: unknown): void {
		if (this.#hasFailed) {
			return;
		}

		this.#hasFailed = true;
		this.#pending.length = 0;
		this.#queuedBytes = 0;

		if (this.#options.onError !== undefined) {
			try {
				this.#options.onError(error);
			} catch (reportingError) {
				this.#reportToStderr(
					'Cupboard file logging error handler failed',
					reportingError
				);
			}

			return;
		}

		this.#reportToStderr('Cupboard file logging failed', error);
	}

	#reportToStderr(message: string, error: unknown): void {
		jsonLinesSink((line) => process.stderr.write(line))({
			timestamp: Date.now(),
			category: ['logtape', 'meta'],
			level: 'warning',
			message: [message],
			rawMessage: message,
			properties: { error }
		});
	}

	#open(): LogOutput {
		const output = createOutput(this.#filename);

		void output.completed.catch((error: unknown) => {
			this.#report(error);
		});

		return output;
	}

	#enqueue(line: string, shouldFlush: boolean): void {
		if (this.#hasFailed) {
			return;
		}

		const bytes = Buffer.byteLength(line);
		const maximumQueuedBytes = this.#options.maximumQueuedBytes ?? mebibyte;

		if (this.#queuedBytes + bytes > maximumQueuedBytes) {
			this.#dropped += 1;
			return;
		}

		this.#pending.push({ line, bytes, shouldFlush });
		this.#queuedBytes += bytes;
		this.#start();
	}

	#start(): void {
		if (this.#working !== undefined || this.#hasFailed) {
			return;
		}

		this.#working = this.#run();
	}

	async #run(): Promise<void> {
		try {
			await this.#write();
		} catch (error) {
			this.#report(error);
		} finally {
			this.#working = undefined;

			if (
				this.#pending.length > 0 ||
				this.#shouldFlush ||
				this.#shouldFlushAtEnd
			) {
				this.#start();
			}
		}
	}

	async #rotate(): Promise<void> {
		this.#output.stream.end();
		await this.#output.completed;
		await rm(`${this.#filename}.2`, { force: true });

		for (const index of [1, 0]) {
			const source =
				index === 0 ? this.#filename : `${this.#filename}.${String(index)}`;

			try {
				await rename(source, `${this.#filename}.${String(index + 1)}`);
			} catch (error) {
				if (!isMissing(error)) {
					throw error;
				}
			}
		}

		this.#bytes = 0;
		this.#output = this.#open();
	}

	async #write(): Promise<void> {
		while (!this.#hasFailed) {
			if (this.#shouldFlush) {
				this.#reportDrops();
			}

			const record = this.#pending.shift();

			if (record === undefined) {
				if (!this.#shouldFlush && !this.#shouldFlushAtEnd) {
					return;
				}

				this.#shouldFlush = false;
				this.#shouldFlushAtEnd = false;
				await this.#output.flush();
				continue;
			}

			const maximumBytes = this.#options.maximumBytes ?? 10 * mebibyte;

			if (this.#bytes > 0 && this.#bytes + record.bytes > maximumBytes) {
				await this.#rotate();
			}

			await write(this.#output.stream, record.line);

			this.#bytes += record.bytes;
			this.#queuedBytes = Math.max(0, this.#queuedBytes - record.bytes);

			if (!record.shouldFlush && !this.#shouldFlush) {
				continue;
			}

			this.#shouldFlush = false;
			await this.#output.flush();
		}
	}

	#reportDrops(): void {
		if (this.#dropped === 0 || this.#hasFailed) {
			return;
		}

		const record: LogRecord = {
			timestamp: Date.now(),
			category: ['logtape', 'meta'],
			level: 'warning',
			message: ['log records dropped'],
			rawMessage: 'log records dropped',
			properties: { droppedRecords: this.#dropped }
		};
		const serialise = jsonLinesSink((line) => {
			this.#queuedBytes += Buffer.byteLength(line);
			this.#pending.unshift({
				line,
				bytes: Buffer.byteLength(line),
				shouldFlush: true
			});
		});

		this.#dropped = 0;
		serialise(record);
	}

	async #close(): Promise<void> {
		this.#isClosing = true;
		clearInterval(this.#timer);
		await this.drain();

		this.#output.stream.end();

		try {
			await this.#output.completed;
		} catch (error) {
			this.#report(error);
		}
	}

	async drain(): Promise<void> {
		this.#shouldFlush = true;
		this.#shouldFlushAtEnd = true;
		this.#start();

		while (this.#working !== undefined) {
			await this.#working;
		}
	}

	close(): Promise<void> {
		this.#closing ??= this.#close();

		return this.#closing;
	}
}

export interface LogFileContents {
	readonly records: readonly Record<string, unknown>[];
	readonly incomplete: boolean;
}

async function readPrefix(filename: string): Promise<Buffer> {
	const file = await open(filename, 'r');

	try {
		const prefix = Buffer.alloc(4);
		const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);

		return prefix.subarray(0, bytesRead);
	} finally {
		await file.close();
	}
}

async function decompressLog(
	filename: string,
	shouldRecover: boolean
): Promise<string> {
	const prefix = await readPrefix(filename);
	const isZstd = prefix.equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
	const isGzip = prefix[0] === 0x1f && prefix[1] === 0x8b;
	const input = createReadStream(filename);
	const output = isZstd
		? createZstdDecompress(
				shouldRecover ? { finishFlush: constants.ZSTD_e_flush } : {}
			)
		: isGzip
			? createGunzip(
					shouldRecover ? { finishFlush: constants.Z_SYNC_FLUSH } : {}
				)
			: new PassThrough();
	const [, text] = await Promise.all([
		pipeline(input, output),
		collectLogChunks(output)
	]);

	return text;
}

async function collectLogChunks(output: Transform): Promise<string> {
	const chunks: Buffer[] = [];
	let bytes = 0;

	for await (const chunk of output) {
		const value: unknown = chunk;

		if (!(value instanceof Uint8Array)) {
			throw new TypeError('Log decoder returned a non-binary chunk');
		}

		const buffer = Buffer.from(value);
		bytes += buffer.byteLength;

		if (bytes > maximumReadBytes) {
			output.destroy();
			throw new RangeError('Log file exceeds the decompressed size limit');
		}

		chunks.push(buffer);
	}

	return Buffer.concat(chunks).toString('utf8');
}

/**
Reads plain, gzip or Zstandard logs and identifies an unfinished final stream.
*/
export async function readLogFile(filename: string): Promise<LogFileContents> {
	let text: string;
	let isIncomplete = false;

	try {
		text = await decompressLog(filename, false);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!('code' in error) ||
			error.code !== 'Z_BUF_ERROR'
		) {
			throw error;
		}

		isIncomplete = true;
		text = await decompressLog(filename, true);
	}

	if (text !== '' && !text.endsWith('\n')) {
		isIncomplete = true;
		text = text.slice(0, text.lastIndexOf('\n') + 1);
	}

	const records = text
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => {
			const parsed: unknown = JSON.parse(line);

			if (
				typeof parsed !== 'object' ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				throw new TypeError('A log record must be a JSON object');
			}

			return Object.fromEntries(Object.entries(parsed));
		});

	return { records, incomplete: isIncomplete };
}
