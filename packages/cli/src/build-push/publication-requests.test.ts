import { createHash } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startCapture } from '@cupboard/logger/testing';
import { cacheNameSchema, storePathSchema } from '@cupboard/nix-store/scalars';
import {
	isFreshPublicationRequestId,
	publicationSourceSelectorSchema,
	recordedPublicationSchema
} from '@cupboard/protocol/publication-manifests';
import {
	publicationCaptureCheckpointSchema,
	type PublicationWorkflowRequest
} from '@cupboard/protocol/publication-workflow';
import { expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';

import { BuildPublicationFailedError, ScopeForbiddenError } from '../errors.ts';
import { classifyPublicationFailures } from '../exit-code.ts';

import { PublicationRecoveryError } from './publication-recovery-error.ts';
import {
	assertPublicationRequestsRecovery,
	completePublicationRequests,
	publicationRequests,
	publicationRequestsCompletionFile
} from './publication-requests.ts';

const disk = vi.hoisted(() => ({
	rename: vi.fn<typeof import('node:fs/promises').rename>(),
	open: vi.fn<typeof import('node:fs/promises').open>(),
	remove: vi.fn<typeof import('node:fs/promises').rm>()
}));
vi.mock('node:fs/promises', async (original) => {
	const fs = await original<typeof import('node:fs/promises')>();
	disk.rename.mockImplementation(fs.rename);
	disk.open.mockImplementation(fs.open);
	disk.remove.mockImplementation(fs.rm);
	return { ...fs, rename: disk.rename, open: disk.open, rm: disk.remove };
});

async function fixture() {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-publication-requests-')
	);
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const receipt = path.join(directory, 'receipt.json');
	const file = `${receipt}.publication-requests.json`;
	return {
		receipt,
		file,
		completed: publicationRequestsCompletionFile(receipt)
	};
}

it('recovers existing uncompleted sidecar maps unchanged, and starts a new event only after command completion', async () => {
	const f = await fixture();
	const first = await publicationRequests(f.receipt);
	const capture = await first('capture');
	expect(isFreshPublicationRequestId(capture, new Date())).toBe(true);
	const ensure = await first('ensure');
	const contents = await readFile(f.file, 'utf8');
	const recovery = await publicationRequests(f.receipt);
	expect(await recovery('capture')).toBe(capture);
	expect(await recovery('ensure')).toBe(ensure);
	expect(await readFile(f.file, 'utf8')).toBe(contents);
	await completePublicationRequests(f.receipt, [f.file]);
	const next = await publicationRequests(f.receipt);
	expect(await next('capture')).not.toBe(capture);
	expect(await next('ensure')).not.toBe(ensure);
});

it('does not mark recovery state completed on cancellation', async () => {
	const f = await fixture();
	const first = await publicationRequests(f.receipt);
	const id = await first('ensure');
	const controller = new AbortController();
	const reason = new Error('interrupted');
	controller.abort(reason);
	await expect(
		completePublicationRequests(f.receipt, [f.file], controller.signal)
	).rejects.toBe(reason);
	expect(await (await publicationRequests(f.receipt))('ensure')).toBe(id);
});

it.each([
	{ target: 'requests', contents: 'null' },
	{
		target: 'requests',
		contents: JSON.stringify({ ['a'.repeat(64)]: 'invalid-uuid' })
	},
	{ target: 'completed', contents: 'null' },
	{
		target: 'completed',
		contents: JSON.stringify({
			version: 1,
			files: { file: 'invalid-fingerprint' }
		})
	}
])(
	'rejects schema-invalid $target state rather than resetting recovery',
	async ({ target, contents }) => {
		const f = await fixture();
		await (
			await publicationRequests(f.receipt)
		)('ensure');
		await completePublicationRequests(f.receipt, [f.file]);
		await writeFile(target === 'requests' ? f.file : f.completed, contents);
		await expect(publicationRequests(f.receipt)).rejects.toBeDefined();
	}
);

