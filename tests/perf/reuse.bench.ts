import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { StorePath } from '@cupboard/nix-store/store-path';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { afterAll, beforeAll, bench } from 'vitest';

import { tenantRpc } from '../../packages/cli/src/client/orpc.ts';
import type { PushClient } from '../../packages/cli/src/push/push.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import { NixStore } from '../support/nix.ts';
import { type PushContext, pushStorePaths } from '../support/push.ts';

// The reuse lookup shares the tenant's single Durable Object with the commit
// path, so PLAN.md's "Named tenant reuse views" section names its load
// behaviour a release gate: it must hold bounded read concurrency against a
// closure larger than any one commit batch, and answer overload retryably
// rather than wedging.
const probeConcurrency = 32;
const poolSize = 64;
const missCount = 64;
const commitBatchSize = 8;
const iterations = 3;
const warmupIterations = 1;
const commitRuns = iterations + warmupIterations;

// The mixed sweep's pass/fail bar: brief overload under commit-path
// contention is expected and acceptable (the lookup shares the tenant's
// single Durable Object with the commit path), but systematic refusal is a
// failed gate, not a passing one. 20% is generous enough to absorb genuine
// contention while still failing an implementation that refuses every reuse
// lookup outright.
const maximumRetryableRefusalFraction = 0.2;

interface Harness {
	readonly server: CupboardTestServer;
	readonly source: NixStore;
	readonly client: PushClient;
	readonly workspace: string;
	readonly hitHashes: readonly string[];
	readonly missHashes: readonly string[];
	readonly commitPool: readonly string[];
	commitCursor: number;
}

interface Sample {
	readonly label: string;
	readonly durationMs: number;
	readonly requestCount: number;
	readonly retryableRefusals: number;
}

const state: { harness?: Harness } = {};
const samples: Sample[] = [];

const hashAlphabet = '0123456789abcdfghijklmnpqrsvwxyz';

// Two-character prefixes from the nix base32 alphabet, repeated to a full
// 32-character store-path hash, so generated miss hashes always parse but
// never collide with a hash the pool actually built.
function generatedMissHash(index: number): string {
	const prefix =
		(hashAlphabet[Math.floor(index / hashAlphabet.length)] ?? '0') +
		(hashAlphabet[index % hashAlphabet.length] ?? '0');

	return prefix.repeat(16);
}

async function addPoolPath(
	source: NixStore,
	root: string,
	index: number
): Promise<string> {
	const directory = path.join(root, `path-${String(index).padStart(4, '0')}`);
	await mkdir(directory, { recursive: true });
	await writeFile(
		path.join(directory, 'data'),
		`cupboard-reuse-bench-${String(index)}`
	);

	return source.add(directory);
}

function harnessOrThrow(): Harness {
	const harness = state.harness;

	if (harness === undefined) {
		throw new UninitialisedHarnessError();
	}

	return harness;
}

function probe(server: CupboardTestServer, hash: string): Promise<Response> {
	return fetch(server.tenantPath(`/reuse/reuse/${hash}.narinfo`));
}

function takeCommitBatch(harness: Harness): readonly string[] {
	const end = harness.commitCursor + commitBatchSize;

	if (end > harness.commitPool.length) {
		throw new CommitPoolExhaustedError(harness.commitCursor);
	}

	const batch = harness.commitPool.slice(harness.commitCursor, end);
	harness.commitCursor = end;

	return batch;
}

beforeAll(async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), 'cupboard-reuse-bench-'));
	const server = await CupboardTestServer.start(workspace);
	const source = await NixStore.host(path.join(workspace, 'source-home'));
	const token = await server.ownerAdminToken();
	const sourceRoot = path.join(workspace, 'sources');
	await mkdir(sourceRoot, { recursive: true });

	const commitPoolSize = commitBatchSize * commitRuns;
	const pool: string[] = [];

	// Sequential on purpose: `nix-store --add` is a subprocess, and a few
	// hundred at once would swamp the machine the benchmark then measures.
	for (let index = 0; index < poolSize + commitPoolSize; index += 1) {
		pool.push(await addPoolPath(source, sourceRoot, index));
	}

	const hitPool = pool.slice(0, poolSize);
	const commitPool = pool.slice(poolSize);
	const client = server.pushClient(token, { cache: 'pr-1' });
	const pushContext: PushContext = { client, store: source };

	await pushStorePaths(pushContext, hitPool);

	const rpc = tenantRpc(server.tenantUrl, { credential: token });
	await rpc.reuseViews.set({
		name: 'reuse',
		selectors: [{ kind: 'prefix', pattern: 'pr-' }]
	});

	state.harness = {
		server,
		source,
		client,
		workspace,
		hitHashes: hitPool.map((storePath) => StorePath.hash(storePath)),
		missHashes: Array.from({ length: missCount }, (_, index) =>
			generatedMissHash(index)
		),
		commitPool,
		commitCursor: 0
	};
});

