import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';

import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	type BaseImagePuller,
	FixtureImageBuilder,
	FixtureImagePullError,
	type FixtureImageRuntime,
	maxPullAttempts,
	prepareNixFixtureImage,
	pullBaseImage,
	type PullRetry,
	pullWithRetry
} from './fixture-image.ts';
import { StepProgress } from './step-progress.ts';

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
	pull: vi.fn<
		(image: string, options: unknown) => Promise<NodeJS.ReadableStream>
	>()
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
					buildImage: preparation.build,
					pull: preparation.pull
				}
			}
		})
}));
vi.mock('testcontainers/build/container-runtime/index.js', () => ({
	getAuthConfig: preparation.auth
}));

const quiet = new StepProgress('Fixture', {
	write: vi.fn<(line: string) => void>()
});

function recordedProgress() {
	const lines: string[] = [];
	const progress = new StepProgress('Fixture', {
		write: (line) => {
			lines.push(line);
		},
		now: () => 0
	});

	return { lines, progress };
}

const image = 'cupboard-nix-fixture:owned-image';
const id = `sha256:${'a'.repeat(64)}`;
const missing = Object.assign(new Error('No such image'), { statusCode: 404 });

const retriedPullFailures = [
	{ what: 'status 429', fields: { statusCode: StatusCodes.TOO_MANY_REQUESTS } },
	{
		what: 'status 500',
		fields: { statusCode: StatusCodes.INTERNAL_SERVER_ERROR }
	},
	{ what: 'status 501', fields: { statusCode: StatusCodes.NOT_IMPLEMENTED } },
	{
		what: 'status 599',
		fields: { statusCode: 599 }
	},
	{ what: 'code ECONNRESET', fields: { code: 'ECONNRESET' } },
	{ what: 'code EPIPE', fields: { code: 'EPIPE' } }
];
const rethrownPullFailures = [
	{ what: 'status 404', fields: { statusCode: StatusCodes.NOT_FOUND } },
	{ what: 'status 401', fields: { statusCode: StatusCodes.UNAUTHORIZED } },
	{ what: 'status 408', fields: { statusCode: StatusCodes.REQUEST_TIMEOUT } },
	{ what: 'status 499', fields: { statusCode: 499 } },
	{ what: 'code ECONNREFUSED', fields: { code: 'ECONNREFUSED' } },
	{ what: 'no status or code', fields: {} }
];
// With half jitter and a random source that returns 0.5, each delay is three
// quarters of the ceiling, which starts at 2 s and doubles.
const half = () => 0.5;

function pullFailure(fields: object): Error {
	return Object.assign(new Error('pull failed'), fields);
}

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
		await new FixtureImageBuilder(runtime, quiet).build(image);
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
		await new FixtureImageBuilder(runtime, quiet).build(image);
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
		await expect(
			new FixtureImageBuilder(runtime, quiet).build(image)
		).rejects.toThrow(diagnostic);
		expect(runtime.build.mock.calls).toStrictEqual([[image, false]]);
	});

	it('reports both attempts when the built image disappears twice', async () => {
		const runtime = fixture();
		runtime.inspect.mockRejectedValue(missing);
		await expect(
			new FixtureImageBuilder(runtime, quiet).build(image)
		).rejects.toThrow('disappeared');
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
		await expect(
			new FixtureImageBuilder(runtime, quiet).build(image)
		).rejects.toThrow('without an image identifier');
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
			await expect(
				new FixtureImageBuilder(runtime, quiet).build(image)
			).rejects.toBe(failure);
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
		await expect(
			new FixtureImageBuilder(runtime, quiet).build(image)
		).rejects.toBe(failure);
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
		await expect(
			new FixtureImageBuilder(runtime, quiet).build(image)
		).rejects.toBe(failure);
		expect({
			builds: runtime.build.mock.calls,
			inspections: runtime.inspect.mock.calls
		}).toStrictEqual({ builds: [[image, false]], inspections: [] });
	});
});

function retryRecorder() {
	const delay = vi.fn<(milliseconds: number) => Promise<void>>(() =>
		Promise.resolve()
	);
	const onRetry = vi.fn<(retry: PullRetry) => void>();

	return { delay, onRetry, options: { delay, onRetry, random: half } };
}

function puller() {
	return {
		pull: vi.fn<BaseImagePuller['pull']>(() =>
			Promise.resolve(stream([{ status: 'Pull complete' }]))
		),
		inspect: vi.fn<BaseImagePuller['inspect']>(() => Promise.resolve())
	};
}