it('persists the complete immutable ensure intent before use and rejects replacement input for the same target', async () => {
	const f = await fixture();
	const source = recordedPublicationSchema.parse({
		result: {
			storePath: `/nix/store/${'1'.repeat(32)}-app`,
			narHash: `sha256:${'0'.repeat(52)}`,
			generation: 1,
			cache: { kind: 'default' },
			cacheGeneration: 1
		},
		digest: 'a'.repeat(64),
		memberCount: 2,
		origin: 'build-selection'
	});
	const request = {
		operation: 'ensure' as const,
		input: {
			source,
			sourceSelector: publicationSourceSelectorSchema.parse({
				view: 'release',
				expectedRevision: 7
			})
		}
	};
	const journal = await publicationRequests(
		f.receipt,
		undefined,
		undefined,
		'invocation'
	);
	const intent = await journal.intent(request);
	const contents = await readFile(f.file, 'utf8');
	const persisted = z
		.object({ intents: z.record(z.string(), z.unknown()) })
		.parse(JSON.parse(contents));
	expect(Object.values(persisted.intents)).toEqual([intent]);
	const recovery = await publicationRequests(
		f.receipt,
		undefined,
		undefined,
		'invocation'
	);
	expect(await recovery.intent(request)).toEqual(intent);
	await expect(
		recovery.intent({
			...request,
			input: {
				...request.input,
				sourceSelector: publicationSourceSelectorSchema.parse({
					view: 'release',
					expectedRevision: 8
				})
			}
		})
	).rejects.toThrow('input changed');
	expect(await readFile(f.file, 'utf8')).toEqual(contents);
	await expect(
		publicationRequests(f.receipt, undefined, undefined, 'different invocation')
	).rejects.toThrow('different invocation');
});

it('preserves ambiguous legacy UUID bytes and refuses to replace them with fresh recovery state', async () => {
	const f = await fixture();
	const { createHash } = await import('node:crypto');
	const key = createHash('sha256').update('ensure').digest('hex');
	const id = '33333333-3333-4333-8333-333333333333';
	await writeFile(f.file, JSON.stringify({ [key]: id }));
	const contents = await readFile(f.file, 'utf8');
	await expect(publicationRequests(f.receipt)).rejects.toThrow(
		'lacks immutable invocation inputs'
	);
	expect(await readFile(f.file, 'utf8')).toBe(contents);
	await expect(
		publicationRequests(f.receipt, undefined, undefined, 'invocation')
	).rejects.toThrow('lacks immutable invocation inputs');
});

it('checks unfinished single and sparse cohort journals even after the command shape changes', async () => {
	const f = await fixture();
	const cohortFile = `${f.receipt}.cohort-7.publication-requests.json`;
	await publicationRequests(
		f.receipt,
		cohortFile,
		f.completed,
		'cohort',
		'whole-command'
	);
	await expect(assertPublicationRequestsRecovery(f.receipt)).rejects.toThrow(
		'unfinished publication'
	);
	await expect(
		assertPublicationRequestsRecovery(f.receipt, 'changed-command')
	).rejects.toThrow('different invocation');
	await assertPublicationRequestsRecovery(f.receipt, 'whole-command');
	await completePublicationRequests(f.receipt, [cohortFile]);
	await assertPublicationRequestsRecovery(f.receipt);
	await assertPublicationRequestsRecovery(f.receipt, 'changed-command');
	await publicationRequests(
		f.receipt,
		undefined,
		f.completed,
		'next-cohort',
		'next-command'
	);
	await expect(assertPublicationRequestsRecovery(f.receipt)).rejects.toThrow(
		'unfinished publication'
	);
});

it('does not guess whole-command identity for unfinished older journals', async () => {
	const f = await fixture();
	await publicationRequests(f.receipt, undefined, f.completed, 'old-binding');
	await expect(
		assertPublicationRequestsRecovery(f.receipt, 'whole-command')
	).rejects.toThrow('different invocation');
});

it.each(['requests', 'completed'])(
	'recovery introspection validates completed %s and propagates non-ENOENT errors',
	async (target) => {
		const f = await fixture();
		await (
			await publicationRequests(f.receipt)
		)('ensure');
		await completePublicationRequests(f.receipt, [f.file]);
		const file = target === 'requests' ? f.file : f.completed;
		await writeFile(file, 'null');
		await expect(
			assertPublicationRequestsRecovery(f.receipt)
		).rejects.toBeDefined();
		await rm(file);
		await mkdir(file);
		await expect(
			assertPublicationRequestsRecovery(f.receipt)
		).rejects.toMatchObject({ code: 'EISDIR' });
	}
);

