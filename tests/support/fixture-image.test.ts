import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	FixtureImageBuilder,
	type FixtureImageRuntime,
	prepareNixFixtureImage
} from './fixture-image.ts';

const preparation = vi.hoisted(() => ({
	auth: vi.fn<
		() => Promise<
			| { registryAddress: string; username: string; password: string }
			| { registryAddress: string; identityToken: string }
			| undefined
		>
	>(),
	inspect: vi.fn<(image: string) => Promise<void>>(),
	remove: vi.fn<(image: string) => Promise<void>>(),
	build:
		vi.fn<
			(context: unknown, options: unknown) => Promise<NodeJS.ReadableStream>
		>(),
	pull: vi.fn<() => Promise<void>>()
}));

vi.mock('testcontainers', async (importOriginal) => ({
	...(await importOriginal<typeof import('testcontainers')>()),
	getReaper: () => Promise.resolve({ sessionId: 'fixture-session' }),
	getContainerRuntimeClient: () =>
		Promise.resolve({
			info: {
				containerRuntime: { indexServerAddress: 'https://index.docker.io/v1/' }
			},
			container: {
				dockerode: {
					getImage: (image: string) => ({
						inspect: () => preparation.inspect(image),
						remove: () => preparation.remove(image)
					}),
					buildImage: preparation.build
				}
			},
			image: { pull: preparation.pull }
		})
}));
vi.mock('testcontainers/build/container-runtime/index.js', () => ({
	getAuthConfig: preparation.auth
}));

const image = 'cupboard-nix-fixture:owned-image';
const id = `sha256:${'a'.repeat(64)}`;
const missing = Object.assign(new Error('No such image'), { statusCode: 404 });

function stream(messages: readonly unknown[]): Readable {
	return Readable.from(
		messages.map((message) => `${JSON.stringify(message)}\n`)
	);
}

function fixture() {
	return {
		build: vi.fn<FixtureImageRuntime['build']>(() =>
			Promise.resolve(stream([{ aux: { ID: id } }]))
		),
		inspect: vi.fn<FixtureImageRuntime['inspect']>(() => Promise.resolve())
	};
}

describe('Nix fixture image preparation', () => {
	it('rebuilds without cache when the completed image disappears before inspection', async () => {
		const runtime = fixture();
		runtime.inspect.mockRejectedValueOnce(missing);
		await new FixtureImageBuilder(runtime).build(image);
		expect({
			builds: runtime.build.mock.calls,
			inspections: runtime.inspect.mock.calls
		}).toStrictEqual({
			builds: [
				[image, false],
				[image, true]
			],
			inspections: [[image], [image]]
		});
	});

	it('rebuilds without cache after a confirmed missing cached image', async () => {
		const runtime = fixture();
		runtime.build.mockResolvedValueOnce(
			stream([
				{
					errorDetail: { message: `No such image: ${id}` },
					error: `No such image: ${id}`
				}
			])
		);
		runtime.inspect.mockRejectedValueOnce(missing);
		await new FixtureImageBuilder(runtime).build(image);
		expect({
			builds: runtime.build.mock.calls,
			inspections: runtime.inspect.mock.calls
		}).toStrictEqual({
			builds: [
				[image, false],
				[image, true]
			],
			inspections: [[id], [image]]
		});
	});

	it.each([
		'The command returned a non-zero code: 1',
		'unauthorized: authentication required',
		'manifest unknown',
		'No such image: typo-in-dockerfile',
		`No such image: ${id}`
	])('reports a build failure without retrying: %s', async (diagnostic) => {
		const runtime = fixture();
		runtime.build.mockResolvedValueOnce(
			stream([
				{ stream: 'Step 2/2: RUN setup\n' },
				{ errorDetail: { message: diagnostic }, error: diagnostic }
			])
		);
		await expect(new FixtureImageBuilder(runtime).build(image)).rejects.toThrow(
			diagnostic
		);
		expect(runtime.build.mock.calls).toStrictEqual([[image, false]]);
	});

	it('reports both attempts when the built image disappears twice', async () => {
		const runtime = fixture();
		runtime.inspect.mockRejectedValue(missing);
		await expect(new FixtureImageBuilder(runtime).build(image)).rejects.toThrow(
			'disappeared'
		);
		expect(runtime.build.mock.calls).toStrictEqual([
			[image, false],
			[image, true]
		]);
	});

	it('rejects an incomplete build stream without treating a missing image as successful preparation', async () => {
		const runtime = fixture();
		runtime.build.mockResolvedValueOnce(
			stream([{ stream: 'Step 1/2: FROM base\n' }])
		);
		await expect(new FixtureImageBuilder(runtime).build(image)).rejects.toThrow(
			'without an image identifier'
		);
		expect({
			builds: runtime.build.mock.calls,
			inspections: runtime.inspect.mock.calls
		}).toStrictEqual({ builds: [[image, false]], inspections: [] });
	});
	it.each([401, 500])(
		'does not rebuild after an inspection fails with status %i',
		async (statusCode) => {
			const runtime = fixture();
			const failure = Object.assign(new Error('Docker inspection failed'), {
				statusCode
			});
			runtime.inspect.mockRejectedValue(failure);
			await expect(new FixtureImageBuilder(runtime).build(image)).rejects.toBe(
				failure
			);
			expect(runtime.build.mock.calls).toStrictEqual([[image, false]]);
		}
	);

	it('propagates a build connection failure after a completion frame without inspecting or retrying', async () => {
		const runtime = fixture();
		const failure = new Error('Docker connection closed after completion');
		const broken = Readable.from(
			(async function* () {
				yield `${JSON.stringify({ aux: { ID: id } })}\n`;
				await setImmediate();
				throw failure;
			})()
		);
		runtime.build.mockResolvedValueOnce(broken);
		await expect(new FixtureImageBuilder(runtime).build(image)).rejects.toBe(
			failure
		);
		expect({
			builds: runtime.build.mock.calls,
			inspections: runtime.inspect.mock.calls
		}).toStrictEqual({ builds: [[image, false]], inspections: [] });
	}, 1000);

	it('propagates a failed build connection without retrying', async () => {
		const runtime = fixture();
		const failure = new Error('Docker connection closed');
		const broken = new Readable({
			read() {
				broken.destroy(failure);
			}
		});
		runtime.build.mockResolvedValueOnce(broken);
		await expect(new FixtureImageBuilder(runtime).build(image)).rejects.toBe(
			failure
		);
		expect({
			builds: runtime.build.mock.calls,
			inspections: runtime.inspect.mock.calls
		}).toStrictEqual({ builds: [[image, false]], inspections: [] });
	});
});

