import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import {
	ExponentialBackoff,
	type ExponentialBackoffPolicy,
	type RandomSource
} from '@cupboard/shared/backoff';
import { bestEffort } from '@cupboard/shared/cleanup';
import { abortableSleep } from '@cupboard/shared/retry';
import { StatusCodes } from 'http-status-codes';
import {
	GenericContainer,
	getContainerRuntimeClient,
	getReaper,
	ImageName,
	LABEL_TESTCONTAINERS_SESSION_ID
} from 'testcontainers';
import { getAuthConfig } from 'testcontainers/build/container-runtime/index.js';
import { z } from 'zod';

import type { StepProgress } from './step-progress.ts';

const buildMessage = z.object({
	stream: z.string().optional(),
	error: z.string().optional(),
	errorDetail: z.object({ message: z.string().optional() }).optional(),
	aux: z.object({ ID: z.string().optional() }).optional()
});
const imageId = /^sha256:[\da-f]{64}$/u;
const missingCacheImage = /No such image: (sha256:[\da-f]{64})(?:\s|$)/u;
const diagnosticLimit = 16 * 1024;

export const maxPullAttempts = 5;
const pullBackoffPolicy: ExponentialBackoffPolicy = {
	baseMs: 2000,
	jitter: 'half'
};
const firstServerErrorStatus: number = StatusCodes.INTERNAL_SERVER_ERROR;
const rateLimitStatus: number = StatusCodes.TOO_MANY_REQUESTS;
const transientPullCodes = new Set(['ECONNRESET', 'EPIPE']);

export interface FixtureImageRuntime {
	build(
		image: string,
		shouldSkipCache: boolean
	): Promise<NodeJS.ReadableStream>;
	inspect(image: string): Promise<void>;
}

class FixtureImageBuildError extends Error {
	constructor(
		message: string,
		readonly missingImage: string | undefined,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'FixtureImageBuildError';
	}
}

class BuildOutput {
	private diagnostics = '';
	private identifier: string | undefined;
	private failure: string | undefined;

	append(line: string): void {
		const message = buildMessage.parse(JSON.parse(line));
		const diagnostic =
			message.errorDetail?.message ?? message.error ?? message.stream;

		if (diagnostic !== undefined) {
			this.diagnostics = `${this.diagnostics}${diagnostic}\n`.slice(
				-diagnosticLimit
			);
		}

		this.failure ??= message.errorDetail?.message ?? message.error;

		if (message.aux?.ID !== undefined && imageId.test(message.aux.ID)) {
			this.identifier = message.aux.ID;
		}
	}

	validate(image: string): void {
		if (this.failure !== undefined) {
			throw new FixtureImageBuildError(
				`Failed to build Nix fixture image ${image}: ${this.failure}\n${this.diagnostics}`,
				missingCacheImage.exec(this.failure)?.[1]
			);
		}

		if (this.identifier === undefined) {
			throw new FixtureImageBuildError(
				`Docker ended the build of Nix fixture image ${image} without an image identifier:\n${this.diagnostics}`,
				undefined
			);
		}
	}

	disappeared(image: string, cause: unknown): FixtureImageBuildError {
		return new FixtureImageBuildError(
			`Completed Nix fixture image ${image} disappeared before inspection:\n${this.diagnostics}`,
			image,
			{ cause }
		);
	}
}

export class FixtureImageBuilder {
	constructor(
		private readonly runtime: FixtureImageRuntime,
		private readonly progress: StepProgress
	) {}

	private async attempt(
		image: string,
		shouldSkipCache: boolean
	): Promise<void> {
		const suffix = shouldSkipCache ? ' without cache' : '';
		const stream = await this.runtime.build(image, shouldSkipCache);
		const output = await this.progress.step(
			`image build output${suffix}`,
			async () => {
				const lines = createInterface({
					input: stream,
					crlfDelay: Infinity
				});
				const buildOutput = new BuildOutput();

				try {
					for await (const line of lines) {
						if (line.trim() !== '') {
							buildOutput.append(line);
						}
					}
				} finally {
					lines.close();
				}

				return buildOutput;
			}
		);

		output.validate(image);

		try {
			await this.progress.step(`built image inspection${suffix}`, async () =>
				this.runtime.inspect(image)
			);
		} catch (error) {
			if (!isMissingImage(error)) {
				throw error;
			}

			throw output.disappeared(image, error);
		}
	}

	private async canRecover(error: unknown): Promise<boolean> {
		if (
			!(error instanceof FixtureImageBuildError) ||
			error.missingImage === undefined
		) {
			return false;
		}

		if (!imageId.test(error.missingImage)) {
			return true;
		}

		const { missingImage } = error;

		return this.progress.step('missing image inspection', async () => {
			try {
				await this.runtime.inspect(missingImage);

				return false;
			} catch (inspectionError) {
				return isMissingImage(inspectionError);
			}
		});
	}