it('only ignores missing recovery files and unrelated directory entries', async () => {
	const f = await fixture();
	await assertPublicationRequestsRecovery(path.join(f.receipt, 'absent.json'));
	await writeFile(
		`${f.receipt}.cohort-other.publication-requests.json`,
		'invalid json'
	);
	await writeFile(
		`${f.receipt}.other.publication-requests.json`,
		'invalid json'
	);
	await assertPublicationRequestsRecovery(f.receipt);
});

const destination = {
	tenantUrl: 'https://cupboard.example.workers.dev/t/acme',
	cache: { kind: 'default' as const }
};
const winner = recordedPublicationSchema.parse({
	result: {
		storePath: `/nix/store/${'1'.repeat(32)}-app`,
		narHash: `sha256:${'0'.repeat(52)}`,
		generation: 1,
		cache: destination.cache,
		cacheGeneration: 1
	},
	digest: 'a'.repeat(64),
	memberCount: 1,
	origin: 'build-selection'
});
const captureRequest: Extract<
	PublicationWorkflowRequest,
	{ operation: 'capture' }
> = {
	operation: 'capture' as const,
	input: {
		result: {
			storePath: winner.result.storePath,
			narHash: winner.result.narHash
		},
		members: [
			{ storePath: winner.result.storePath, narHash: winner.result.narHash }
		],
		origin: 'build-selection' as const
	}
};

async function captureFixture() {
	const f = await fixture();
	const journal = await publicationRequests(
		f.receipt,
		undefined,
		undefined,
		'native-invocation',
		'whole-command'
	);
	await journal.snapshot('selection', z.string(), () =>
		Promise.resolve('original selection')
	);
	const request = await journal.intent(captureRequest, destination);
	const context = await journal.captureContext(request);
	if (context?.capture === undefined) {
		throw new Error('Expected durable native capture');
	}
	const checkpoint = publicationCaptureCheckpointSchema.parse(
		await context.capture.store.load()
	);
	return { ...f, journal, request, recovery: context.capture, checkpoint };
}

it('atomically persists the exact outer intent and explicit unresolved checkpoint with genuine invocation and destination', async () => {
	const f = await captureFixture();
	const invocation = createHash('sha256')
		.update('native-invocation')
		.digest('hex');
	expect(JSON.parse(await readFile(f.file, 'utf8'))).toEqual({
		version: 3,
		invocation,
		requests: {
			[createHash('sha256')
				.update(JSON.stringify(['capture', captureRequest.input]))
				.digest('hex')]: f.request.input.requestId
		},
		snapshots: {
			'command-invocation': 'whole-command',
			selection: 'original selection'
		},
		intents: {
			[JSON.stringify(['capture', winner.result.storePath])]: f.request
		},
		captures: {
			[String(f.request.input.requestId)]: {
				version: 1,
				binding: { invocation, ...destination, input: f.request.input },
				state: { phase: 'unresolved' }
			}
		}
	});
	expect(f.checkpoint).toEqual({
		version: 1,
		binding: { invocation, ...destination, input: f.request.input },
		state: { phase: 'unresolved' }
	});
	expect(await filesystem.readdir(path.dirname(f.file))).toEqual([
		path.basename(f.file)
	]);
});

