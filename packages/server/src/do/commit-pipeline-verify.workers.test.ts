import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { SubrequestTimeoutError } from '../errors.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import {
	currentServer,
	initialise,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { CacheAdminService } from './cache-admin-service.ts';
import { CommitPipelineService } from './commit-pipeline-service.ts';
import { type ServerContext } from './context.ts';
import { DeletionQueueService } from './deletion-queue-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { RetentionService } from './retention-service.ts';
import { SigningKeysService } from './signing-keys-service.ts';
import { UploadStateService } from './upload-state-service.ts';

function pipelineFor(context: ServerContext): CommitPipelineService {
	const narInfoObjects = new NarInfoObjectsService(context);
	const attestationCas = new AttestationCasService(context);
	const attestations = new AttestationsService(
		context,
		attestationCas,
		narInfoObjects
	);
	const deletionQueue = new DeletionQueueService(
		context,
		attestationCas,
		attestations,
		narInfoObjects
	);

	return new CommitPipelineService(
		context,
		new CacheAdminService(context, deletionQueue),
		new SigningKeysService(context, narInfoObjects),
		new UploadStateService(context),
		narInfoObjects,
		new RetentionService(context)
	);
}

function neverProducingBody(): {
	readonly stream: ReadableStream<Uint8Array>;
	readonly wasCancelled: () => boolean;
} {
	let wasCancelled = false;

	const stream = new ReadableStream<Uint8Array>({
		pull() {
			return new Promise(() => {
				// Keep this promise pending so the body stalls until verification cancels it.
			});
		},
		cancel() {
			wasCancelled = true;
		}
	});

	return { stream, wasCancelled: () => wasCancelled };
}

function withStalledBody(
	object: R2ObjectBody,
	body: ReadableStream<Uint8Array>
): R2ObjectBody {
	return new Proxy(object, {
		get(target, property) {
			if (property === 'body') {
				return body;
			}

			const value: unknown = Reflect.get(target, property, target);

			if (typeof value !== 'function') {
				return value;
			}

			const bound: unknown = value.bind(target);

			return bound;
		}
	});
}

function stubbedGetBucket(
	bucket: R2Bucket,
	stalledKey: string,
	stalledObject: R2ObjectBody
): R2Bucket {
	return new Proxy(bucket, {
		get(target, property) {
			if (property === 'get') {
				return async (key: string, options?: R2GetOptions) => {
					if (key === stalledKey) {
						return stalledObject;
					}

					return target.get(key, options);
				};
			}

			const value: unknown = Reflect.get(target, property, target);

			if (typeof value !== 'function') {
				return value;
			}

			const bound: unknown = value.bind(target);

			return bound;
		}
	});
}

describe('verification of a stalled staging stream', () => {
	beforeEach(resetTestServer);

	it('times out and cancels the stalled stream instead of hanging indefinitely', async () => {
		await initialise();

		const r2Key = r2ObjectKeySchema.parse('staging/verify-timeout-test');
		await env.BLOBS.put(r2Key, new Uint8Array([1, 2, 3]));
		const real = await env.BLOBS.get(r2Key);

		if (real === null) {
			throw new Error('expected the staged object to exist');
		}

		const { stream, wasCancelled } = neverProducingBody();
		const stalled = withStalledBody(real, stream);
		const metadata = uploadMetadata({
			name: 'verify-timeout',
			storePathHash: 'd'.repeat(32),
			fileSize: 1000,
			narSize: 1000
		});

		let error: unknown;

		await runInDurableObject(currentServer(), async (instance) => {
			instance.context.env = {
				...instance.context.env,
				BLOBS: stubbedGetBucket(instance.context.env.BLOBS, r2Key, stalled)
			};

			const pipeline = pipelineFor(instance.context);

			try {
				await pipeline.verifyPendingNar(r2Key, metadata, 20);
			} catch (error_) {
				error = error_;
			}
		});

		if (!(error instanceof SubrequestTimeoutError)) {
			throw new Error('expected a SubrequestTimeoutError');
		}

		expect({
			name: error.name,
			subrequest: error.subrequest,
			hasAbandoned: error.abandoned !== undefined,
			wasCancelled: wasCancelled()
		}).toStrictEqual({
			name: 'SubrequestTimeoutError',
			subrequest: 'nar.verify',
			hasAbandoned: true,
			wasCancelled: true
		});
	});
});