describe('Nix fixture build runtime', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		preparation.auth.mockResolvedValue(undefined);
		preparation.inspect.mockResolvedValue();
		preparation.remove.mockResolvedValue();
		preparation.build.mockImplementation(() =>
			Promise.resolve(stream([{ aux: { ID: id } }]))
		);
	});

	it.each([
		{ auth: undefined, registryconfig: {} },
		{
			auth: {
				registryAddress: 'registry',
				username: 'user',
				password: 'secret'
			},
			registryconfig: {
				registry: {
					registryAddress: 'registry',
					username: 'user',
					password: 'secret'
				}
			}
		},
		{
			auth: { registryAddress: 'registry', identityToken: 'token' },
			registryconfig: {
				registry: {
					username: '',
					password: '',
					registryAddress: 'registry',
					identityToken: 'token'
				}
			}
		}
	])(
		'forwards configured registry credentials: $auth',
		async ({ auth, registryconfig }) => {
			const ownedImage: unknown = expect.stringMatching(
				/^cupboard-nix-fixture:/u
			);
			preparation.auth.mockResolvedValue(auth);
			await prepareNixFixtureImage('tests/fixtures/nix-ssh-store');
			expect({
				builds: preparation.build.mock.calls,
				credentials: preparation.auth.mock.calls
			}).toStrictEqual({
				builds: [
					[
						{ context: 'tests/fixtures/nix-ssh-store', src: ['Dockerfile'] },
						{
							t: ownedImage,
							dockerfile: 'Dockerfile',
							nocache: false,
							rm: true,
							forcerm: true,
							version: '1',
							registryconfig,
							labels: {
								'org.testcontainers': 'true',
								'org.testcontainers.lang': 'node',
								'org.testcontainers.session-id': 'fixture-session'
							}
						}
					]
				],
				credentials: [['https://index.docker.io/v1/']]
			});
		}
	);
	it('preserves the Docker build diagnostic when removing a failed fixture image also fails', async () => {
		preparation.build.mockResolvedValueOnce(
			stream([
				{ errorDetail: { message: 'The command returned a non-zero code: 29' } }
			])
		);
		preparation.remove.mockRejectedValueOnce(
			new Error('Docker cleanup failed')
		);
		await expect(
			prepareNixFixtureImage('tests/fixtures/nix-ssh-store')
		).rejects.toThrow('non-zero code: 29');
		expect(preparation.remove.mock.calls).toStrictEqual([
			[expect.stringMatching(/^cupboard-nix-fixture:/u)]
		]);
	});
});