it.each([
	'missing-map-entry',
	'corrupt-checkpoint',
	'missing-journal',
	'invalid-json'
] as const)(
	'never manufactures unresolved recovery for an expected %s',
	async (failure) => {
		const f = await captureFixture();
		if (failure === 'missing-journal') {
			await rm(f.file);
		} else if (failure === 'invalid-json') {
			await writeFile(f.file, '{');
		} else {
			const data = z
				.object({ captures: z.record(z.string(), z.unknown()) })
				.loose()
				.parse(JSON.parse(await readFile(f.file, 'utf8')));
			if (failure === 'missing-map-entry') {
				data.captures = {};
			} else {
				data.captures[String(f.request.input.requestId)] = {
					...f.checkpoint,
					state: { phase: 'invented' }
				};
			}
			await writeFile(f.file, JSON.stringify(data));
		}
		const bytes =
			failure === 'missing-journal'
				? undefined
				: await readFile(f.file, 'utf8');
		await expect(f.recovery.store.load()).rejects.toBeInstanceOf(
			PublicationRecoveryError
		);
		await expect(
			f.recovery.store.save(f.checkpoint, {
				...f.checkpoint,
				state: { phase: 'shortcut', publication: winner }
			})
		).rejects.toBeInstanceOf(PublicationRecoveryError);
		if (failure === 'missing-journal') {
			await expect(readFile(f.file)).rejects.toThrow();
		} else {
			expect(await readFile(f.file, 'utf8')).toBe(bytes);
		}
	}
);

it('CAS compares the whole persisted record, rejects stale transitions and preserves other live owner updates', async () => {
	const f = await captureFixture();
	const other = await publicationRequests(
		f.receipt,
		undefined,
		undefined,
		'native-invocation',
		'whole-command'
	);
	await other.snapshot('later-result', z.string(), () =>
		Promise.resolve('keep this later result')
	);
	const secondRequest = await other.intent(
		{
			...captureRequest,
			input: {
				...captureRequest.input,
				result: {
					...captureRequest.input.result,
					storePath: storePathSchema.parse(
						winner.result.storePath.replace('-app', '-second')
					)
				},
				members: [
					{
						...captureRequest.input.members[0],
						storePath: storePathSchema.parse(
							winner.result.storePath.replace('-app', '-second')
						)
					}
				]
			}
		},
		destination
	);
	const secondContext = await other.captureContext(secondRequest);
	if (secondContext?.capture === undefined) {
		throw new Error('Expected second durable record');
	}
	const next = publicationCaptureCheckpointSchema.parse({
		...f.checkpoint,
		state: { phase: 'shortcut', publication: winner }
	});
	await f.recovery.store.save(f.checkpoint, next);
	expect(await f.recovery.store.load()).toEqual(next);
	const bytes = await readFile(f.file, 'utf8');
	await expect(f.recovery.store.save(f.checkpoint, next)).rejects.toThrow(
		'Stale capture checkpoint compare-and-swap'
	);
	await expect(f.recovery.store.save(next, f.checkpoint)).rejects.toThrow();
	expect(await readFile(f.file, 'utf8')).toBe(bytes);
	expect(
		await other.snapshot('later-result', z.string(), () => {
			throw new Error('Already durable');
		})
	).toBe('keep this later result');
	expect(await secondContext.capture.store.load()).toEqual({
		version: 1,
		binding: { ...f.checkpoint.binding, input: secondRequest.input },
		state: { phase: 'unresolved' }
	});
	await expect(
		publicationRequests(f.receipt, undefined, undefined, 'changed-invocation')
	).rejects.toThrow('different invocation');
	expect(await readFile(f.file, 'utf8')).toBe(bytes);
});

it('refuses an actually owned file rather than performing a blind compare/rename', async () => {
	const f = await captureFixture();
	const bytes = await readFile(f.file, 'utf8');
	await mkdir(`${f.file}.lock`);
	await expect(
		f.recovery.store.save(f.checkpoint, {
			...f.checkpoint,
			state: { phase: 'shortcut', publication: winner }
		})
	).rejects.toThrow('already owned');
	await expect(publicationRequests(f.receipt)).rejects.toThrow('already owned');
	expect(await readFile(f.file, 'utf8')).toBe(bytes);
	await rm(`${f.file}.lock`, { recursive: true });
	expect(await f.recovery.store.load()).toEqual(f.checkpoint);
});

