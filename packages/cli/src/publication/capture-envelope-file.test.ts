import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	initialPublicationCaptureCheckpoint,
	publicationCaptureBindingSchema,
	publicationCaptureCheckpointSchema,
	publicationCaptureEnvelopeSchema
} from '@cupboard/protocol/publication-workflow';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
	PublicationFileOwnershipError,
	withCaptureEnvelopeFile
} from './capture-envelope-file.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return { ...actual, open: vi.fn(actual.open), rmdir: vi.fn(actual.rmdir) };
});

const target = {
	tenantUrl: new URL('https://cupboard.example.workers.dev/t/acme'),
	cache: { kind: 'default' as const }
};
const member = {
	storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
	narHash: `sha256:${'0'.repeat(52)}`,
	generation: 1
};
const binding = publicationCaptureBindingSchema.parse({
	invocation: 'a'.repeat(64),
	tenantUrl: target.tenantUrl.href,
	cache: target.cache,
	input: {
		result: member,
		members: [member],
		origin: 'build-selection',
		requestId: '33333333-3333-4333-8333-333333333333'
	}
});
const initial = initialPublicationCaptureCheckpoint(binding);
const envelope = publicationCaptureEnvelopeSchema.parse({
	version: 1,
	request: { operation: 'capture', input: binding.input },
	checkpoint: initial
});
const resolved = publicationCaptureCheckpointSchema.parse({
	...initial,
	state: {
		phase: 'resolved',
		capture: {
			result: { ...member, cache: target.cache, cacheGeneration: 1 },
			begin: {
				result: member,
				expectedCacheGeneration: 1,
				requestId: binding.input.requestId,
				origin: 'build-selection',
				memberCount: 1
			},
			pages: [[member]]
		}
	}
});

afterEach(() => vi.restoreAllMocks());
async function fixture() {
	const directory = await fs.mkdtemp(
		path.join(tmpdir(), 'cupboard-envelope-file-')
	);
	onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
	const file = path.join(directory, 'capture.json');
	await fs.writeFile(file, JSON.stringify(envelope), { mode: 0o600 });
	return {
		file,
		read: async () =>
			publicationCaptureEnvelopeSchema.parse(
				JSON.parse(await fs.readFile(file, 'utf8'))
			)
	};
}

