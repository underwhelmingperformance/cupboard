import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { recordedPublicationSchema } from '@cupboard/protocol/publication-manifests';
import {
	initialPublicationCaptureCheckpoint,
	publicationCaptureBindingSchema,
	publicationCaptureEnvelopeSchema,
	publicationWorkflowRequestSchema
} from '@cupboard/protocol/publication-workflow';
import { uploadCapabilitiesHeader } from '@cupboard/protocol/upload';
import { Command } from 'commander';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { type authenticateForPush } from '../auth/auth.ts';
import { buildProgram } from '../cli.ts';
import { publicationWorkflowFor } from '../publication/publication-client.ts';

import { registerPublicationResultCommand } from './publication-result.ts';

async function requestFile(contents: unknown): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-publication-'));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const file = path.join(directory, 'request.json');
	await writeFile(file, JSON.stringify(contents));
	return file;
}

const request = publicationWorkflowRequestSchema.parse({
	operation: 'lookup',
	input: {
		source: { cache: { kind: 'default' } },
		results: [{ storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app' }]
	}
});

function initialEnvelope() {
	const binding = publicationCaptureBindingSchema.parse({
		invocation: 'a'.repeat(64),
		tenantUrl: 'https://cupboard.example.workers.dev/t/acme',
		cache: { kind: 'default' },
		input: {
			result: { storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app' },
			members: [
				{ storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app' },
				{ storePath: '/nix/store/00000000000000000000000000000000-losing' }
			],
			origin: 'build-selection',
			requestId: '33333333-3333-4333-8333-333333333333'
		}
	});
	return publicationCaptureEnvelopeSchema.parse({
		version: 1,
		request: { operation: 'capture', input: binding.input },
		checkpoint: initialPublicationCaptureCheckpoint(binding)
	});
}

async function executeHiddenFile(file: string, fetcher: typeof fetch) {
	const program = new Command()
		.option('--output-mode <mode>')
		.option('--result-file <path>');
	registerPublicationResultCommand(
		program,
		{},
		{
			authenticate: () =>
				Promise.resolve({
					get: () => Promise.resolve('access-token'),
					refresh: () => Promise.resolve('access-token')
				}),
			fetchCacheAccess: () => Promise.resolve('public'),
			workflowFor: (url, credential, options) =>
				publicationWorkflowFor(url, credential, { ...options, fetcher })
		}
	);
	await program.parseAsync(
		[
			'--output-mode',
			'json',
			'--result-file',
			`${file}.result`,
			'publication-result',
			'https://cupboard.example.workers.dev/t/acme',
			'--request-file',
			file
		],
		{ from: 'user' }
	);
}

describe('publication-result command', () => {
	it.each(
		(['begin', 'page', 'seal'] as const).flatMap((boundary) => [
			{ boundary, isReplacement: true },
			{ boundary, isReplacement: false }
		])
	)(
		'reopens lost $boundary response with immutable requests (replacement $isReplacement; modelled HTTP remote)',
		async ({ boundary, isReplacement }) => {
			const original = recordedPublicationSchema.parse({
				result: {
					storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
					narHash: `sha256:${'0'.repeat(52)}`,
					generation: 1,
					cache: { kind: 'default' },
					cacheGeneration: 1
				},
				digest: 'a'.repeat(64),
				memberCount: 1,
				origin: 'build-selection'
			});
			const capture = publicationWorkflowRequestSchema.parse({
				operation: 'capture',
				input: {
					result: {
						storePath: original.result.storePath,
						narHash: original.result.narHash
					},
					members: [{ storePath: original.result.storePath }],
					origin: original.origin,
					requestId: '33333333-3333-4333-8333-333333333333'
				}
			});
			if (capture.operation !== 'capture') {
				throw new Error('Expected capture fixture');
			}
			const binding = publicationCaptureBindingSchema.parse({
				invocation: 'a'.repeat(64),
				tenantUrl: 'https://cupboard.example.workers.dev/t/acme',
				cache: { kind: 'default' },
				input: capture.input
			});
			const checkpoint = initialPublicationCaptureCheckpoint(binding);
			const envelope = publicationCaptureEnvelopeSchema.parse({
				version: 1,
				request: capture,
				checkpoint
			});
			const file = await requestFile(envelope);
			const operationId = '22222222-2222-4222-8222-222222222222';
			const lost = new Error('capture response lost');
			const controller = new AbortController();
			const calls: { readonly path: string; readonly body: unknown }[] = [];
			let accepted: typeof original | undefined;
			const fetcher: typeof fetch = async (input, init) => {
				const request = new Request(input, init);
				const pathname = new URL(request.url).pathname;
				const text = await request.text();
				const body: unknown = text === '' ? {} : JSON.parse(text);
				calls.push({ path: pathname, body });
				if (pathname.endsWith('/uploads/credential')) {
					return Response.json(
						{
							pushId: 'push-1',
							accessKeyId: 'access',
							secretAccessKey: 'secret',
							sessionToken: 'session',
							endpoint: 'https://r2.test',
							bucket: 'blobs',
							expiresAt: '2099-01-01T00:00:00.000Z'
						},
						{
							headers: {
								[uploadCapabilitiesHeader]: 'publication-manifests-v1'
							}
						}
					);
				}
				if (pathname.endsWith('/publication-results/lookup')) {
					return Response.json({
						entries: [
							accepted === undefined
								? { kind: 'missing', result: original.result }
								: { kind: 'recorded', publication: accepted, complete: true }
						]
					});
				}
				if (pathname.endsWith('/publication-results/captures')) {
					// Model current server generation fencing on the original begin.
					if (accepted !== undefined && accepted.result.generation !== 1) {
						return new Response('identity changed', { status: 409 });
					}
					if (boundary === 'begin') {
						controller.abort(lost);
					}
					return Response.json({
						kind: 'staging',
						operationId,
						expiresAt: '2099-01-01T00:00:00.000Z'
					});
				}
				if (pathname.endsWith('/pages/0')) {
					if (boundary === 'page') {
						controller.abort(lost);
					}
					return Response.json({ operationId, page: 0, acceptedCount: 1 });
				}
				if (pathname.endsWith('/seal')) {
					// The remote completes, but delivery is cancelled before local success.
					accepted = original;
					if (boundary === 'seal') {
						controller.abort(lost);
					}
					return Response.json({
						kind: 'captured',
						association: 'created',
						publication: original
					});
				}
				throw new Error(`Unexpected modelled HTTP request ${pathname}`);
			};
			const authenticate = vi.fn<typeof authenticateForPush>(() =>
				Promise.resolve({
					get: () => Promise.resolve('access-token'),
					refresh: () => Promise.resolve('access-token')
				})
			);
			const invoke = async (signal?: AbortSignal) => {
				const program = new Command()
					.option('--output-mode <mode>')
					.option('--result-file <path>');
				registerPublicationResultCommand(
					program,
					{ signal },
					{
						authenticate,
						fetchCacheAccess: () => Promise.resolve('public'),
						workflowFor: (url, credential, options) =>
							publicationWorkflowFor(url, credential, { ...options, fetcher })
					}
				);
				await program.parseAsync(
					[
						'--output-mode',
						'json',
						'--result-file',
						`${file}.result`,
						'publication-result',
						'https://cupboard.example.workers.dev/t/acme',
						'--request-file',
						file
					],
					{ from: 'user' }
				);
			};
			await expect(invoke(controller.signal)).rejects.toBe(lost);
			expect(accepted).toEqual(boundary === 'seal' ? original : undefined);
			const exactMember = {
				storePath: original.result.storePath,
				narHash: original.result.narHash,
				generation: 1
			};
			const resolvedCapture = {
				result: original.result,
				begin: {
					result: exactMember,
					expectedCacheGeneration: 1,
					requestId: capture.input.requestId,
					origin: 'build-selection',
					memberCount: 1
				},
				pages: [[exactMember]]
			};
			const savedJson: unknown = JSON.parse(await readFile(file, 'utf8'));
			expect(publicationCaptureEnvelopeSchema.parse(savedJson)).toEqual({
				...envelope,
				checkpoint: {
					...envelope.checkpoint,
					state: {
						phase: boundary === 'begin' ? 'resolved' : 'begun',
						capture: resolvedCapture,
						...(boundary !== 'begin' && { operationId })
					}
				}
			});
			const expectedCalls = [
				{ path: '/t/acme/uploads/credential', body: {} },
				{
					path: '/t/acme/publication-results/lookup',
					body: {
						source: { cache: { kind: 'default' } },
						results: [capture.input.result]
					}
				},
				{
					path: '/t/acme/publication-results/lookup',
					body: {
						source: { cache: { kind: 'default' }, expectedCacheGeneration: 1 },
						results: capture.input.members
					}
				},
				{
					path: '/t/acme/publication-results/captures',
					body: {
						result: {
							storePath: original.result.storePath,
							narHash: original.result.narHash,
							generation: 1
						},
						expectedCacheGeneration: 1,
						requestId: capture.input.requestId,
						origin: 'build-selection',
						memberCount: 1
					}
				},
				{
					path: `/t/acme/publication-results/captures/${operationId}/pages/0`,
					body: {
						members: [
							{
								storePath: original.result.storePath,
								narHash: original.result.narHash,
								generation: 1
							}
						]
					}
				},
				{
					path: `/t/acme/publication-results/captures/${operationId}/seal`,
					body: {}
				}
			];
			expect(calls).toEqual(
				expectedCalls.slice(
					0,
					boundary === 'begin' ? 4 : boundary === 'page' ? 5 : 6
				)
			);

			const beforeReplay = calls.length;
			if (isReplacement) {
				accepted = recordedPublicationSchema.parse({
					...original,
					result: { ...original.result, generation: 2 },
					digest: 'b'.repeat(64),
					memberCount: 2
				});
				await expect(invoke()).rejects.toBeDefined();
				expect(calls.slice(beforeReplay)).toEqual([
					expectedCalls[0],
					expectedCalls[3]
				]);
			} else {
				await invoke();
				expect(calls.slice(beforeReplay)).toEqual([
					expectedCalls[0],
					...expectedCalls.slice(3)
				]);
				const completedJson: unknown = JSON.parse(await readFile(file, 'utf8'));
				expect(publicationCaptureEnvelopeSchema.parse(completedJson)).toEqual({
					...envelope,
					checkpoint: {
						...envelope.checkpoint,
						state: {
							phase: 'captured',
							capture: resolvedCapture,
							operationId,
							publication: original
						}
					}
				});
			}
		}
	);
	it.each(['bare', 'version', 'request', 'destination'] as const)(
		'rejects %s capture transport before authentication',
		async (kind) => {
			const envelope = initialEnvelope();
			const contents =
				kind === 'bare'
					? envelope.request
					: kind === 'version'
						? { ...envelope, version: 2 }
						: kind === 'request'
							? {
									...envelope,
									request: {
										...envelope.request,
										input: {
											...envelope.request.input,
											origin: 'legacy-selection'
										}
									}
								}
							: {
									...envelope,
									checkpoint: {
										...envelope.checkpoint,
										binding: {
											...envelope.checkpoint.binding,
											tenantUrl: 'https://cupboard.example.workers.dev/t/other'
										}
									}
								};
			const file = await requestFile(contents);
			const authenticate = vi.fn();
			const program = new Command();
			registerPublicationResultCommand(program, {}, { authenticate });
			await expect(
				program.parseAsync(
					[
						'publication-result',
						'https://cupboard.example.workers.dev/t/acme',
						'--request-file',
						file
					],
					{ from: 'user' }
				)
			).rejects.toBeDefined();
			expect(authenticate).not.toHaveBeenCalled();
			expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(contents);
		}
	);

	it('persists a genuine result-only shortcut, ignores disappearing losing members on replay, and still requires current authority (modelled HTTP)', async () => {
		const envelope = initialEnvelope();
		const file = await requestFile(envelope);
		const publication = recordedPublicationSchema.parse({
			result: {
				...envelope.request.input.result,
				narHash: `sha256:${'0'.repeat(52)}`,
				generation: 1,
				cache: { kind: 'default' },
				cacheGeneration: 1
			},
			digest: 'a'.repeat(64),
			memberCount: 1,
			origin: 'legacy-selection'
		});
		const calls: { path: string; body: unknown }[] = [];
		let isRefused = false;
		const fetcher: typeof fetch = async (input, init) => {
			const http = new Request(input, init);
			const pathname = new URL(http.url).pathname;
			const text = await http.text();
			const body: unknown = text === '' ? {} : JSON.parse(text);
			calls.push({ path: pathname, body });
			if (pathname.endsWith('/uploads/credential')) {
				return Response.json(
					{
						pushId: 'push-1',
						accessKeyId: 'access',
						secretAccessKey: 'secret',
						sessionToken: 'session',
						endpoint: 'https://r2.test',
						bucket: 'blobs',
						expiresAt: '2099-01-01T00:00:00.000Z'
					},
					{
						headers: { [uploadCapabilitiesHeader]: 'publication-manifests-v1' }
					}
				);
			}
			if (isRefused) {
				return new Response('authority refused', { status: 403 });
			}
			return Response.json({
				entries: [{ kind: 'recorded', publication, complete: true }]
			});
		};
		await executeHiddenFile(file, fetcher);
		const saved = publicationCaptureEnvelopeSchema.parse(
			JSON.parse(await readFile(file, 'utf8'))
		);
		expect(saved).toEqual({
			...envelope,
			checkpoint: {
				...envelope.checkpoint,
				state: { phase: 'shortcut', publication }
			}
		});
		await executeHiddenFile(file, fetcher);
		isRefused = true;
		await expect(executeHiddenFile(file, fetcher)).rejects.toBeDefined();
		const credential = { path: '/t/acme/uploads/credential', body: {} };
		const replay = {
			path: '/t/acme/publication-results/lookup',
			body: {
				source: { cache: { kind: 'default' }, expectedCacheGeneration: 1 },
				results: [
					{
						storePath: publication.result.storePath,
						narHash: publication.result.narHash,
						generation: 1
					}
				]
			}
		};
		expect(calls).toEqual([
			credential,
			{
				path: '/t/acme/publication-results/lookup',
				body: {
					source: { cache: { kind: 'default' } },
					results: [envelope.request.input.result]
				}
			},
			credential,
			replay,
			credential,
			replay
		]);
		const replayedJson: unknown = JSON.parse(await readFile(file, 'utf8'));
		expect(publicationCaptureEnvelopeSchema.parse(replayedJson)).toEqual(saved);
	});

	it('is registered as internal transport without semantic switches', () => {
		const command = buildProgram().commands.find(
			(command) => command.name() === 'publication-result'
		);
		expect(command?.options.map((option) => option.long)).toEqual([
			'--request-file',
			'--github-oidc',
			'--audience'
		]);
	});
	it('rejects invalid requests before authentication', async () => {
		const file = await requestFile({
			operation: 'ensure',
			input: { expectedDestinationGeneration: 1 }
		});
		const authenticate = vi.fn();
		const program = new Command();
		registerPublicationResultCommand(program, {}, { authenticate });
		await expect(
			program.parseAsync(
				[
					'publication-result',
					'https://cupboard.example.workers.dev/t/acme',
					'--request-file',
					file
				],
				{ from: 'user' }
			)
		).rejects.toBeDefined();
		expect(authenticate).not.toHaveBeenCalled();
	});
	it.each([
		request,
		publicationWorkflowRequestSchema.parse({
			operation: 'prepare-run-root',
			input: {
				name: 'github:acme/app/run-1',
				retention: { kind: 'duration', seconds: 3600 }
			}
		})
	])(
		'passes $operation through normal auth and emits the exact result',
		async (input) => {
			const file = await requestFile(input);
			const resultFile = `${file}.result`;
			const credential = {
				get: () => Promise.resolve('token'),
				refresh: () => Promise.resolve('token')
			};
			const authenticate = vi.fn<typeof authenticateForPush>(() =>
				Promise.resolve(credential)
			);
			const execute = vi.fn(() =>
				Promise.resolve({
					operation: input.operation,
					supported: false as const
				})
			);
			const workflowFor = vi.fn(() => ({ execute }));
			const program = new Command()
				.option('--output-mode <mode>')
				.option('--result-file <path>');
			registerPublicationResultCommand(
				program,
				{},
				{
					authenticate,
					workflowFor,
					fetchCacheAccess: () => Promise.resolve('public')
				}
			);
			await program.parseAsync(
				[
					'--output-mode',
					'json',
					'--result-file',
					resultFile,
					'publication-result',
					'https://cupboard.example.workers.dev/t/acme',
					'--github-oidc',
					'--request-file',
					file
				],
				{ from: 'user' }
			);
			expect(authenticate.mock.calls[0]?.[1]).toMatchObject({
				githubOidc: true,
				authorizationDetails: [
					{
						type: 'cupboard_cache',
						cache: { kind: 'default' },
						actions: ['upload:negotiate', 'upload:status', 'upload:commit']
					},
					...(input.operation === 'prepare-run-root'
						? [
								{
									type: 'cupboard_cache',
									cache: { kind: 'default' },
									root: input.input.name,
									actions: ['root:attach']
								}
							]
						: [])
				]
			});
			expect(workflowFor).toHaveBeenCalledWith(
				new URL('https://cupboard.example.workers.dev/t/acme'),
				credential,
				{ cache: { kind: 'default' }, signal: undefined }
			);
			expect(execute).toHaveBeenCalledWith(input);
			expect(await readFile(resultFile, 'utf8')).toContain(
				'"kind":"publication-result"'
			);
			expect(await readFile(resultFile, 'utf8')).toContain('"supported":false');
		}
	);
});