it.each(['before-rename', 'after-rename'] as const)(
	'reloads the real %s write outcome instead of overwriting it from an older owner copy',
	async (boundary) => {
		const f = await captureFixture();
		const next = publicationCaptureCheckpointSchema.parse({
			...f.checkpoint,
			state: { phase: 'shortcut', publication: winner }
		});
		const failure = new Error(`disk failure ${boundary}`);
		const original =
			await vi.importActual<typeof import('node:fs/promises')>(
				'node:fs/promises'
			);
		const originalOpen = original.open;
		if (boundary === 'before-rename') {
			disk.rename.mockRejectedValueOnce(failure);
		} else {
			disk.open.mockImplementation(async (file, flags, mode) => {
				const handle = await originalOpen(file, flags, mode);
				if (file === path.dirname(f.file)) {
					vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
				}
				return handle;
			});
		}
		try {
			await expect(f.recovery.store.save(f.checkpoint, next)).rejects.toBe(
				failure
			);
		} finally {
			disk.rename.mockImplementation(original.rename);
			disk.open.mockImplementation(original.open);
		}
		expect(await f.recovery.store.load()).toEqual(
			boundary === 'before-rename' ? f.checkpoint : next
		);
		await f.journal.snapshot('after-uncertain-write', z.boolean(), () =>
			Promise.resolve(true)
		);
		const reopened = await publicationRequests(
			f.receipt,
			undefined,
			undefined,
			'native-invocation',
			'whole-command'
		);
		const context = await reopened.captureContext(f.request);
		if (context?.capture === undefined) {
			throw new Error('Expected persisted context');
		}
		expect(await context.capture.store.load()).toEqual(
			boundary === 'before-rename' ? f.checkpoint : next
		);
		if (boundary === 'before-rename') {
			await context.capture.store.save(f.checkpoint, next);
		} else {
			await expect(
				context.capture.store.save(f.checkpoint, next)
			).rejects.toThrow('Stale capture');
		}
		expect(await context.capture.store.load()).toEqual(next);
		expect(await filesystem.readdir(path.dirname(f.file))).toEqual([
			path.basename(f.file)
		]);
	}
);

it('does not expose a capture intent if its atomic initial checkpoint write fails', async () => {
	const f = await fixture();
	const journal = await publicationRequests(
		f.receipt,
		undefined,
		undefined,
		'invocation'
	);
	const before = await readFile(f.file, 'utf8');
	const failure = new Error('initial checkpoint could not persist');
	disk.rename.mockRejectedValueOnce(failure);
	await expect(journal.intent(captureRequest, destination)).rejects.toBe(
		failure
	);
	expect(await readFile(f.file, 'utf8')).toBe(before);
	const request = await journal.intent(captureRequest, destination);
	const context = await journal.captureContext(request);
	if (context?.capture === undefined) {
		throw new Error('Expected persisted context');
	}
	expect(await context.capture.store.load()).toEqual({
		version: 1,
		binding: {
			invocation: createHash('sha256').update('invocation').digest('hex'),
			...destination,
			input: request.input
		},
		state: { phase: 'unresolved' }
	});
});

it.each(['capture-intent', 'allocated-id'] as const)(
	'fails closed on unfinished old v2 %s and only accepts it after exact whole-command completion',
	async (kind) => {
		const f = await fixture();
		const id = '33333333-3333-4333-8333-333333333333';
		const key = createHash('sha256')
			.update(JSON.stringify(['capture', captureRequest.input]))
			.digest('hex');
		const old = {
			version: 2,
			invocation: createHash('sha256').update('invocation').digest('hex'),
			requests: { [key]: id },
			snapshots: { 'command-invocation': 'whole-command' },
			intents:
				kind === 'capture-intent'
					? {
							[JSON.stringify(['capture', winner.result.storePath])]: {
								...captureRequest,
								input: { ...captureRequest.input, requestId: id }
							}
						}
					: {}
		};
		await writeFile(f.file, JSON.stringify(old));
		const bytes = await readFile(f.file, 'utf8');
		await expect(
			publicationRequests(f.receipt, undefined, undefined, 'invocation')
		).rejects.toBeInstanceOf(PublicationRecoveryError);
		await expect(
			assertPublicationRequestsRecovery(f.receipt, 'whole-command')
		).rejects.toBeInstanceOf(PublicationRecoveryError);
		expect(await readFile(f.file, 'utf8')).toBe(bytes);
		await completePublicationRequests(f.receipt, [f.file]);
		await assertPublicationRequestsRecovery(f.receipt, 'new-command');
		const fresh = await publicationRequests(
			f.receipt,
			undefined,
			undefined,
			'new-invocation'
		);
		expect(await fresh('new-request')).not.toBe(id);
		const freshContents: unknown = JSON.parse(await readFile(f.file, 'utf8'));
		expect(z.object({ version: z.number() }).parse(freshContents)).toEqual({
			version: 3
		});
		// Completion never excuses malformed old state, even when its digest matches.
		await writeFile(
			f.file,
			JSON.stringify({ ...old, requests: { [key]: 'invalid-uuid' } })
		);
		await expect(publicationRequests(f.receipt)).rejects.toBeInstanceOf(
			PublicationRecoveryError
		);
	}
);

