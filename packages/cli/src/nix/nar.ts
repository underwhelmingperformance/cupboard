import { createHash } from 'node:crypto';
import {
	closeSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readlinkSync,
	readSync
} from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import pathModule from 'node:path';
import { setImmediate } from 'node:timers/promises';

import type { NixSha256Hash } from '@cupboard/nix-store/hash';
import { toNixSha256 } from '@cupboard/nix-store/hash';
import { withIterableCleanup } from '@cupboard/shared/cleanup';

import { ByteAccumulator, byteStream } from '../io/byte-stream.ts';

export {
	InvalidNixSha256HashError,
	InvalidSha256DigestLengthError
} from '@cupboard/nix-store/errors';
export {
	NixSha256Hash,
	toNixBase32,
	toNixSha256
} from '@cupboard/nix-store/hash';

const textEncoder = new TextEncoder();

export abstract class NarError extends Error {}

export interface NarDigest {
	readonly narHash: NixSha256Hash;
	readonly narSize: number;
}

export class UnsupportedNarPathTypeError extends NarError {
	constructor(public readonly path: string) {
		super(`Unsupported file type in NAR path: ${path}`);
		this.name = 'UnsupportedNarPathTypeError';
	}
}

export class InvalidNarStringLengthError extends NarError {
	constructor(public readonly length: number) {
		super(`Invalid NAR string length: ${String(length)}`);
		this.name = 'InvalidNarStringLengthError';
	}
}

export class NarFileShrankError extends NarError {
	constructor(
		public readonly path: string,
		public readonly expected: number,
		public readonly actual: number
	) {
		super(
			`File shrank while building NAR for ${path}: expected ${String(expected)} bytes, read ${String(actual)}`
		);
		this.name = 'NarFileShrankError';
	}
}

const pieceSize = 1024 * 1024;

const fileChunkSize = 64 * 1024;

// Reading a tree of small files asynchronously costs one thread-pool round
// trip for each file system call, and that latency, not the bytes, decides how
// fast the NAR is produced. `lstat`, `readdir` and `readlink` are therefore
// synchronous, and files up to this size are opened, measured and read
// synchronously on one descriptor. Each call blocks the event loop until the
// kernel returns, which is short only when the file is in the page cache.
const syncReadMaxBytes = fileChunkSize;

// The serialiser lets the event loop run after this many nodes or this many
// bytes of NAR, whichever comes first, so that reads from a cold page cache
// cannot stall other uploads for long.
const nodesBetweenTurns = 64;

const bytesBetweenTurns = pieceSize;

export class NarArchive implements AsyncIterable<Uint8Array> {
	constructor(public readonly path: string) {}

	[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
		return narFromPath(this.path)[Symbol.asyncIterator]();
	}

	stream(): ReadableStream<Uint8Array> {
		return byteStream(narFromPath(this.path));
	}

	hash(): Promise<NarDigest> {
		return hashNar(this.path);
	}
}

export async function* narFromPath(path: string): AsyncIterable<Uint8Array> {
	const writer = new NarWriter();
	const turns = new EventLoopTurns();
	const directories: OpenDirectory[] = [];
	let next: string | undefined = path;

	writer.string('nix-archive-1');

	for (;;) {
		if (next !== undefined) {
			yield* narNode(writer, next, directories);
			await turns.afterNode(writer.written);
		}

		const directory = directories.at(-1);

		if (directory === undefined) {
			break;
		}

		next = directory.nextEntry(writer);

		if (next !== undefined) {
			continue;
		}

		directories.pop();
		closeNode(writer, directories);
	}

	yield* writer.finish();
}

export async function hashNar(path: string): Promise<NarDigest> {
	const hash = createHash('sha256');
	let size = 0;

	for await (const chunk of narFromPath(path)) {
		hash.update(chunk);
		size += chunk.byteLength;
	}

	return {
		narHash: toNixSha256(hash.digest()),
		narSize: size
	};
}

class EventLoopTurns {
	private nodes = 0;

	private bytesAtLastTurn = 0;

	async afterNode(bytesWritten: number): Promise<void> {
		this.nodes += 1;

		if (
			this.nodes < nodesBetweenTurns &&
			bytesWritten - this.bytesAtLastTurn < bytesBetweenTurns
		) {
			return;
		}

		this.nodes = 0;
		this.bytesAtLastTurn = bytesWritten;
		await setImmediate();
	}
}

/**
 * A directory whose entries are being written, in the byte order of their
 * names.
 */
class OpenDirectory {
	private index = 0;

	constructor(
		private readonly path: string,
		private readonly entries: readonly string[]
	) {}

	/**
	 * Writes the start of the next entry and returns the path of its node, or
	 * returns `undefined` once every entry has been written.
	 */
	nextEntry(writer: NarWriter): string | undefined {
		const entry = this.entries[this.index];

		if (entry === undefined) {
			return undefined;
		}

		this.index += 1;
		writer.strings('entry', '(', 'name', entry, 'node');

		return pathModule.join(this.path, entry);
	}
}

