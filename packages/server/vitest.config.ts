import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, zstdCompressSync } from 'node:zlib';

import {
	cloudflareTest,
	readD1Migrations
} from '@cloudflare/vitest-pool-workers';
import { workersInvocationAllowances } from '@cupboard/protocol/platform';
import { defineConfig } from 'vitest/config';

import { resolveTestWorkerBudget } from './src/test-worker-budget.ts';

const mebibyte = 1024 * 1024;

interface CompressedNarFixture {
	readonly compressed: Uint8Array<ArrayBuffer>;
	readonly narSha256: string;
	readonly narSize: number;
}

/**
 * A 24 MiB NAR, compressed in the CLI's format (concatenated independent zstd
 * frames with content checksums) but with one frame per MiB, not one per
 * 16 MiB. workerd's zstd compressor fails once its output exceeds about 40 KiB,
 * so the verifier's workers tests receive this fixture as a binding. Most of
 * each frame is pseudo-random and does not compress, so the compressed object
 * is about 21 MiB and frame boundaries fall inside ranged reads.
 */
function compressedNarFixture(): CompressedNarFixture {
	const frameCount = 24;
	const nar = new Uint8Array(frameCount * mebibyte);
	let state = 0x9e_37_79_b9;

	for (let index = 0; index < nar.byteLength; index += 1) {
		if (index % mebibyte >= (7 * mebibyte) / 8) {
			nar[index] = 0x61 + (index % 26);
			continue;
		}

		// xorshift32
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		nar[index] = state & 0xff;
	}

	const frames = Array.from({ length: frameCount }, (_, frame) =>
		zstdCompressSync(nar.subarray(frame * mebibyte, (frame + 1) * mebibyte), {
			params: { [constants.ZSTD_c_checksumFlag]: 1 }
		})
	);
	const compressed = new Uint8Array(
		frames.reduce((total, frame) => total + frame.byteLength, 0)
	);
	let offset = 0;

	for (const frame of frames) {
		compressed.set(frame, offset);
		offset += frame.byteLength;
	}

	return {
		compressed,
		narSha256: createHash('sha256').update(nar).digest('hex'),
		narSize: nar.byteLength
	};
}

export default defineConfig(async () => {
	const workerBudget = resolveTestWorkerBudget(
		process.env.CUPBOARD_TEST_WORKERS
	);
	// The D1 migrations production applies through `wrangler d1 migrations apply`,
	// handed to the workers pool as a binding the setup file replays into D1.
	const here = path.dirname(fileURLToPath(import.meta.url));
	const migrations = await readD1Migrations(path.join(here, 'drizzle-d1'));
	const narFixture = compressedNarFixture();

	return {
		test: {
			silent: 'passed-only' as const,
			projects: [
				{
					test: {
						name: 'node',
						testTimeout: 30_000,
						sequence: { groupOrder: 0 },
						benchmark: {
							include: ['src/**/*.bench.ts']
						},
						include: ['src/**/*.test.ts'],
						exclude: ['src/**/*.workers.test.ts']
					}
				},
				{
					plugins: [
						cloudflareTest({
							// The Durable Object must live in the `main` worker for
							// `runInDurableObject` to reach it, so the tenant script is the
							// worker under test; the control handler is exercised by calling
							// its exported `fetch` directly (see `controlFetch`). The
							// control-plane bindings are deliberately not bound here, so the
							// Durable Object's env lacks them exactly as in production.
							main: './src/test-worker.ts',
							miniflare: {
								bindings: {
									R2_ACCESS_KEY_ID: 'test-access-key-id',
									R2_ACCOUNT_ID: 'test-account-id',
									R2_BUCKET_NAME: 'cupboard-blobs',
									R2_SECRET_ACCESS_KEY: 'test-secret-access-key',
									PUSH_ID_SIGNING_KEY: 'test-push-id-signing-key',
									// A ceiling a test can reach with a handful of sockets. It
									// must stay above the concurrency any other suite pushes
									// with, or that suite's seeding would be refused.
									CUPBOARD_COMMIT_SOCKET_CEILING: '10',
									// Pool bindings override Wrangler's `.dev.vars`. Keep the
									// test allowance independent of local deployment settings.
									CUPBOARD_SUBREQUESTS_PER_INVOCATION: String(
										workersInvocationAllowances.free.subrequests
									),
									TEST_MIGRATIONS: migrations,
									TEST_COMPRESSED_NAR: {
										narSha256: narFixture.narSha256,
										narSize: narFixture.narSize
									}
								},
								dataBlobBindings: {
									TEST_COMPRESSED_NAR_BYTES: narFixture.compressed
								},
								// The admission manifest KV the control handler reads and writes;
								// it is control-plane state, supplied to the worker under test so
								// the control handler can be exercised through it.
								kvNamespaces: {
									TENANT_CACHE: 'tenant-cache',
									CRON_STATE: 'cron-state'
								},
								queueProducers: {
									MAINTENANCE_QUEUE: 'cupboard-maintenance'
								},
								compatibilityDate: '2026-08-18'
							},
							wrangler: {
								configPath: './wrangler.tenant.jsonc'
							}
						})
					],
					test: {
						name: 'workers',
						testTimeout: 30_000,
						fileParallelism: true,
						maxWorkers: workerBudget,
						sequence: { groupOrder: 1 },
						include: ['src/**/*.workers.test.ts'],
						setupFiles: ['./src/d1-test-setup.ts']
					}
				}
			]
		}
	};
});