afterAll(async () => {
	const harness = state.harness;

	if (harness !== undefined) {
		await harness.server.stop();
		await rm(harness.workspace, { recursive: true, force: true });
	}

	const labels = new Set(samples.map((sample) => sample.label));

	for (const label of labels) {
		const matching = samples.filter((sample) => sample.label === label);
		const meanMs =
			matching.reduce((sum, sample) => sum + sample.durationMs, 0) /
			matching.length;
		const meanRequests =
			matching.reduce((sum, sample) => sum + sample.requestCount, 0) /
			matching.length;
		const perSecond = (meanRequests / meanMs) * 1000;
		const totalRetryableRefusals = matching.reduce(
			(sum, sample) => sum + sample.retryableRefusals,
			0
		);

		console.log(
			`[reuse-bench] "${label}" mean=${meanMs.toFixed(0)}ms (${perSecond.toFixed(1)} probes/s)` +
				(totalRetryableRefusals > 0
					? `, retryable refusals=${String(totalRetryableRefusals)}`
					: '')
		);
	}
});

bench(
	'reuse narinfo probes, hits',
	async () => {
		const harness = harnessOrThrow();
		const start = performance.now();

		await mapWithConcurrency(
			harness.hitHashes,
			probeConcurrency,
			async (hash) => {
				const response = await probe(harness.server, hash);

				if (response.status !== 200) {
					throw new UnexpectedProbeStatusError(hash, response.status);
				}
			}
		);

		samples.push({
			label: 'reuse narinfo probes, hits',
			durationMs: performance.now() - start,
			requestCount: harness.hitHashes.length,
			retryableRefusals: 0
		});
	},
	{ iterations, warmupIterations, time: 0, warmupTime: 0 }
);

bench(
	'reuse narinfo probes, misses',
	async () => {
		const harness = harnessOrThrow();
		const start = performance.now();

		await mapWithConcurrency(
			harness.missHashes,
			probeConcurrency,
			async (hash) => {
				const response = await probe(harness.server, hash);

				if (response.status !== 404) {
					throw new UnexpectedProbeStatusError(hash, response.status);
				}
			}
		);

		samples.push({
			label: 'reuse narinfo probes, misses',
			durationMs: performance.now() - start,
			requestCount: harness.missHashes.length,
			retryableRefusals: 0
		});
	},
	{ iterations, warmupIterations, time: 0, warmupTime: 0 }
);

bench(
	'mixed sweep with commit traffic',
	async () => {
		const harness = harnessOrThrow();
		const batch = takeCommitBatch(harness);
		const pushContext: PushContext = {
			client: harness.client,
			store: harness.source
		};
		let retryableRefusals = 0;
		const start = performance.now();

		await Promise.all([
			pushStorePaths(pushContext, batch),
			mapWithConcurrency(harness.hitHashes, probeConcurrency, async (hash) => {
				const response = await probe(harness.server, hash);

				if (response.status === 503) {
					if (response.headers.get('retry-after') === null) {
						throw new UnexpectedProbeStatusError(hash, response.status);
					}

					retryableRefusals += 1;
					return;
				}

				if (response.status !== 200) {
					throw new UnexpectedProbeStatusError(hash, response.status);
				}
			})
		]);

		samples.push({
			label: 'mixed sweep with commit traffic',
			durationMs: performance.now() - start,
			requestCount: harness.hitHashes.length,
			retryableRefusals
		});

		if (
			retryableRefusals / harness.hitHashes.length >
			maximumRetryableRefusalFraction
		) {
			throw new RetryableRefusalThresholdExceededError(
				retryableRefusals,
				harness.hitHashes.length
			);
		}
	},
	{ iterations, warmupIterations, time: 0, warmupTime: 0 }
);

class UninitialisedHarnessError extends Error {
	constructor() {
		super('Reuse-view bench harness not initialised');
		this.name = 'UninitialisedHarnessError';
	}
}

class CommitPoolExhaustedError extends Error {
	constructor(public readonly cursor: number) {
		super(
			`Commit path pool exhausted at ${String(cursor)}; increase commitBatchSize * commitRuns`
		);
		this.name = 'CommitPoolExhaustedError';
	}
}

class UnexpectedProbeStatusError extends Error {
	constructor(
		public readonly hash: string,
		public readonly status: number
	) {
		super(`Unexpected reuse probe status ${String(status)} for ${hash}`);
		this.name = 'UnexpectedProbeStatusError';
	}
}

class RetryableRefusalThresholdExceededError extends Error {
	constructor(
		public readonly retryableRefusals: number,
		public readonly requestCount: number
	) {
		super(
			`${String(retryableRefusals)}/${String(requestCount)} reuse probes were retryably refused, exceeding the ${String(maximumRetryableRefusalFraction * 100)}% gate`
		);
		this.name = 'RetryableRefusalThresholdExceededError';
	}
}