	async build(image: string): Promise<void> {
		try {
			await this.attempt(image, false);
		} catch (error) {
			if (!(await this.canRecover(error))) {
				throw error;
			}

			try {
				await this.attempt(image, true);
			} catch (retryError) {
				throw new AggregateError(
					[error, retryError],
					`Nix fixture image preparation failed after rebuilding without cache:\n${errorMessage(error)}\n${errorMessage(retryError)}`,
					{ cause: retryError }
				);
			}
		}
	}
}

/**
A failed attempt to pull the base image that was followed by a wait and
another attempt.
*/
export interface PullRetry {
	/**
	The number of the failed attempt, counting the first as 1.
	*/
	readonly attempt: number;
	/**
	The wait before the next attempt, in milliseconds.
	*/
	readonly delayMs: number;
	readonly error: unknown;
}

/**
How `prepareNixFixtureImage` retries the pull of the base image. Tests pass
`delay` and `random` to make the retries instant and the delays predictable.
*/
export interface PullRetryOptions {
	/**
	Waits for the given number of milliseconds. The default is a timer.
	*/
	readonly delay?: (milliseconds: number) => Promise<void>;
	/**
	The random source for the backoff jitter. The default is `Math.random`.
	*/
	readonly random?: RandomSource;
	/**
	Called with each failure that is followed by another attempt. The default
	writes the failure to standard error.
	*/
	readonly onRetry?: (retry: PullRetry) => void;
}

/**
A pull of the base image that failed after the Docker daemon accepted it. The
daemon reports registry failures and local ones in the same way: as an error
in the progress stream, or as an image that is absent after the stream ends.
A platform mismatch and a full disk are local failures, and a new attempt
cannot fix them. Every such failure is retried anyway, which costs at most four
extra attempts.
*/
export class FixtureImagePullError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'FixtureImagePullError';
	}
}

function reportRetry({ attempt, delayMs, error }: PullRetry): void {
	process.stderr.write(
		`Pull of the Nix fixture base image failed on attempt ${attempt.toString()} of ${maxPullAttempts.toString()}, retrying in ${Math.round(delayMs).toString()} ms: ${errorMessage(error)}\n`
	);
}

/**
Whether a failed image pull can succeed when repeated. The daemon answers
with an HTTP error, and `statusCode` is its status. Docker uses 500 for
registry failures and for local ones alike, and the error has no field that
tells them apart, so every 500 and above counts. A failure to reach the
daemon has a `code`. docker-modem reports its own request timeout as
ECONNRESET.
*/
function isTransientPullFailure(error: unknown): boolean {
	if (error instanceof FixtureImagePullError) {
		return true;
	}

	const status = z.object({ statusCode: z.number() }).safeParse(error);

	if (status.success) {
		const { statusCode } = status.data;

		return (
			statusCode >= firstServerErrorStatus || statusCode === rateLimitStatus
		);
	}

	const failure = z.object({ code: z.string() }).safeParse(error);

	return failure.success && transientPullCodes.has(failure.data.code);
}

/**
Runs `pull`, and repeats it after a failure that {@link isTransientPullFailure}
accepts, with at most {@link maxPullAttempts} attempts in total. The delay
after the nth failed attempt is between half of a ceiling and the whole
ceiling, and the ceiling is 2 s doubled n-1 times. Any other failure, such as
a 404 for the image digest or refused credentials, is rethrown at once. After
the last attempt, its failure is rethrown.
*/
export async function pullWithRetry(
	pull: () => Promise<void>,
	options: PullRetryOptions = {}
): Promise<void> {
	const { delay = abortableSleep, random, onRetry = reportRetry } = options;
	const backoff = new ExponentialBackoff(pullBackoffPolicy, random);

	for (let attempt = 1; ; attempt += 1) {
		try {
			await pull();

			return;
		} catch (error) {
			if (attempt >= maxPullAttempts || !isTransientPullFailure(error)) {
				throw error;
			}

			const delayMs = backoff.delayMs(attempt);
			onRetry({ attempt, delayMs, error });
			await delay(delayMs);
		}
	}
}

const pullMessage = z.object({
	error: z.string().optional(),
	errorDetail: z.object({ message: z.string().optional() }).optional()
});

/**
The Docker daemon's operations for pulling the base image.
*/
export interface BaseImagePuller {
	/**
	Starts the pull and returns the progress stream.
	*/
	pull(): Promise<NodeJS.ReadableStream>;
	/**
	Rejects with a 404 error when the pulled image is not in the daemon.
	*/
	inspect(): Promise<void>;
}

