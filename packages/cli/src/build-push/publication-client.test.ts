import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	InvalidCacheUrlBaseError,
	InvalidTenantCacheUrlError
} from '@cupboard/nix-store/errors';
import { cacheNameSchema, rootNameSchema } from '@cupboard/nix-store/scalars';
import { recordedPublicationSchema } from '@cupboard/protocol/publication-manifests';
import {
	publicationCaptureBindingSchema,
	publicationCaptureCheckpointSchema,
	type PublicationWorkflowRequest,
	publicationWorkflowRequestSchema
} from '@cupboard/protocol/publication-workflow';
import { uploadCapabilitiesHeader } from '@cupboard/protocol/upload';
import { expect, it, onTestFinished, vi } from 'vitest';

import { audienceSchema } from '../audience.ts';
import type { authenticateForPush } from '../auth/auth.ts';
import { cacheTargetFromUrl } from '../cache-target.ts';
import { publicationWorkflowFor } from '../publication/publication-client.ts';

import {
	buildPublicationWorkflow,
	publicationSourceForUrl
} from './publication-client.ts';
import { publicationRequests } from './publication-requests.ts';

const destination = cacheTargetFromUrl(
	new URL('https://cupboard.example.workers.dev/t/acme/cache/builds')
);

it('validates the tenant URL before exposing destination recovery metadata', () => {
	const authenticate = vi.fn<typeof authenticateForPush>();
	expect(() =>
		buildPublicationWorkflow(
			{
				tenantUrl: new URL('https://cupboard.example.workers.dev/not-a-tenant'),
				cache: { kind: 'default' }
			},
			{ audience: audienceSchema.parse(destination.tenantUrl) },
			undefined,
			{ authenticate }
		)
	).toThrow(InvalidTenantCacheUrlError);
	expect(authenticate).not.toHaveBeenCalled();
});

it.each(
	[
		{ pathname: '', source: { cache: { kind: 'default' } } },
		{
			pathname: '/cache/source',
			source: { cache: { kind: 'named', name: 'source' } }
		},
		{ pathname: '/reuse/release', source: { selector: { view: 'release' } } },
		{ pathname: '/reuse/%72elease', source: { selector: { view: 'release' } } }
	].flatMap(({ pathname, source }) =>
		['', '/', '///'].map((suffix) => ({
			pathname: `${pathname}${suffix}`,
			source
		}))
	)
)(
	'converts the canonical tenant source $pathname without mutating its URL',
	({ pathname, source }) => {
		const url = new URL(`${destination.tenantUrl.href}${pathname}`);
		const original = url.href;
		expect(publicationSourceForUrl(url)).toEqual(source);
		expect(url.href).toBe(original);
	}
);

it.each([
	'ftp://cupboard.example.workers.dev/t/acme/reuse/release/',
	'https://user@cupboard.example.workers.dev/t/acme/reuse/release/',
	'https://:password@cupboard.example.workers.dev/t/acme/reuse/release/',
	'https://cupboard.example.workers.dev/t/acme/reuse/release/?query=value',
	'https://cupboard.example.workers.dev/t/acme/reuse/release/#fragment'
])(
	'rejects an invalid source base before inspecting its suffix: %s',
	(value) => {
		const url = new URL(value);
		expect(() => publicationSourceForUrl(url)).toThrow(
			InvalidCacheUrlBaseError
		);
		expect(url.href).toBe(value);
	}
);

