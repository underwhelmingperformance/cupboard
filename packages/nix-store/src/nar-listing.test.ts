import { describe, expect, it } from 'vitest';

import { NarListingWriter } from './nar-listing.ts';

function word(value: string | Uint8Array): Uint8Array {
	const bytes =
		typeof value === 'string' ? new TextEncoder().encode(value) : value;
	const result = new Uint8Array(8 + Math.ceil(bytes.length / 8) * 8);
	new DataView(result.buffer).setBigUint64(0, BigInt(bytes.length), true);
	result.set(bytes, 8);
	return result;
}

function archive(words: readonly (string | Uint8Array)[]): Uint8Array {
	const chunks = words.map((value) => word(value));
	const result = new Uint8Array(
		chunks.reduce((size, chunk) => size + chunk.length, 0)
	);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

async function listing(nar: Uint8Array, chunkSize: number): Promise<string> {
	const output: string[] = [];
	const writer = new NarListingWriter({
		write: (chunk) => {
			output.push(chunk);
		}
	});
	for (let offset = 0; offset < nar.length; offset += chunkSize) {
		await writer.write(nar.subarray(offset, offset + chunkSize));
	}
	await writer.end();
	return output.join('');
}

describe('streamed NAR listings', () => {
	it('preserves a byte-order mark in a filename', async () => {
		const nar = archive([
			'nix-archive-1',
			'(',
			'type',
			'directory',
			'entry',
			'(',
			'name',
			'\u{FEFF}a',
			'node',
			'(',
			'type',
			'directory',
			')',
			')',
			')'
		]);
		expect(JSON.parse(await listing(nar, 3))).toStrictEqual({
			version: 1,
			root: {
				type: 'directory',
				entries: { '\u{FEFF}a': { type: 'directory', entries: {} } }
			}
		});
	});
	it.each([1, 7, 8, 31, 4096])(
		'preserves metadata and payload offsets with %i-byte chunks',
		async (chunkSize) => {
			const nar = archive([
				'nix-archive-1',
				'(',
				'type',
				'directory',
				'entry',
				'(',
				'name',
				'a',
				'node',
				'(',
				'type',
				'regular',
				'contents',
				'hello',
				')',
				')',
				'entry',
				'(',
				'name',
				'b',
				'node',
				'(',
				'type',
				'regular',
				'executable',
				'',
				'contents',
				'',
				')',
				')',
				'entry',
				'(',
				'name',
				'c',
				'node',
				'(',
				'type',
				'symlink',
				'target',
				'a',
				')',
				')',
				')'
			]);
			expect(JSON.parse(await listing(nar, chunkSize))).toStrictEqual({
				version: 1,
				root: {
					type: 'directory',
					entries: {
						a: { type: 'regular', size: 5, narOffset: 232 },
						b: { type: 'regular', size: 0, executable: true, narOffset: 456 },
						c: { type: 'symlink', target: 'a' }
					}
				}
			});
		}
	);

	it.each([
		['incomplete archive', archive(['nix-archive-1', '('])],
		[
			'invalid UTF-8',
			archive([
				'nix-archive-1',
				'(',
				'type',
				'symlink',
				'target',
				new Uint8Array([255]),
				')'
			])
		],
		[
			'trailing bytes',
			archive(['nix-archive-1', '(', 'type', 'directory', ')', 'extra'])
		],
		[
			'invalid regular fields',
			archive(['nix-archive-1', '(', 'type', 'regular', 'target', 'x', ')'])
		]
	])('rejects %s', async (_description, nar) => {
		await expect(listing(nar, 3)).rejects.toThrow();
	});

	it('enforces output limits before publishing a complete listing', async () => {
		const output: string[] = [];
		const writer = new NarListingWriter({
			write: (chunk) => {
				output.push(chunk);
			},
			maxOutputBytes: 8
		});
		await expect(
			writer.write(archive(['nix-archive-1', '(', 'type', 'directory', ')']))
		).rejects.toThrow('limit');
	});
});
