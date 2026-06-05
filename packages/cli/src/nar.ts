import { createHash } from 'node:crypto';
import {
	type FileHandle,
	lstat,
	open,
	readdir,
	readlink
} from 'node:fs/promises';
import pathModule from 'node:path';

import type { NixSha256Hash } from '@cupboard/nix/hash';
import { toNixSha256 } from '@cupboard/nix/hash';

import { byteStream } from './byte-stream.ts';

export {
	InvalidNixSha256HashError,
	InvalidSha256DigestLengthError
} from '@cupboard/nix/errors';
export { NixSha256Hash, toNixBase32, toNixSha256 } from '@cupboard/nix/hash';

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

const fileChunkSize = 64 * 1024;

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
	yield* narString('nix-archive-1');
	yield* narNode(path);
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

async function* narNode(path: string): AsyncIterable<Uint8Array> {
	const stats = await lstat(path);

	if (!stats.isDirectory() && !stats.isFile() && !stats.isSymbolicLink()) {
		throw new UnsupportedNarPathTypeError(path);
	}

	yield* narString('(');

	if (stats.isDirectory()) {
		yield* narDirectory(path);
	}

	if (stats.isFile()) {
		yield* narFile(path, stats.mode);
	}

	if (stats.isSymbolicLink()) {
		yield* narSymlink(path);
	}

	yield* narString(')');
}

async function* narDirectory(path: string): AsyncIterable<Uint8Array> {
	yield* narString('type');
	yield* narString('directory');

	const entries = await readdir(path);

	for (const entry of entries.toSorted(compareNarNames)) {
		yield* narString('entry');
		yield* narString('(');
		yield* narString('name');
		yield* narString(entry);
		yield* narString('node');
		yield* narNode(pathModule.join(path, entry));
		yield* narString(')');
	}
}

async function* narFile(path: string, mode: number): AsyncIterable<Uint8Array> {
	yield* narString('type');
	yield* narString('regular');

	if ((mode & 0o111) !== 0) {
		yield* narString('executable');
		yield* narString('');
	}

	yield* narString('contents');

	// One handle for the size and the bytes, so the length prefix and padding
	// always describe the content that follows even if the file changes on disk
	// between framing and reading.
	const file = await open(path, 'r');

	try {
		const { size } = await file.stat();
		yield createLengthPrefix(size);
		yield* readFileContents(file, path, size);
		yield* narPadding(size);
	} finally {
		await file.close();
	}
}

async function* readFileContents(
	file: FileHandle,
	path: string,
	size: number
): AsyncIterable<Uint8Array> {
	let position = 0;

	while (position < size) {
		const buffer = Buffer.allocUnsafe(Math.min(fileChunkSize, size - position));
		const { bytesRead } = await file.read(
			buffer,
			0,
			buffer.byteLength,
			position
		);

		if (bytesRead === 0) {
			throw new NarFileShrankError(path, size, position);
		}

		position += bytesRead;
		yield buffer.subarray(0, bytesRead);
	}
}

async function* narSymlink(path: string): AsyncIterable<Uint8Array> {
	yield* narString('type');
	yield* narString('symlink');
	yield* narString('target');
	yield* narString(await readlink(path));
}

function* narString(value: string): Iterable<Uint8Array> {
	yield* narBytes(textEncoder.encode(value));
}

function* narBytes(bytes: Uint8Array): Iterable<Uint8Array> {
	yield createLengthPrefix(bytes.byteLength);
	yield bytes;
	yield* narPadding(bytes.byteLength);
}

function* narPadding(length: number): Iterable<Uint8Array> {
	const padding = paddingLength(length);

	if (padding > 0) {
		yield Buffer.alloc(padding);
	}
}

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
