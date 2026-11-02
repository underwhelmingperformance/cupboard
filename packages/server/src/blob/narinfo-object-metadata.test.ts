import { NarInfo } from '@cupboard/nix-store/narinfo';
import { cacheMetadataMaxNarInfoBytes } from '@cupboard/protocol/cache-metadata';
import { describe, expect, it, vi } from 'vitest';

import {
	narInfoProjectionMaxBytes,
	readNarInfoProjection
} from './narinfo-object-metadata.ts';

const narInfo = NarInfo.fromFields({
	storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-example',
	url: 'nar/example.nar.zst',
	compression: 'zstd',
	fileHash: 'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
	fileSize: 123,
	narHash: 'sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
	narSize: 456,
	references: [],
	sigs: []
});
const metadata = {
	generation: '1',
	narHash: narInfo.narHash.toString(),
	narUrl: narInfo.url,
	signatureGeneration: '0'
};
const utf8 = new TextEncoder();

function projection(text = narInfo.render()) {
	const bytes = utf8.encode(text);
	return {
		size: bytes.byteLength,
		customMetadata: metadata,
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			}
		})
	};
}

describe('readNarInfoProjection', () => {
	it('binds metadata to the actual full path and NAR body without requiring a new metadata field', async () => {
		expect(await readNarInfoProjection(projection())).toStrictEqual({
			metadata,
			storePath: narInfo.storePath.value
		});
	});

	it('retains the body path even when commit metadata is absent, never fabricating a commit', async () => {
		expect(
			await readNarInfoProjection({ ...projection(), customMetadata: {} })
		).toStrictEqual({
			metadata: undefined,
			storePath: narInfo.storePath.value
		});
	});

	it.each(['narHash', 'narUrl'] as const)(
		'rejects a body that disagrees with recorded %s',
		async (field) => {
			const fields = narInfo.toFields();
			const text = NarInfo.fromFields({
				...fields,
				...(field === 'narHash'
					? { narHash: fields.fileHash }
					: { url: 'nar/wrong.nar.zst' })
			}).render();
			const object = projection(text);
			await expect(readNarInfoProjection(object)).rejects.toThrow('disagrees');
		}
	);

	it.each(['malformed', 'utf8', 'path'] as const)(
		'rejects %s bodies',
		async (kind) => {
			const object = projection('not a narinfo');
			if (kind === 'utf8') {
				object.body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array([0xff]));
						controller.close();
					}
				});
			} else if (kind === 'path') {
				object.body = projection(
					narInfo
						.render()
						.replace(narInfo.storePath.value, '/nix/store/not-a-store-path')
				).body;
			}
			await expect(readNarInfoProjection(object)).rejects.toThrow();
		}
	);

	it.each([5000, 10_000])(
		'reads %s admitted maximum-length references beyond the independent metadata cap',
		async (count) => {
			const references = Array.from(
				{ length: count },
				(_, index) => `${String(index).padStart(32, '0')}-${'r'.repeat(211)}`
			);
			const text = NarInfo.fromFields({
				...narInfo.toFields(),
				references
			}).render();
			expect(utf8.encode(text).byteLength).toBeGreaterThan(
				cacheMetadataMaxNarInfoBytes
			);
			expect(await readNarInfoProjection(projection(text))).toStrictEqual({
				metadata,
				storePath: narInfo.storePath.value
			});
		}
	);

	it('includes persisted UTF-8 text and repeated signature line overhead rather than today’s ingest caps', async () => {
		const persistedText = '界'.repeat(2000);
		const sigs = [
			...Array.from({ length: 10_000 }, () => ''),
			'界'.repeat(652_000)
		];
		const row = {
			storePath: narInfo.storePath.value,
			narHash: narInfo.narHash.toString(),
			narSize: narInfo.narSize,
			referencesJson: '[]',
			deriver: persistedText,
			ca: persistedText,
			sigsJson: JSON.stringify(sigs)
		};
		const rowValueBytes = Object.values(row).reduce<number>(
			(bytes, value) => bytes + utf8.encode(String(value)).byteLength,
			0
		);
		// Leaves room for SQLite record headers and the other small row columns.
		expect(rowValueBytes).toBeLessThan(1_999_000);
		const signatureRenderBytes = utf8.encode(
			sigs.map((sig) => `Sig: ${sig}\n`).join('')
		).byteLength;
		expect(signatureRenderBytes).toBeGreaterThan(2_000_000);
		const text = NarInfo.fromFields({
			...narInfo.toFields(),
			deriver: persistedText,
			ca: persistedText,
			sigs
		}).render();
		expect(await readNarInfoProjection(projection(text))).toStrictEqual({
			metadata,
			storePath: narInfo.storePath.value
		});
	});

	it.each([false, true])(
		'accepts the exact internal byte boundary with split UTF-8=%s',
		async (split) => {
			const base = narInfo.render();
			const remaining =
				narInfoProjectionMaxBytes - utf8.encode(`${base}Sig: \n`).byteLength;
			const text = `${base}Sig: ${'界'.repeat(Math.floor(remaining / 3))}${'x'.repeat(remaining % 3)}\n`;
			const object = projection(text);
			expect(object.size).toBe(narInfoProjectionMaxBytes);
			if (split) {
				const bytes = utf8.encode(text);
				const offset = utf8.encode(`${base}Sig: `).byteLength + 1;
				object.body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(bytes.subarray(0, offset));
						controller.enqueue(bytes.subarray(offset));
						controller.close();
					}
				});
			}
			expect(await readNarInfoProjection(object)).toStrictEqual({
				metadata,
				storePath: narInfo.storePath.value
			});
		}
	);

	it('cancels oversized advertised bodies before reading', async () => {
		const cancel = vi.fn();
		const object = {
			...projection(),
			size: narInfoProjectionMaxBytes + 1,
			body: new ReadableStream<Uint8Array>({ cancel })
		};
		await expect(readNarInfoProjection(object)).rejects.toThrow('byte limit');
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('enforces the byte bound while streaming even if the advertised size is wrong', async () => {
		const cancel = vi.fn();
		const object = {
			...projection(),
			size: 1,
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(narInfoProjectionMaxBytes));
					controller.enqueue(new Uint8Array(1));
				},
				cancel
			})
		};
		await expect(readNarInfoProjection(object)).rejects.toThrow('byte limit');
		expect(cancel).toHaveBeenCalledOnce();
		expect(object.body.locked).toBe(false);
	});

	it('preserves provider body failures as failures, not absence', async () => {
		const failure = new Error('provider body failed');
		const object = {
			...projection(),
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(failure);
				}
			})
		};
		await expect(readNarInfoProjection(object)).rejects.toBe(failure);
		expect(object.body.locked).toBe(false);
	});
});