describe('Nix fixture base image pull retries', () => {
	it.each(retriedPullFailures)(
		'retries after $what and succeeds',
		async ({ fields }) => {
			const failure = pullFailure(fields);
			const pull = vi
				.fn<() => Promise<void>>()
				.mockRejectedValueOnce(failure)
				.mockRejectedValueOnce(failure)
				.mockResolvedValue();
			const { delay, onRetry, options } = retryRecorder();
			await pullWithRetry(pull, options);
			expect({
				attempts: pull.mock.calls.length,
				delays: delay.mock.calls,
				retries: onRetry.mock.calls
			}).toStrictEqual({
				attempts: 3,
				delays: [[1500], [3000]],
				retries: [
					[{ attempt: 1, delayMs: 1500, error: failure }],
					[{ attempt: 2, delayMs: 3000, error: failure }]
				]
			});
		}
	);

	it('rethrows the last failure once the attempts are used up', async () => {
		const failures = Array.from({ length: maxPullAttempts }, (_, index) =>
			pullFailure({ statusCode: StatusCodes.SERVICE_UNAVAILABLE, index })
		);
		const pull = vi.fn<() => Promise<void>>();

		for (const failure of failures) {
			pull.mockRejectedValueOnce(failure);
		}

		const { delay, options } = retryRecorder();
		await expect(pullWithRetry(pull, options)).rejects.toBe(failures.at(-1));
		expect({
			attempts: pull.mock.calls.length,
			delays: delay.mock.calls
		}).toStrictEqual({
			attempts: maxPullAttempts,
			delays: [[1500], [3000], [6000], [12_000]]
		});
	});

	it.each(rethrownPullFailures)(
		'fails at once after $what',
		async ({ fields }) => {
			const failure = pullFailure(fields);
			const pull = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
			const { delay, onRetry, options } = retryRecorder();
			await expect(pullWithRetry(pull, options)).rejects.toBe(failure);
			expect({
				attempts: pull.mock.calls.length,
				delays: delay.mock.calls,
				retries: onRetry.mock.calls
			}).toStrictEqual({ attempts: 1, delays: [], retries: [] });
		}
	);
});

describe('Nix fixture base image pull outcome', () => {
	const resetAfterProgress = Object.assign(new Error('socket hang up'), {
		code: 'ECONNRESET'
	});
	const reportedFailure: unknown = expect.any(FixtureImagePullError);

	it.each([
		{
			what: 'an error object in the progress stream',
			first: () =>
				stream([
					{ status: 'Pulling fs layer' },
					{
						errorDetail: { message: 'unexpected HTTP status: 503' },
						error: 'unexpected HTTP status: 503'
					}
				]),
			error: reportedFailure
		},
		{
			what: 'a connection reset in the progress stream',
			first: () =>
				Readable.from(
					(async function* () {
						yield `${JSON.stringify({ status: 'Pulling fs layer' })}\n`;
						await setImmediate();
						throw resetAfterProgress;
					})()
				),
			error: resetAfterProgress
		}
	])('retries after $what', async ({ first, error }) => {
		const runtime = puller();
		runtime.pull.mockResolvedValueOnce(first());
		const { delay, onRetry, options } = retryRecorder();
		await pullBaseImage(runtime, options);
		expect({
			pulls: runtime.pull.mock.calls,
			inspections: runtime.inspect.mock.calls,
			delays: delay.mock.calls,
			retries: onRetry.mock.calls
		}).toStrictEqual({
			pulls: [[], []],
			inspections: [[]],
			delays: [[1500]],
			retries: [[{ attempt: 1, delayMs: 1500, error }]]
		});
	});

	it('retries when the image is missing after a pull that reported no error', async () => {
		const runtime = puller();
		runtime.inspect.mockRejectedValueOnce(missing);
		const { delay, onRetry, options } = retryRecorder();
		await pullBaseImage(runtime, options);
		expect({
			pulls: runtime.pull.mock.calls,
			inspections: runtime.inspect.mock.calls,
			delays: delay.mock.calls,
			retries: onRetry.mock.calls
		}).toStrictEqual({
			pulls: [[], []],
			inspections: [[], []],
			delays: [[1500]],
			retries: [[{ attempt: 1, delayMs: 1500, error: reportedFailure }]]
		});
		expect(onRetry.mock.calls[0]?.[0].error).toHaveProperty('cause', missing);
	});

	it('rethrows a stream error that persists through every attempt', async () => {
		const runtime = puller();
		runtime.pull.mockImplementation(() =>
			Promise.resolve(stream([{ error: 'unexpected HTTP status: 503' }]))
		);
		const { options } = retryRecorder();
		await expect(pullBaseImage(runtime, options)).rejects.toBeInstanceOf(
			FixtureImagePullError
		);
		expect({
			pulls: runtime.pull.mock.calls,
			inspections: runtime.inspect.mock.calls
		}).toStrictEqual({
			pulls: Array.from({ length: maxPullAttempts }, () => []),
			inspections: []
		});
	});

	it('does not retry a stream failure that is not transient', async () => {
		const failure = Object.assign(new Error('no space'), { code: 'ENOSPC' });
		const runtime = puller();
		runtime.pull.mockResolvedValueOnce(
			Readable.from(
				(async function* () {
					await setImmediate();
					yield '';
					throw failure;
				})()
			)
		);
		const { delay, onRetry, options } = retryRecorder();
		await expect(pullBaseImage(runtime, options)).rejects.toBe(failure);
		expect({
			pulls: runtime.pull.mock.calls,
			inspections: runtime.inspect.mock.calls,
			delays: delay.mock.calls,
			retries: onRetry.mock.calls
		}).toStrictEqual({ pulls: [[]], inspections: [], delays: [], retries: [] });
	});
});

