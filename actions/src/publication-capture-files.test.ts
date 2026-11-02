import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
	initialPublicationCaptureCheckpoint,
	publicationCaptureBindingSchema,
	publicationCaptureEnvelopeSchema
} from '@cupboard/protocol/publication-workflow';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
	PublicationFileOwnershipError as HiddenPublicationFileOwnershipError,
	withCaptureEnvelopeFile
} from '../../packages/cli/src/publication/capture-envelope-file.ts';

import {
	acquirePublicationFile,
	PublicationFileOwnershipError,
	syncPublicationCaptureFile,
	withPublicationCaptureFile,
	writePublicationStateFile
} from './publication-capture-files.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return { ...actual, open: vi.fn(actual.open), rmdir: vi.fn(actual.rmdir) };
});
afterEach(() => vi.restoreAllMocks());
async function fixture() {
	const directory = await fs.mkdtemp(
		path.join(tmpdir(), 'cupboard-capture-files-')
	);
	onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
	return { directory, file: path.join(directory, 'capture.json') };
}

describe('publication-capture-files', () => {
	it('uses exactly the hidden command file domain for action initialisation and retirement exclusion', async () => {
		const f = await fixture();
		const target = {
			tenantUrl: new URL('https://cupboard.example.workers.dev/t/acme'),
			cache: { kind: 'default' as const }
		};
		const binding = publicationCaptureBindingSchema.parse({
			invocation: 'a'.repeat(64),
			tenantUrl: target.tenantUrl.href,
			cache: target.cache,
			input: {
				result: {
					storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
				},
				members: [
					{ storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app' }
				],
				origin: 'build-selection',
				requestId: '33333333-3333-4333-8333-333333333333'
			}
		});
		const envelope = publicationCaptureEnvelopeSchema.parse({
			version: 1,
			request: { operation: 'capture', input: binding.input },
			checkpoint: initialPublicationCaptureCheckpoint(binding)
		});
		await writePublicationStateFile(f.file, JSON.stringify(envelope), true);
		await withCaptureEnvelopeFile(f.file, target, async () => {
			await expect(
				withPublicationCaptureFile(f.file, () => Promise.resolve())
			).rejects.toBeInstanceOf(PublicationFileOwnershipError);
		});
		await withPublicationCaptureFile(f.file, async () => {
			await expect(
				withCaptureEnvelopeFile(f.file, target, () => Promise.resolve())
			).rejects.toBeInstanceOf(HiddenPublicationFileOwnershipError);
		});
		expect(JSON.parse(await fs.readFile(f.file, 'utf8'))).toEqual(envelope);
	});

	it('excludes an actual second Node process and never releases another acquired or crash-left directory', async () => {
		const f = await fixture();
		const release = await acquirePublicationFile(f.file);
		const ownerDirectory = await fs.stat(`${f.file}.publication-lock`);
		expect(ownerDirectory.mode & 0o777).toBe(0o700);
		const child = await promisify(execFile)(process.execPath, [
			'--input-type=module',
			'-e',
			`import {mkdir} from 'node:fs/promises'; try { await mkdir(process.argv[1]); process.exitCode=1; } catch(error) { if(error.code!=='EEXIST') throw error; process.stdout.write('held'); }`,
			`${f.file}.publication-lock`
		]);
		expect(child.stdout).toBe('held');
		await expect(acquirePublicationFile(f.file)).rejects.toBeInstanceOf(
			PublicationFileOwnershipError
		);
		const lockInspection1 = await fs.stat(`${f.file}.publication-lock`);
		expect(lockInspection1.isDirectory()).toBe(true);
		await release();
		await release();
		await fs.mkdir(`${f.file}.publication-lock`);
		await expect(acquirePublicationFile(f.file)).rejects.toThrow(
			'verify the original writer is inactive'
		);
		const lockInspection2 = await fs.stat(`${f.file}.publication-lock`);
		expect(lockInspection2.isDirectory()).toBe(true);
	});
	it('checks cancellation before acquisition and releases acquired ownership after cancellation', async () => {
		const f = await fixture();
		const controller = new AbortController();
		const failure = new Error('cancelled');
		await expect(
			withPublicationCaptureFile(
				f.file,
				() => {
					controller.abort(failure);
					controller.signal.throwIfAborted();
					return Promise.resolve();
				},
				controller.signal
			)
		).rejects.toBe(failure);
		await expect(fs.stat(`${f.file}.publication-lock`)).rejects.toHaveProperty(
			'code',
			'ENOENT'
		);
		await expect(
			acquirePublicationFile(f.file, controller.signal)
		).rejects.toBe(failure);
		await expect(fs.stat(`${f.file}.publication-lock`)).rejects.toHaveProperty(
			'code',
			'ENOENT'
		);
	});
	it('durably creates a private capture file exclusively and does not overwrite it on reinitialisation', async () => {
		const f = await fixture();
		await writePublicationStateFile(f.file, 'original', true);
		await expect(
			writePublicationStateFile(f.file, 'fresh', true)
		).rejects.toHaveProperty('code', 'EEXIST');
		expect(await fs.readFile(f.file, 'utf8')).toBe('original');
		const inspection1 = await fs.stat(f.file);
		expect(inspection1.mode & 0o777).toBe(0o600);
		await syncPublicationCaptureFile(f.file);
		await writePublicationStateFile(f.file, 'updated');
		expect(await fs.readFile(f.file, 'utf8')).toBe('updated');
	});
	it.each(['write', 'file-sync', 'directory-sync'] as const)(
		'does not hide %s failure or reset its uncertain file outcome',
		async (boundary) => {
			const f = await fixture();
			const failure = new Error(boundary);
			const actual =
				await vi.importActual<typeof import('node:fs/promises')>(
					'node:fs/promises'
				);
			vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
				const handle = await actual.open(file, flags, mode);
				if (file === (boundary === 'directory-sync' ? f.directory : f.file)) {
					if (boundary === 'write') {
						vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(failure);
					} else {
						vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
					}
				}
				return handle;
			});
			await expect(
				writePublicationStateFile(f.file, 'intent', true)
			).rejects.toBe(failure);
			expect(await fs.readFile(f.file, 'utf8')).toBe(
				boundary === 'write' ? '' : 'intent'
			);
			await expect(
				writePublicationStateFile(f.file, 'reset', true)
			).rejects.toHaveProperty('code', 'EEXIST');
		}
	);
	it('preserves and reports a primary failure when release also fails, and refuses false success', async () => {
		const f = await fixture();
		const primary = new Error('authority refused');
		const secondary = new Error('release failed');
		vi.spyOn(fs, 'rmdir').mockRejectedValue(secondary);
		const didWriteDiagnostic = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(() => true);
		await expect(
			withPublicationCaptureFile(f.file, () => Promise.reject(primary))
		).rejects.toBe(primary);
		expect(didWriteDiagnostic).toHaveBeenCalledWith(
			`Could not release publication file ownership '${f.file}.publication-lock': Error: release failed\n`
		);
		const lockInspection3 = await fs.stat(`${f.file}.publication-lock`);
		expect(lockInspection3.isDirectory()).toBe(true);
		const other = path.join(f.directory, 'other.json');
		await expect(
			withPublicationCaptureFile(other, () => Promise.resolve())
		).rejects.toBe(secondary);
	});
});
