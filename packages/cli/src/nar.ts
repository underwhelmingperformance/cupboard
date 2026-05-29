import { createHash } from 'node:crypto';
import { lstat, readdir, readlink } from 'node:fs/promises';
import pathModule from 'node:path';

import type { NixSha256Hash } from '@cupboard/shared';
import { toNixSha256 } from '@cupboard/shared';

import { byteStream } from './byte-stream.ts';
import { readFileByteStream } from './file-stream.ts';

export {
	InvalidNixSha256HashError,
	InvalidSha256DigestLengthError,
	NixSha256Hash,
	toNixBase32,
	toNixSha256
} from '@cupboard/shared';

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
		yield* narFile(path, stats.mode, stats.size);
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

async function* narFile(
	path: string,
	mode: number,
	size: number
): AsyncIterable<Uint8Array> {
	yield* narString('type');
	yield* narString('regular');

	if ((mode & 0o111) !== 0) {
		yield* narString('executable');
		yield* narString('');
	}

	yield* narString('contents');
	yield createLengthPrefix(size);

	for await (const chunk of readFileByteStream(path)) {
		yield chunk;
	}

	yield* narPadding(size);
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