it.each(['empty', 'ensure-only'] as const)(
	'migrates source-proven no-prior-capture v2 %s without changing immutable identity or inputs',
	async (kind) => {
		const f = await fixture();
		const id = '33333333-3333-4333-8333-333333333333';
		const input = { source: winner };
		const key = createHash('sha256')
			.update(JSON.stringify(['ensure', input]))
			.digest('hex');
		const ensure = {
			operation: 'ensure' as const,
			input: { ...input, requestId: id }
		};
		const old = {
			version: 2,
			invocation: createHash('sha256').update('invocation').digest('hex'),
			requests: kind === 'ensure-only' ? { [key]: id } : {},
			snapshots: { 'command-invocation': 'whole-command', selection: 'kept' },
			intents:
				kind === 'ensure-only'
					? { [JSON.stringify(['ensure', winner.result.storePath])]: ensure }
					: {}
		};
		await writeFile(f.file, JSON.stringify(old));
		await assertPublicationRequestsRecovery(f.receipt, 'whole-command');
		const journal = await publicationRequests(
			f.receipt,
			undefined,
			undefined,
			'invocation',
			'whole-command'
		);
		expect(JSON.parse(await readFile(f.file, 'utf8'))).toEqual({
			...old,
			version: 3,
			captures: {}
		});
		if (kind === 'ensure-only') {
			expect(await journal.intent({ operation: 'ensure', input })).toEqual(
				ensure
			);
		}
		await expect(
			publicationRequests(f.receipt, undefined, undefined, 'changed')
		).rejects.toThrow('different invocation');
	}
);

it('fingerprints the complete native capture map at whole-command completion and detects an earlier checkpoint change', async () => {
	const f = await captureFixture();
	const next = publicationCaptureCheckpointSchema.parse({
		...f.checkpoint,
		state: { phase: 'shortcut', publication: winner }
	});
	await f.recovery.store.save(f.checkpoint, next);
	const before = await readFile(f.file, 'utf8');
	await completePublicationRequests(f.receipt, [f.file]);
	const completedFingerprint = createHash('sha256')
		.update(JSON.stringify(JSON.parse(before)))
		.digest('hex');
	expect(JSON.parse(await readFile(f.completed, 'utf8'))).toEqual({
		version: 1,
		files: { [path.resolve(f.file)]: completedFingerprint }
	});
	await assertPublicationRequestsRecovery(f.receipt);
	const saved = z
		.object({
			captures: z.record(z.string(), publicationCaptureCheckpointSchema)
		})
		.loose()
		.parse(JSON.parse(before));
	saved.captures[String(f.request.input.requestId)] = {
		...next,
		state: {
			phase: 'shortcut',
			publication: {
				...winner,
				digest: recordedPublicationSchema.parse({
					...winner,
					digest: 'b'.repeat(64)
				}).digest
			}
		}
	};
	await writeFile(f.file, JSON.stringify(saved));
	await expect(assertPublicationRequestsRecovery(f.receipt)).rejects.toThrow(
		'unfinished publication'
	);
});