it.each([
	{
		path: '/cache/source',
		source: { cache: { kind: 'named', name: 'source' } },
		actions: ['cache:content-read']
	},
	{
		path: '/reuse/release',
		source: { selector: { view: 'release' } },
		actions: ['view:content-read']
	}
])(
	'keeps private $path reads separate from destination publication authority',
	async ({ path, source, actions }) => {
		const authenticate = vi.fn<typeof authenticateForPush>(() =>
			Promise.resolve({
				get: () => Promise.resolve('token'),
				refresh: () => Promise.resolve('token')
			})
		);
		const execute = vi.fn<ReturnType<typeof publicationWorkflowFor>['execute']>(
			() => Promise.resolve({ operation: 'lookup', supported: false })
		);
		const workflowFor = vi.fn<typeof publicationWorkflowFor>(() => ({
			execute
		}));
		const workflow = buildPublicationWorkflow(
			destination,
			{
				githubOidc: true,
				audience: audienceSchema.parse(destination.tenantUrl)
			},
			undefined,
			{
				authenticate,
				workflowFor,
				fetchAccess: () => Promise.resolve('private')
			}
		);
		const request = publicationWorkflowRequestSchema.parse({
			operation: 'lookup',
			input: {
				source,
				results: [{ storePath: `/nix/store/${'1'.repeat(32)}-app` }]
			}
		});
		await workflow.execute(request);
		await workflow.execute(request);
		expect(
			publicationSourceForUrl(new URL(`${destination.tenantUrl.href}${path}`))
		).toEqual(source);
		expect(authenticate).toHaveBeenCalledTimes(1);
		const requested =
			authenticate.mock.calls[0]?.[1].authorizationDetails ?? [];
		expect(requested).toHaveLength(2);
		expect(requested[0]).toMatchObject({
			type: 'cupboard_cache',
			cache: destination.cache
		});
		expect(requested[1]).toMatchObject({ actions });
		expect(
			requested.flatMap((detail) => ('actions' in detail ? detail.actions : []))
		).not.toContain('root:set');
		expect(execute).toHaveBeenCalledTimes(2);
		expect(execute).toHaveBeenLastCalledWith(request);
	}
);

it('requests exact run-root attach permission for ensure independently of source read permission', async () => {
	const authenticate = vi.fn<typeof authenticateForPush>(() =>
		Promise.resolve({
			get: () => Promise.resolve('token'),
			refresh: () => Promise.resolve('token')
		})
	);
	const workflowFor = vi.fn<typeof publicationWorkflowFor>(() => ({
		execute: () => Promise.resolve({ operation: 'ensure', supported: false })
	}));
	const workflow = buildPublicationWorkflow(
		destination,
		{ audience: audienceSchema.parse(destination.tenantUrl) },
		undefined,
		{
			authenticate,
			workflowFor,
			fetchAccess: () => Promise.resolve('private')
		}
	);
	const request = publicationWorkflowRequestSchema.parse({
		operation: 'ensure',
		input: {
			source: {
				result: {
					cache: { kind: 'named', name: 'source' },
					cacheGeneration: 1,
					storePath: `/nix/store/${'1'.repeat(32)}-app`,
					narHash: `sha256:${'0'.repeat(52)}`,
					generation: 1
				},
				digest: 'a'.repeat(64),
				memberCount: 100,
				origin: 'build-selection'
			},
			sourceSelector: { view: 'release', expectedRevision: 3 },
			runRoot: rootNameSchema.parse('run/123')
		}
	});
	await workflow.execute(request);
	expect(authenticate.mock.calls[0]?.[1].authorizationDetails).toEqual(
		expect.arrayContaining([
			{
				type: 'cupboard_cache',
				actions: ['root:attach'],
				cache: destination.cache,
				root: 'run/123'
			},
			{ type: 'cupboard_view', actions: ['view:content-read'], view: 'release' }
		])
	);
	const details = JSON.stringify(
		authenticate.mock.calls[0]?.[1].authorizationDetails
	);
	expect(details).not.toContain('"name":"source"');
});

const nativePublication = recordedPublicationSchema.parse({
	result: {
		cache: destination.cache,
		cacheGeneration: 1,
		storePath: `/nix/store/${'1'.repeat(32)}-app`,
		narHash: `sha256:${'0'.repeat(52)}`,
		generation: 1
	},
	digest: 'a'.repeat(64),
	memberCount: 1,
	origin: 'build-selection'
});
const nativeCapture: Extract<
	PublicationWorkflowRequest,
	{ operation: 'capture' }
> = {
	operation: 'capture',
	input: {
		result: {
			storePath: nativePublication.result.storePath,
			narHash: nativePublication.result.narHash
		},
		members: [
			{
				storePath: nativePublication.result.storePath,
				narHash: nativePublication.result.narHash
			}
		],
		origin: 'build-selection'
	}
};

