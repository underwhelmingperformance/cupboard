import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { bestEffort } from '@cupboard/shared/cleanup';
import {
	GenericContainer,
	getContainerRuntimeClient,
	getReaper,
	ImageName,
	LABEL_TESTCONTAINERS_SESSION_ID
} from 'testcontainers';
import { getAuthConfig } from 'testcontainers/build/container-runtime/index.js';
import { z } from 'zod';

const buildMessage = z.object({
	stream: z.string().optional(),
	error: z.string().optional(),
	errorDetail: z.object({ message: z.string().optional() }).optional(),
	aux: z.object({ ID: z.string().optional() }).optional()
});
const imageId = /^sha256:[\da-f]{64}$/u;
const missingCacheImage = /No such image: (sha256:[\da-f]{64})(?:\s|$)/u;
const diagnosticLimit = 16 * 1024;

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
	constructor(private readonly runtime: FixtureImageRuntime) {}

	private async attempt(
		image: string,
		shouldSkipCache: boolean
	): Promise<void> {
		const stream = await this.runtime.build(image, shouldSkipCache);
		const lines = createInterface({
			input: stream,
			crlfDelay: Infinity
		});
		const output = new BuildOutput();

		try {
			for await (const line of lines) {
				if (line.trim() !== '') {
					output.append(line);
				}
			}
		} finally {
			lines.close();
		}

		output.validate(image);

		try {
			await this.runtime.inspect(image);
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

		try {
			await this.runtime.inspect(error.missingImage);
			return false;
		} catch (inspectionError) {
			return isMissingImage(inspectionError);
		}
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
	directory: string
): Promise<GenericContainer> {
	const client = await getContainerRuntimeClient();
	const reaper = await getReaper(client);
	const docker = client.container.dockerode;
	const dockerfile = await readFile(path.join(directory, 'Dockerfile'), 'utf8');
	const baseImage = /^FROM\s+(\S+)$/mu.exec(dockerfile)?.[1];

	if (baseImage === undefined) {
		throw new Error('The Nix fixture Dockerfile must specify its base image.');
	}

	const baseName = ImageName.fromString(baseImage);
	const auth = await getAuthConfig(
		baseName.registry ?? client.info.containerRuntime.indexServerAddress
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
			try {
				await docker.getImage(baseImage).inspect();
			} catch (error) {
				if (!isMissingImage(error)) {
					throw error;
				}

				await client.image.pull(baseName, {
					force: true,
					platform: undefined
				});
			}

			return docker.buildImage(
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
			);
		},
		async inspect(image) {
			await docker.getImage(image).inspect();
		}
	};

	try {
		await new FixtureImageBuilder(runtime).build(image);
		return new GenericContainer(image);
	} catch (error) {
		await bestEffort(async () => {
			await docker.getImage(image).remove({ force: true });
		});
		throw error;
	}
}