// Writes one node. For a directory, this writes only the node's type and
// pushes the directory onto `directories`; `narFromPath` writes its entries.
async function* narNode(
	writer: NarWriter,
	path: string,
	directories: OpenDirectory[]
): AsyncIterable<Uint8Array> {
	const stats = lstatSync(path);

	if (!stats.isDirectory() && !stats.isFile() && !stats.isSymbolicLink()) {
		throw new UnsupportedNarPathTypeError(path);
	}

	writer.string('(');

	if (stats.isDirectory()) {
		writer.strings('type', 'directory');
		directories.push(
			new OpenDirectory(path, readdirSync(path).toSorted(compareNarNames))
		);
		return;
	}

	if (stats.isSymbolicLink()) {
		writer.strings('type', 'symlink', 'target', readlinkSync(path));
		closeNode(writer, directories);
		yield* writer.complete();
		return;
	}

	writer.strings('type', 'regular');

	if ((stats.mode & 0o111) !== 0) {
		writer.strings('executable', '');
	}

	writer.string('contents');

	const contents =
		stats.size <= syncReadMaxBytes ? readSmallFile(path) : undefined;

	if (contents === undefined) {
		yield* narLargeFile(writer, path);
	} else {
		writer.bytes(contents);
	}

	closeNode(writer, directories);
	yield* writer.complete();
}

// Closes a node, and then the directory entry that contains it, if any.
function closeNode(
	writer: NarWriter,
	directories: readonly OpenDirectory[]
): void {
	writer.string(')');

	if (directories.length > 0) {
		writer.string(')');
	}
}

// Returns `undefined` when the opened file is larger than `syncReadMaxBytes`.
function readSmallFile(path: string): Buffer | undefined {
	// One descriptor for the size and the bytes, so `fstat` measures the file
	// that is read even if the path is replaced on disk.
	const descriptor = openSync(path, 'r');

	try {
		const { size } = fstatSync(descriptor);

		if (size > syncReadMaxBytes) {
			return undefined;
		}

		const contents = Buffer.allocUnsafe(size);

		for (let position = 0; position < size;) {
			const bytesRead = readSync(
				descriptor,
				contents,
				position,
				size - position,
				position
			);

			if (bytesRead === 0) {
				throw new NarFileShrankError(path, size, position);
			}

			position += bytesRead;
		}

		return contents;
	} finally {
		closeSync(descriptor);
	}
}

async function* narLargeFile(
	writer: NarWriter,
	path: string
): AsyncIterable<Uint8Array> {
	// One handle for the size and the bytes, as in `readSmallFile`.
	const file = await open(path, 'r');

	yield* withIterableCleanup(narFileContents(writer, file, path), () =>
		file.close()
	);
}

async function* narFileContents(
	writer: NarWriter,
	file: FileHandle,
	path: string
): AsyncIterable<Uint8Array> {
	const { size } = await file.stat();
	const buffer = Buffer.allocUnsafe(Math.min(fileChunkSize, size));

	writer.length(size);

	for (let position = 0; position < size;) {
		const { bytesRead } = await file.read(
			buffer,
			0,
			Math.min(buffer.byteLength, size - position),
			position
		);

		if (bytesRead === 0) {
			throw new NarFileShrankError(path, size, position);
		}

		position += bytesRead;
		writer.raw(buffer.subarray(0, bytesRead));
		yield* writer.complete();
	}

	writer.padding(size);
}

// Copies the NAR's bytes into pieces of `pieceSize` bytes, so a consumer
// receives one 1 MiB piece in place of many short length prefixes, strings and
// paddings.
class NarWriter {
	private readonly pieces = new ByteAccumulator(pieceSize);

	get written(): number {
		return this.pieces.written;
	}

	// Writes the length, the bytes and the padding of a NAR byte string.
	bytes(value: Uint8Array): void {
		this.length(value.byteLength);
		this.raw(value);
		this.padding(value.byteLength);
	}

	string(value: string): void {
		this.bytes(textEncoder.encode(value));
	}

	strings(...values: readonly string[]): void {
		for (const value of values) {
			this.string(value);
		}
	}

	length(length: number): void {
		this.raw(createLengthPrefix(length));
	}

	padding(length: number): void {
		this.raw(zeroPadding.subarray(0, paddingLength(length)));
	}

	raw(bytes: Uint8Array): void {
		this.pieces.write(bytes);
	}

	complete(): Iterable<Uint8Array> {
		return this.pieces.takeComplete();
	}

	finish(): Iterable<Uint8Array> {
		return this.pieces.takeAll();
	}
}

const zeroPadding = new Uint8Array(8);

function createLengthPrefix(length: number): Uint8Array {
	if (!Number.isSafeInteger(length) || length < 0) {
		throw new InvalidNarStringLengthError(length);
	}

	const prefix = Buffer.alloc(8);
	prefix.writeBigUInt64LE(BigInt(length));

	return prefix;
}

function paddingLength(length: number): number {
	return (8 - (length % 8)) % 8;
}

function compareNarNames(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
