import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';

import {
	publicationCaptureCheckpointUpdateSchema,
	type PublicationCaptureEnvelope,
	publicationCaptureEnvelopeSchema,
	type PublicationWorkflowExecutionContext
} from '@cupboard/protocol/publication-workflow';
import { withCleanup } from '@cupboard/shared/cleanup';

import type { CacheTarget } from '../cache-target.ts';
import { CliError } from '../errors.ts';

export class PublicationFileOwnershipError extends CliError {
	constructor(
		readonly directory: string,
		options?: ErrorOptions
	) {
		super(
			`Publication file ownership is unavailable at '${directory}'. Preserve the journals and capture envelopes; verify that the original writer is inactive before removing only this lock directory.`,
			options
		);
		this.name = 'PublicationFileOwnershipError';
	}
}

export class PublicationCaptureEnvelopeError extends CliError {}

/**
Cooperating action writers use exactly the same per-file directory.
*/
export async function withCaptureEnvelopeFile<T>(
	file: string,
	target: CacheTarget,
	action: (
		envelope: PublicationCaptureEnvelope,
		context: PublicationWorkflowExecutionContext
	) => Promise<T>,
	signal?: AbortSignal
): Promise<T> {
	signal?.throwIfAborted();
	const directory = `${file}.publication-lock`;
	try {
		await mkdir(directory, { mode: 0o700 });
	} catch (error) {
		throw new PublicationFileOwnershipError(directory, { cause: error });
	}
	let hasFailed = false;
	return withCleanup(
		async () => {
			try {
				const read = async () =>
					publicationCaptureEnvelopeSchema.parse(
						JSON.parse(await readFile(file, 'utf8'))
					);
				const envelope = await read();
				const binding = envelope.checkpoint.binding;
				if (
					binding.tenantUrl !== target.tenantUrl.href ||
					JSON.stringify(binding.cache) !== JSON.stringify(target.cache)
				) {
					throw new PublicationCaptureEnvelopeError(
						'Capture envelope destination does not match the actual command target.'
					);
				}
				const current = async () => {
					const actual = await read();
					if (
						JSON.stringify(actual.request) !==
							JSON.stringify(envelope.request) ||
						JSON.stringify(actual.checkpoint.binding) !==
							JSON.stringify(binding)
					) {
						throw new PublicationCaptureEnvelopeError(
							'Capture envelope request or binding changed.'
						);
					}
					return actual;
				};
				return await action(envelope, {
					capture: {
						binding,
						store: {
							load: async () => {
								const actual = await current();
								return actual.checkpoint;
							},
							save: async (expected, next) => {
								signal?.throwIfAborted();
								const actual = await current();
								if (
									JSON.stringify(actual.checkpoint) !== JSON.stringify(expected)
								) {
									throw new PublicationCaptureEnvelopeError(
										'Capture checkpoint changed before durable save.'
									);
								}
								publicationCaptureCheckpointUpdateSchema.parse({
									previous: actual.checkpoint,
									next
								});
								const updated = publicationCaptureEnvelopeSchema.parse({
									...actual,
									checkpoint: next
								});
								await replaceEnvelope(file, updated, signal);
							}
						}
					}
				});
			} catch (error) {
				hasFailed = true;
				throw error;
			}
		},
		async () => {
			try {
				await rmdir(directory);
			} catch (error) {
				if (hasFailed) {
					process.stderr.write(
						`Could not release publication file ownership '${directory}': ${String(error)}\n`
					);
				}
				throw error;
			}
		}
	);
}

async function replaceEnvelope(
	file: string,
	envelope: PublicationCaptureEnvelope,
	signal?: AbortSignal
): Promise<void> {
	const temporary = `${file}.${randomUUID()}`;
	try {
		const handle = await open(temporary, 'wx', 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(envelope)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		signal?.throwIfAborted();
		await rename(temporary, file);
		const directory = await open(path.dirname(file), 'r');
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await rm(temporary, { force: true });
	}
}