describe('capture-envelope-file', () => {
	it('reopens the complete envelope for load and CAS, durably changes only its checkpoint and rejects stale saves', async () => {
		const f = await fixture();
		await withCaptureEnvelopeFile(f.file, target, async (actual, context) => {
			expect(actual).toEqual(envelope);
			const capture = context.capture;
			if (capture === undefined) {
				throw new Error('Expected capture context');
			}
			expect(await capture.store.load()).toEqual(initial);
			await capture.store.save(initial, resolved);
			expect(await f.read()).toEqual({ ...envelope, checkpoint: resolved });
			expect(await capture.store.load()).toEqual(resolved);
			await expect(capture.store.save(initial, resolved)).rejects.toThrow(
				'changed'
			);
		});
		const inspection1 = await fs.stat(f.file);
		expect(inspection1.mode & 0o777).toBe(0o600);
		await expect(fs.stat(`${f.file}.publication-lock`)).rejects.toHaveProperty(
			'code',
			'ENOENT'
		);
	});
	it('fails closed on missing expected files rather than manufacturing unresolved state', async () => {
		const f = await fixture();
		await withCaptureEnvelopeFile(
			f.file,
			target,
			async (_envelope, context) => {
				const capture = context.capture;
				if (capture === undefined) {
					throw new Error('Expected capture context');
				}
				await fs.rm(f.file);
				await expect(capture.store.load()).rejects.toHaveProperty(
					'code',
					'ENOENT'
				);
				await expect(
					capture.store.save(initial, resolved)
				).rejects.toHaveProperty('code', 'ENOENT');
			}
		);
		await expect(fs.stat(f.file)).rejects.toHaveProperty('code', 'ENOENT');
	});
	it('refuses simultaneous and lock-left writers without releasing the other owner', async () => {
		const f = await fixture();
		await withCaptureEnvelopeFile(f.file, target, async () => {
			await expect(
				withCaptureEnvelopeFile(f.file, target, () => Promise.resolve())
			).rejects.toBeInstanceOf(PublicationFileOwnershipError);
			const lockInspection1 = await fs.stat(`${f.file}.publication-lock`);
			expect(lockInspection1.isDirectory()).toBe(true);
		});
		await fs.mkdir(`${f.file}.publication-lock`);
		await expect(
			withCaptureEnvelopeFile(f.file, target, () => Promise.resolve())
		).rejects.toThrow('verify that the original writer is inactive');
		const lockInspection2 = await fs.stat(`${f.file}.publication-lock`);
		expect(lockInspection2.isDirectory()).toBe(true);
		expect(await f.read()).toEqual(envelope);
	});
	it.each(['binding', 'request', 'corrupt'])(
		'refuses %s changes on actual file reopen',
		async (kind) => {
			const f = await fixture();
			await withCaptureEnvelopeFile(
				f.file,
				target,
				async (_envelope, context) => {
					const capture = context.capture;
					if (capture === undefined) {
						throw new Error('Expected capture context');
					}
					const changed =
						kind === 'binding'
							? {
									...envelope,
									checkpoint: {
										...initial,
										binding: { ...binding, invocation: 'b'.repeat(64) }
									}
								}
							: { ...envelope, request: { operation: 'lookup', input: {} } };
					await fs.writeFile(
						f.file,
						kind === 'corrupt' ? 'bad json' : JSON.stringify(changed)
					);
					await expect(capture.store.load()).rejects.toBeDefined();
					await expect(
						capture.store.save(initial, resolved)
					).rejects.toBeDefined();
				}
			);
		}
	);
	it.each(['write', 'sync', 'directory-sync'] as const)(
		'propagates %s failure and reloads the uncertain persisted outcome on retry',
		async (boundary) => {
			const f = await fixture();
			const failure = new Error(boundary);
			const actualFs =
				await vi.importActual<typeof import('node:fs/promises')>(
					'node:fs/promises'
				);
			const originalOpen = actualFs.open;
			const spy = vi
				.spyOn(fs, 'open')
				.mockImplementation(async (file, flags, mode) => {
					const handle = await originalOpen(file, flags, mode);
					if (
						boundary === 'directory-sync'
							? file === path.dirname(f.file)
							: String(file).startsWith(`${f.file}.`)
					) {
						if (boundary === 'write') {
							vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(failure);
						} else {
							vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
						}
					}
					return handle;
				});
			await expect(
				withCaptureEnvelopeFile(f.file, target, async (_envelope, context) => {
					const capture = context.capture;
					if (capture === undefined) {
						throw new Error('Expected capture context');
					}
					await capture.store.save(initial, resolved);
				})
			).rejects.toBe(failure);
			spy.mockRestore();
			const expected = boundary === 'directory-sync' ? resolved : initial;
			expect(await f.read()).toEqual({ ...envelope, checkpoint: expected });
			await withCaptureEnvelopeFile(
				f.file,
				target,
				async (_envelope, context) => {
					expect(await context.capture?.store.load()).toEqual(expected);
				}
			);
		}
	);
	it('releases ownership after cancellation and preserves the primary error if release fails too', async () => {
		const f = await fixture();
		const controller = new AbortController();
		const primary = new Error('authority refused');
		const releaseFailure = new Error('release failed');
		const didWriteDiagnostic = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(() => true);
		vi.spyOn(fs, 'rmdir').mockRejectedValueOnce(releaseFailure);
		await expect(
			withCaptureEnvelopeFile(
				f.file,
				target,
				() => {
					controller.abort(primary);
					controller.signal.throwIfAborted();
					return Promise.resolve();
				},
				controller.signal
			)
		).rejects.toBe(primary);
		expect(didWriteDiagnostic).toHaveBeenCalledWith(
			`Could not release publication file ownership '${f.file}.publication-lock': Error: release failed\n`
		);
		expect(await f.read()).toEqual(envelope);
		const lockInspection3 = await fs.stat(`${f.file}.publication-lock`);
		expect(lockInspection3.isDirectory()).toBe(true);
	});
	it('does not conceal failed ownership release after successful work', async () => {
		const f = await fixture();
		const failure = new Error('release failed');
		vi.spyOn(fs, 'rmdir').mockRejectedValueOnce(failure);
		await expect(
			withCaptureEnvelopeFile(f.file, target, () => Promise.resolve())
		).rejects.toBe(failure);
	});
});