describe('Nix fixture build runtime', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		preparation.auth.mockResolvedValue(undefined);
		preparation.inspect.mockResolvedValue();
		preparation.remove.mockResolvedValue();
		preparation.pull.mockImplementation(() =>
			Promise.resolve(stream([{ status: 'Pull complete' }]))
		);
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
			await prepareNixFixtureImage('tests/fixtures/nix-ssh-store', quiet);
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
	it('retries a transient failure when pulling the base image', async () => {
		const { delay, onRetry, options } = retryRecorder();
		const failure = pullFailure({
			statusCode: StatusCodes.INTERNAL_SERVER_ERROR
		});
		const baseImage: unknown = expect.stringMatching(
			/^nixos\/nix:2\.34\.8@sha256:[\da-f]{64}$/u
		);
		const builtImage: unknown = expect.stringMatching(
			/^cupboard-nix-fixture:/u
		);
		preparation.inspect.mockRejectedValueOnce(missing);
		preparation.pull.mockRejectedValueOnce(failure);
		await prepareNixFixtureImage(
			'tests/fixtures/nix-ssh-store',
			quiet,
			options
		);
		expect({
			pulls: preparation.pull.mock.calls,
			inspections: preparation.inspect.mock.calls,
			builds: preparation.build.mock.calls.length,
			delays: delay.mock.calls,
			retries: onRetry.mock.calls
		}).toStrictEqual({
			pulls: [
				[baseImage, { authconfig: undefined, platform: undefined }],
				[baseImage, { authconfig: undefined, platform: undefined }]
			],
			inspections: [[baseImage], [baseImage], [builtImage]],
			builds: 1,
			delays: [[1500]],
			retries: [[{ attempt: 1, delayMs: 1500, error: failure }]]
		});
	});

	it('reports each step of the preparation when the base image has to be pulled', async () => {
		const { lines, progress } = recordedProgress();
		preparation.inspect.mockRejectedValueOnce(missing);
		await prepareNixFixtureImage('tests/fixtures/nix-ssh-store', progress);
		expect(lines).toStrictEqual([
			'Fixture: container runtime setup started',
			'Fixture: container runtime setup finished in 0 ms',
			'Fixture: registry credential lookup started',
			'Fixture: registry credential lookup finished in 0 ms',
			'Fixture: base image inspection started',
			'Fixture: base image inspection finished in 0 ms',
			'Fixture: base image pull started',
			'Fixture: base image pull finished in 0 ms',
			'Fixture: image build request started',
			'Fixture: image build request finished in 0 ms',
			'Fixture: image build output started',
			'Fixture: image build output finished in 0 ms',
			'Fixture: built image inspection started',
			'Fixture: built image inspection finished in 0 ms'
		]);
	});

	it('gives the steps of the rebuild without cache different names from the first attempt', async () => {
		const { lines, progress } = recordedProgress();
		preparation.build.mockResolvedValueOnce(
			stream([{ errorDetail: { message: `No such image: ${id}` } }])
		);
		preparation.inspect.mockResolvedValueOnce().mockRejectedValueOnce(missing);
		await prepareNixFixtureImage('tests/fixtures/nix-ssh-store', progress);
		expect(lines).toStrictEqual([
			'Fixture: container runtime setup started',
			'Fixture: container runtime setup finished in 0 ms',
			'Fixture: registry credential lookup started',
			'Fixture: registry credential lookup finished in 0 ms',
			'Fixture: base image inspection started',
			'Fixture: base image inspection finished in 0 ms',
			'Fixture: image build request started',
			'Fixture: image build request finished in 0 ms',
			'Fixture: image build output started',
			'Fixture: image build output finished in 0 ms',
			'Fixture: missing image inspection started',
			'Fixture: missing image inspection finished in 0 ms',
			'Fixture: base image inspection without cache started',
			'Fixture: base image inspection without cache finished in 0 ms',
			'Fixture: image build request without cache started',
			'Fixture: image build request without cache finished in 0 ms',
			'Fixture: image build output without cache started',
			'Fixture: image build output without cache finished in 0 ms',
			'Fixture: built image inspection without cache started',
			'Fixture: built image inspection without cache finished in 0 ms'
		]);
	});

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
			prepareNixFixtureImage('tests/fixtures/nix-ssh-store', quiet)
		).rejects.toThrow('non-zero code: 29');
		expect(preparation.remove.mock.calls).toStrictEqual([
			[expect.stringMatching(/^cupboard-nix-fixture:/u)]
		]);
	});
});