async function nativeCaptureOwner(invocation: string) {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-native-client-')
	);
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const receipt = path.join(directory, 'receipt.json');
	const journal = await publicationRequests(
		receipt,
		undefined,
		undefined,
		invocation
	);
	const request = await journal.intent(nativeCapture, {
		tenantUrl: destination.tenantUrl.href,
		cache: destination.cache
	});
	const context = await journal.captureContext(request);
	if (context?.capture === undefined) {
		throw new Error('Expected native durable capture context');
	}
	const recovery = context.capture;
	return {
		receipt,
		file: `${receipt}.publication-requests.json`,
		journal,
		request,
		context,
		async checkpoint() {
			return publicationCaptureCheckpointSchema.parse(
				await recovery.store.load()
			);
		}
	};
}

it('keeps per-execute native journal contexts separate for the same request ID through cached and distinct current-authority facades (modelled HTTP remote)', async () => {
	const first = await nativeCaptureOwner('first public invocation');
	const second = await nativeCaptureOwner('second public invocation');
	const secondId = second.request.input.requestId;
	const sharedId = first.request.input.requestId;
	if (secondId === undefined || sharedId === undefined) {
		throw new Error('Expected durable request IDs');
	}
	// Model two valid independently owned records whose IDs happen to coincide.
	// Reopen the real owner after changing every ID reference consistently.
	const originalSecond = await readFile(second.file, 'utf8');
	await writeFile(
		second.file,
		originalSecond.replaceAll(secondId, () => sharedId)
	);
	const secondJournal = await publicationRequests(
		second.receipt,
		undefined,
		undefined,
		'second public invocation'
	);
	const secondRequest = await secondJournal.intent(nativeCapture, {
		tenantUrl: destination.tenantUrl.href,
		cache: destination.cache
	});
	const secondContext = await secondJournal.captureContext(secondRequest);
	if (secondContext?.capture === undefined) {
		throw new Error('Expected second owned context');
	}
	expect(secondRequest).toEqual(first.request);
	const secondBefore = await readFile(second.file, 'utf8');
	const operationId = '22222222-2222-4222-8222-222222222222';
	let isCaptured = false;
	let isAuthorityDenied = false;
	const calls: { path: string; authorization: string | null; body: unknown }[] =
		[];
	const fetcher: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const pathname = new URL(request.url).pathname;
		const text = await request.text();
		const body: unknown = text === '' ? {} : JSON.parse(text);
		const authorization = request.headers.get('authorization');
		calls.push({ path: pathname, authorization, body });
		if (pathname.endsWith('/uploads/credential')) {
			return Response.json(
				{
					pushId: 'native-push',
					accessKeyId: 'access',
					secretAccessKey: 'secret',
					sessionToken: 'session',
					endpoint: 'https://r2.test',
					bucket: 'blobs',
					expiresAt: '2099-01-01T00:00:00.000Z'
				},
				{ headers: { [uploadCapabilitiesHeader]: 'publication-manifests-v1' } }
			);
		}
		if (isAuthorityDenied) {
			return Response.json(
				{ message: 'current authority denied' },
				{ status: 403 }
			);
		}
		if (pathname.endsWith('/publication-results/lookup')) {
			return Response.json({
				entries: [
					isCaptured
						? {
								kind: 'recorded',
								publication: nativePublication,
								complete: true
							}
						: { kind: 'missing', result: nativePublication.result }
				]
			});
		}
		if (pathname.endsWith('/publication-results/captures')) {
			return Response.json(
				isCaptured
					? { kind: 'existing', publication: nativePublication }
					: {
							kind: 'staging',
							operationId,
							expiresAt: '2099-01-01T00:00:00.000Z'
						}
			);
		}
		if (pathname.includes('/pages/')) {
			return Response.json({ operationId, page: 0, acceptedCount: 1 });
		}
		if (pathname.endsWith('/seal')) {
			isCaptured = true;
			return Response.json({
				kind: 'captured',
				association: 'created',
				publication: nativePublication
			});
		}
		throw new Error(`Unexpected remote request: ${pathname}`);
	};
	const workflowFor = vi.fn<typeof publicationWorkflowFor>(
		(url, credential, options) =>
			publicationWorkflowFor(url, credential, { ...options, fetcher })
	);
	const native = (token: string) =>
		buildPublicationWorkflow(
			destination,
			{ audience: audienceSchema.parse(destination.tenantUrl) },
			undefined,
			{
				authenticate: () =>
					Promise.resolve({
						get: () => Promise.resolve(token),
						refresh: () => Promise.resolve(token)
					}),
				workflowFor,
				fetchAccess: () => Promise.resolve('public')
			}
		);
	const cachedFacade = native('first-authority');
	const expected = {
		operation: 'capture',
		supported: true,
		output: nativePublication
	};
	expect(await cachedFacade.execute(first.request, first.context)).toEqual(
		expected
	);
	expect(await readFile(second.file, 'utf8')).toBe(secondBefore);
	expect(await cachedFacade.execute(secondRequest, secondContext)).toEqual(
		expected
	);
	const firstCheckpoint = await first.checkpoint();
	const secondCheckpoint = publicationCaptureCheckpointSchema.parse(
		await secondContext.capture.store.load()
	);
	const begin = {
		result: {
			storePath: nativePublication.result.storePath,
			narHash: nativePublication.result.narHash,
			generation: 1
		},
		expectedCacheGeneration: 1,
		requestId: sharedId,
		origin: 'build-selection',
		memberCount: 1
	};
	const member = {
		storePath: nativePublication.result.storePath,
		narHash: nativePublication.result.narHash,
		generation: 1
	};
	expect(firstCheckpoint.state).toEqual({
		phase: 'captured',
		capture: { result: nativePublication.result, begin, pages: [[member]] },
		operationId,
		publication: nativePublication
	});
	expect(secondCheckpoint).toEqual({
		version: 1,
		binding: {
			...firstCheckpoint.binding,
			invocation: createHash('sha256')
				.update('second public invocation')
				.digest('hex')
		},
		state: { phase: 'shortcut', publication: nativePublication }
	});
	expect(secondCheckpoint.binding.invocation).not.toBe(
		firstCheckpoint.binding.invocation
	);
	expect(workflowFor.mock.calls.map(([url]) => url.href)).toEqual([
		destination.tenantUrl.href
	]);
	const nextAuthority = native('second-authority');
	const firstSaved = await readFile(first.file, 'utf8');
	const secondSaved = await readFile(second.file, 'utf8');
	isAuthorityDenied = true;
	await expect(
		nextAuthority.execute(first.request, first.context)
	).rejects.toThrow();
	expect(await readFile(first.file, 'utf8')).toBe(firstSaved);
	expect(await readFile(second.file, 'utf8')).toBe(secondSaved);
	isAuthorityDenied = false;
	expect(await nextAuthority.execute(first.request, first.context)).toEqual(
		expected
	);
	expect(await nextAuthority.execute(secondRequest, secondContext)).toEqual(
		expected
	);
	const route = '/t/acme/cache/builds';
	const lookup = {
		source: { cache: destination.cache },
		results: nativeCapture.input.members
	};
	expect(
		calls.filter((call) => !call.path.endsWith('/uploads/credential'))
	).toEqual([
		{
			path: `${route}/publication-results/lookup`,
			authorization: 'Bearer first-authority',
			body: lookup
		},
		{
			path: `${route}/publication-results/lookup`,
			authorization: 'Bearer first-authority',
			body: {
				...lookup,
				source: { ...lookup.source, expectedCacheGeneration: 1 }
			}
		},
		{
			path: `${route}/publication-results/captures`,
			authorization: 'Bearer first-authority',
			body: begin
		},
		{
			path: `${route}/publication-results/captures/${operationId}/pages/0`,
			authorization: 'Bearer first-authority',
			body: { members: [member] }
		},
		{
			path: `${route}/publication-results/captures/${operationId}/seal`,
			authorization: 'Bearer first-authority',
			body: {}
		},
		{
			path: `${route}/publication-results/lookup`,
			authorization: 'Bearer first-authority',
			body: {
				source: { cache: destination.cache },
				results: [nativeCapture.input.result]
			}
		},
		{
			path: `${route}/publication-results/captures`,
			authorization: 'Bearer second-authority',
			body: begin
		},
		{
			path: `${route}/publication-results/captures`,
			authorization: 'Bearer second-authority',
			body: begin
		},
		{
			path: `${route}/publication-results/lookup`,
			authorization: 'Bearer second-authority',
			body: {
				source: { cache: destination.cache, expectedCacheGeneration: 1 },
				results: [member]
			}
		}
	]);
	expect(workflowFor.mock.calls.map(([url]) => url.href)).toEqual([
		destination.tenantUrl.href,
		destination.tenantUrl.href
	]);
	expect(await readFile(first.file, 'utf8')).toBe(firstSaved);
	expect(await readFile(second.file, 'utf8')).toBe(secondSaved);
});