/**
Returns the first failure that the progress stream reports, or `undefined`.
Lines that are not JSON are skipped.
*/
async function firstProgressFailure(
	stream: NodeJS.ReadableStream
): Promise<string | undefined> {
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	let failure: string | undefined;

	try {
		for await (const line of lines) {
			const message = pullMessage.safeParse(parseJson(line));

			failure ??= message.success
				? (message.data.errorDetail?.message ?? message.data.error)
				: undefined;
		}
	} finally {
		lines.close();
	}

	return failure;
}

function parseJson(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

async function pullOnce(puller: BaseImagePuller): Promise<void> {
	const failure = await firstProgressFailure(await puller.pull());

	if (failure !== undefined) {
		throw new FixtureImagePullError(
			`Docker reported a failure while pulling the Nix fixture base image: ${failure}`
		);
	}

	try {
		await puller.inspect();
	} catch (error) {
		if (!isMissingImage(error)) {
			throw error;
		}

		throw new FixtureImagePullError(
			'The Nix fixture base image is missing after Docker finished pulling it.',
			{ cause: error }
		);
	}
}

/**
Pulls the base image and retries a transient failure, which includes a failure
that the daemon reports inside the progress stream. The daemon answers an
interrupted pull with status 200 and puts the error in the body, so the pull
counts as complete only when the stream ends without a reported failure and
the image exists.
*/
export async function pullBaseImage(
	puller: BaseImagePuller,
	options: PullRetryOptions = {}
): Promise<void> {
	await pullWithRetry(async () => pullOnce(puller), options);
}

function isMissingImage(error: unknown): boolean {
	return z.object({ statusCode: z.literal(404) }).safeParse(error).success;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

export async function prepareNixFixtureImage(
	directory: string,
	progress: StepProgress,
	pullRetry: PullRetryOptions = {}
): Promise<GenericContainer> {
	const { client, reaper } = await progress.step(
		'container runtime setup',
		async () => {
			const runtimeClient = await getContainerRuntimeClient();

			return { client: runtimeClient, reaper: await getReaper(runtimeClient) };
		}
	);
	const docker = client.container.dockerode;
	const dockerfile = await readFile(path.join(directory, 'Dockerfile'), 'utf8');
	const baseImage = /^FROM\s+(\S+)$/mu.exec(dockerfile)?.[1];

	if (baseImage === undefined) {
		throw new Error('The Nix fixture Dockerfile must specify its base image.');
	}

	const baseName = ImageName.fromString(baseImage);
	const auth = await progress.step('registry credential lookup', async () =>
		getAuthConfig(
			baseName.registry ?? client.info.containerRuntime.indexServerAddress
		)
	);
	const registryconfig =
		auth === undefined
			? {}
			: {
					[auth.registryAddress]:
						'username' in auth ? auth : { username: '', password: '', ...auth }
				};
	const image = `cupboard-nix-fixture:${randomUUID()}`;
	const runtime: FixtureImageRuntime = {
		async build(image, shouldSkipCache) {
			const suffix = shouldSkipCache ? ' without cache' : '';
			const isBasePresent = await progress.step(
				`base image inspection${suffix}`,
				async () => {
					try {
						await docker.getImage(baseImage).inspect();

						return true;
					} catch (error) {
						if (!isMissingImage(error)) {
							throw error;
						}

						return false;
					}
				}
			);

			if (!isBasePresent) {
				await progress.step(`base image pull${suffix}`, async () =>
					pullBaseImage(
						{
							pull: async () =>
								docker.pull(baseName.string, {
									authconfig: auth,
									platform: undefined
								}),
							inspect: async () => {
								await docker.getImage(baseName.string).inspect();
							}
						},
						pullRetry
					)
				);
			}

			return progress.step(`image build request${suffix}`, async () =>
				docker.buildImage(
					{ context: directory, src: ['Dockerfile'] },
					{
						t: image,
						dockerfile: 'Dockerfile',
						nocache: shouldSkipCache,
						rm: true,
						forcerm: true,
						version: '1',
						registryconfig,
						labels: {
							'org.testcontainers': 'true',
							'org.testcontainers.lang': 'node',
							[LABEL_TESTCONTAINERS_SESSION_ID]: reaper.sessionId
						}
					}
				)
			);
		},
		async inspect(image) {
			await docker.getImage(image).inspect();
		}
	};

	try {
		await new FixtureImageBuilder(runtime, progress).build(image);
		return new GenericContainer(image);
	} catch (error) {
		await bestEffort(async () => {
			await docker.getImage(image).remove({ force: true });
		});
		throw error;
	}
}
