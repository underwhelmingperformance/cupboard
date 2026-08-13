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

// A NAR arrives from the daemon in whatever frames the socket delivered, so
// the reader is driven with the bytes split every `chunkSize`.
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

	it('reads an executable file, whose serialisation carries the extra marker', async () => {
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
			reason: "'directory' where 'regular' belongs"
		},
		{
			name: 'a symlink',
			nar: Buffer.concat(
				['nix-archive-1', '(', 'type', 'symlink', 'target', '/x', ')'].map(
					(word) => narString(word)
				)
			),
			reason: "'symlink' where 'regular' belongs"
		},
		{
			name: 'bytes that are not a NAR',
			nar: narString('something else'),
			reason: 'a grammar token of 14 bytes'
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
			reason: "'target' where the contents belong"
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

		expect({ name: thrown.name, reason: thrown.reason }).toStrictEqual({
			name: 'UnexpectedNarShapeError',
			reason
		});
	});

	// A producer holding a resource for the stream's lifetime, such as a
	// dedicated daemon connection, releases it in the generator's `finally`,
	// which runs only once the consumer says it is finished.
	it.each([
		{
			name: 'a NAR it read to the end',
			bytes: regularFileNar('contents'),
			settles: 'read'
		},
		{
			name: 'a NAR that ended early',
			bytes: narString('nix-archive-1'),
			settles: 'refused'
		},
		{
			name: 'a NAR of the wrong shape',
			bytes: Buffer.concat(
				['nix-archive-1', '(', 'type', 'symlink'].map((word) => narString(word))
			),
			settles: 'refused'
		}
	])('releases the stream after $name', async ({ bytes, settles }) => {
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

	it('refuses a file over the byte bound rather than buffering it', async () => {
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
			maxByteLength: thrown.maxByteLength
		}).toStrictEqual({
			name: 'NarFileTooLargeError',
			byteLength: 8,
			maxByteLength: 4
		});
	});
});