it.each([
	{ label: 'authority', error: new ScopeForbiddenError(), code: 77 },
	{
		label: 'publication',
		error: new BuildPublicationFailedError([], 74),
		code: 74
	},
	{
		label: 'cancellation',
		error: new DOMException('Cancelled', 'AbortError'),
		code: 74
	}
])(
	'preserves the original $label failure and native exit classification when journal lock release also fails',
	async ({ error, code }) => {
		const f = await captureFixture();
		const before = await readFile(f.file, 'utf8');
		const releaseFailure = new Error('ownership release failed');
		const capture = startCapture();
		onTestFinished(() => {
			capture.stop();
		});
		disk.remove.mockRejectedValueOnce(releaseFailure);
		await expect(
			f.journal.snapshot('failed-work', z.string(), () => Promise.reject(error))
		).rejects.toBe(error);
		expect(classifyPublicationFailures([error])).toEqual({
			exitCode: code,
			cause: error
		});
		expect(capture.logs).toEqual([
			{
				level: 'warning',
				category: ['cupboard', 'publication', 'recovery'],
				message: `Publication journal ownership release failed; preserve ${f.file}.lock and verify the original writer is inactive before removing only that lock`,
				properties: { lock: `${f.file}.lock`, error: releaseFailure }
			}
		]);
		expect(await readFile(f.file, 'utf8')).toBe(before);
		expect(await filesystem.readdir(path.dirname(f.file))).toEqual([
			path.basename(f.file),
			`${path.basename(f.file)}.lock`
		]);
		await expect(f.recovery.store.load()).rejects.toThrow('already owned');
	}
);

it('reports failed journal lock release after otherwise successful durable work instead of returning false success', async () => {
	const f = await captureFixture();
	const releaseFailure = new Error('ownership release failed');
	disk.remove.mockRejectedValueOnce(releaseFailure);
	const next = publicationCaptureCheckpointSchema.parse({
		...f.checkpoint,
		state: { phase: 'shortcut', publication: winner }
	});
	const failedSave = f.recovery.store.save(f.checkpoint, next);
	await expect(failedSave).rejects.toEqual(
		new PublicationRecoveryError(
			`Could not release publication journal ownership (${f.file}.lock); verify no writer is running before removing only its lock`,
			{ cause: releaseFailure }
		)
	);
	const captures = z
		.object({
			captures: z.record(z.string(), publicationCaptureCheckpointSchema)
		})
		.parse(JSON.parse(await readFile(f.file, 'utf8'))).captures;
	expect(captures).toEqual({ [String(f.request.input.requestId)]: next });
	expect(await filesystem.readdir(path.dirname(f.file))).toEqual([
		path.basename(f.file),
		`${path.basename(f.file)}.lock`
	]);
	await expect(f.recovery.store.load()).rejects.toThrow('already owned');
});

it.each([
	{
		label: 'tenant URL',
		destination: {
			...destination,
			tenantUrl: 'https://cupboard.example.workers.dev/t/other'
		}
	},
	{
		label: 'cache',
		destination: {
			...destination,
			cache: { kind: 'named' as const, name: cacheNameSchema.parse('other') }
		}
	},
	{ label: 'missing destination', destination: undefined }
])(
	'refuses native capture $label drift without replacing its expected record',
	async ({ destination: changed }) => {
		const f = await captureFixture();
		const before = await readFile(f.file, 'utf8');
		await expect(f.journal.intent(captureRequest, changed)).rejects.toThrow(
			'destination changed'
		);
		expect(await readFile(f.file, 'utf8')).toBe(before);
		expect(await f.recovery.store.load()).toEqual(f.checkpoint);
	}
);

it.each(['origin', 'member', 'result'] as const)(
	'refuses immutable native capture %s drift without changing the selected checkpoint',
	async (field) => {
		const f = await captureFixture();
		const before = await readFile(f.file, 'utf8');
		const changed = structuredClone(captureRequest);
		if (field === 'origin') {
			changed.input.origin = 'legacy-selection';
		} else if (field === 'member') {
			changed.input.members.push({
				storePath: storePathSchema.parse(`/nix/store/${'2'.repeat(32)}-other`)
			});
		} else {
			changed.input.result.narHash = recordedPublicationSchema.parse({
				...winner,
				result: { ...winner.result, narHash: `sha256:${'1'.repeat(52)}` }
			}).result.narHash;
		}
		await expect(f.journal.intent(changed, destination)).rejects.toThrow(
			'input changed'
		);
		expect(await readFile(f.file, 'utf8')).toBe(before);
		expect(await f.recovery.store.load()).toEqual(f.checkpoint);
	}
);
