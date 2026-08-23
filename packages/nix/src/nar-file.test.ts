import { describe, expect, it } from 'vitest';

import {
	NarFileTooLargeError,
	narRegularFileContents,
	UnexpectedNarShapeError
} from './nar-file.ts';

function narString(value: string): Buffer {
	const bytes = Buffer.from(value, 'utf8');
	const header = Buffer.alloc(8);
	header.writeBigUInt64LE(BigInt(bytes.byteLength));
	const padding = Buffer.alloc((8 - (bytes.byteLength % 8)) % 8);

	return Buffer.concat([header, bytes, padding]);
}

function regularFileNar(
	contents: string,
	options: { readonly executable?: boolean } = {}
): Buffer {
	const words = [
		'nix-archive-1',
		'(',
		'type',
		'regular',
		...(options.executable === true ? ['executable', ''] : []),
		'contents'
	];

	return Buffer.concat([
		...words.map((word) => narString(word)),
		narString(contents),
		narString(')')
	]);
}

function chunked(bytes: Buffer, chunkSize: number): AsyncIterable<Uint8Array> {
	let offset = 0;

	return {
		[Symbol.asyncIterator]: () => ({
			next: () => {
				if (offset >= bytes.byteLength) {
					return Promise.resolve({ done: true as const, value: undefined });
				}

				const chunk = bytes.subarray(offset, offset + chunkSize);
				offset += chunk.byteLength;

				return Promise.resolve({ done: false as const, value: chunk });
			}
		})
	};
}

const derivationAterm =
	'Derive([("out","/nix/store/00000000000000000000000000000000-p","","")],[],[],"x","y",[],[])';

describe('narRegularFileContents', () => {
	it.each([
		{ name: 'one whole frame', chunkSize: 4096 },
		{ name: 'byte at a time', chunkSize: 1 },
		{ name: 'frames straddling the length prefixes', chunkSize: 3 }
	])('reads a derivation delivered $name', async ({ chunkSize }) => {
		const contents = await narRegularFileContents(
			chunked(regularFileNar(derivationAterm), chunkSize)
		);

		expect(new TextDecoder().decode(contents)).toBe(derivationAterm);
	});

	it('reads a regular file with the executable marker', async () => {
		const contents = await narRegularFileContents(
			chunked(regularFileNar('#!/bin/sh\n', { executable: true }), 4096)
		);

		expect(new TextDecoder().decode(contents)).toBe('#!/bin/sh\n');
	});

	it('reads an empty file', async () => {
		const contents = await narRegularFileContents(
			chunked(regularFileNar(''), 4096)
		);

		expect(contents).toStrictEqual(new Uint8Array());
	});

	it.each([
		{
			name: 'a directory',
			nar: Buffer.concat(
				['nix-archive-1', '(', 'type', 'directory', ')'].map((word) =>
					narString(word)
				)
			),
			reason: "expected 'regular', found 'directory'"
		},
		{
			name: 'a symlink',
			nar: Buffer.concat(
				['nix-archive-1', '(', 'type', 'symlink', 'target', '/x', ')'].map(
					(word) => narString(word)
				)
			),
			reason: "expected 'regular', found 'symlink'"
		},
		{
			name: 'bytes that are not a NAR',
			nar: narString('something else'),
			reason: 'a structural token declares 14 bytes; the limit is 13'
		},
		{
			name: 'a truncated stream',
			nar: Buffer.concat([narString('nix-archive-1'), narString('(')]),
			reason: 'the stream ended early'
		},
		{
			name: 'a regular node with an unexpected field',
			nar: Buffer.concat(
				['nix-archive-1', '(', 'type', 'regular', 'target'].map((word) =>
					narString(word)
				)
			),
			reason: "expected 'contents' or 'executable', found 'target'"
		}
	])('refuses $name', async ({ nar, reason }) => {
		let thrown: unknown;

		try {
			await narRegularFileContents(chunked(nar, 4096));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(UnexpectedNarShapeError);

		if (!(thrown instanceof UnexpectedNarShapeError)) {
			return;
		}

		expect({
			name: thrown.name,
			reason: thrown.reason,
			message: thrown.message
		}).toStrictEqual({
			name: 'UnexpectedNarShapeError',
			reason,
			message: `Expected a NAR with a regular-file root: ${reason}`
		});
	});

	it.each([
		{
			name: 'releases the stream after reading a complete NAR',
			bytes: regularFileNar('contents'),
			settles: 'read'
		},
		{
			name: 'releases the stream after an early end',
			bytes: narString('nix-archive-1'),
			settles: 'refused'
		},
		{
			name: 'releases the stream after rejecting the wrong node type',
			bytes: Buffer.concat(
				['nix-archive-1', '(', 'type', 'symlink'].map((word) => narString(word))
			),
			settles: 'refused'
		}
	])('$name', async ({ bytes, settles }) => {
		let wasReleased = false;
		let isDelivered = false;
		const stream: AsyncIterable<Uint8Array> = {
			[Symbol.asyncIterator]: () => ({
				next: () => {
					if (isDelivered) {
						return Promise.resolve({ done: true as const, value: undefined });
					}

					isDelivered = true;

					return Promise.resolve({ done: false as const, value: bytes });
				},
				return: () => {
					wasReleased = true;

					return Promise.resolve({ done: true as const, value: undefined });
				}
			})
		};

		let outcome: string;

		try {
			await narRegularFileContents(stream);
			outcome = 'read';
		} catch (error) {
			outcome =
				error instanceof UnexpectedNarShapeError ? 'refused' : 'unexpected';
		}

		expect({ outcome, wasReleased }).toStrictEqual({
			outcome: settles,
			wasReleased: true
		});
	});

	it('refuses a file whose declared length exceeds the byte limit', async () => {
		let thrown: unknown;

		try {
			await narRegularFileContents(
				chunked(regularFileNar('12345678'), 4096),
				4
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(NarFileTooLargeError);

		if (!(thrown instanceof NarFileTooLargeError)) {
			return;
		}

		expect({
			name: thrown.name,
			byteLength: thrown.byteLength,
			maxByteLength: thrown.maxByteLength,
			message: thrown.message
		}).toStrictEqual({
			name: 'NarFileTooLargeError',
			byteLength: 8,
			maxByteLength: 4,
			message:
				'The NAR declares a file length of 8 bytes, above the 4-byte in-memory limit'
		});
	});
});