it('snapshots the real native destination and refuses destination/input context drift before HTTP (modelled HTTP remote)', async () => {
	const owner = await nativeCaptureOwner('snapshot invocation');
	const target = cacheTargetFromUrl(
		new URL('https://cupboard.example.workers.dev/t/acme/cache/builds')
	);
	const urls: string[] = [];
	const fetcher: typeof fetch = (input, init) => {
		const request = new Request(input, init);
		urls.push(request.url);
		if (request.url.endsWith('/uploads/credential')) {
			return Promise.resolve(
				Response.json(
					{
						pushId: 'native-push',
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
				)
			);
		}
		return Promise.resolve(
			Response.json({
				entries: [
					{ kind: 'recorded', publication: nativePublication, complete: true }
				]
			})
		);
	};
	const native = buildPublicationWorkflow(
		target,
		{ audience: audienceSchema.parse(target.tenantUrl) },
		undefined,
		{
			authenticate: () =>
				Promise.resolve({
					get: () => Promise.resolve('token'),
					refresh: () => Promise.resolve('token')
				}),
			workflowFor: (url, credential, options) =>
				publicationWorkflowFor(url, credential, { ...options, fetcher }),
			fetchAccess: () => Promise.resolve('public')
		}
	);
	target.tenantUrl.pathname = '/t/changed';
	if (target.cache.kind === 'named') {
		target.cache.name = cacheNameSchema.parse('changed');
	}
	const exposed = native.destination;
	if (exposed.cache.kind === 'named') {
		exposed.cache.name = cacheNameSchema.parse('changed');
	}
	expect(native.destination).toEqual({
		tenantUrl: destination.tenantUrl.href,
		cache: destination.cache
	});
	const before = await readFile(owner.file, 'utf8');
	const initialCheckpoint = await owner.checkpoint();
	for (const changed of [
		{
			...owner.context.capture?.binding,
			tenantUrl: 'https://cupboard.example.workers.dev/t/other'
		},
		{ ...owner.context.capture?.binding, cache: { kind: 'default' } }
	]) {
		if (owner.context.capture === undefined) {
			throw new Error('Expected native context');
		}
		await expect(
			native.execute(owner.request, {
				capture: {
					...owner.context.capture,
					binding: publicationCaptureBindingSchema.parse(changed)
				}
			})
		).rejects.toThrow('binding');
	}
	const changedInput = structuredClone(owner.request);
	changedInput.input.origin = 'legacy-selection';
	await expect(native.execute(changedInput, owner.context)).rejects.toThrow(
		'binding'
	);
	expect(urls).toEqual([]);
	expect(await readFile(owner.file, 'utf8')).toBe(before);
	expect(await native.execute(owner.request, owner.context)).toEqual({
		operation: 'capture',
		supported: true,
		output: nativePublication
	});
	expect(urls).toEqual([
		'https://cupboard.example.workers.dev/t/acme/cache/builds/uploads/credential',
		'https://cupboard.example.workers.dev/t/acme/cache/builds/publication-results/lookup'
	]);
	const saved = await owner.checkpoint();
	expect(saved).toEqual({
		version: 1,
		binding: initialCheckpoint.binding,
		state: { phase: 'shortcut', publication: nativePublication }
	});
});
