import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { afterAll, beforeAll, bench } from 'vitest';

import { type PushClient, runPush } from '../../packages/cli/src/push/push.ts';
import { Nix, type NixValidPathInfo } from '../../packages/nix/src/index.ts';
import {
	createReporter,
	type Reporter
} from '../../packages/reporter/src/reporter.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import { NixStore } from '../support/nix.ts';

// An integration benchmark of the real push against a worker running under
// Miniflare over a real socket: every cost the phase pays in production is
// present (NAR build, zstd, the credential fetch, the R2 upload, the
// commit). Each iteration pushes a fresh batch of unique store paths so the
// cache never reports them as already present; without that, the second
// iteration would negotiate nothing and measure an empty push.

const batchSize = 24;
const iterations = 3;
const warmupIterations = 1;
const concurrencyLevels = [6, 12];

// Enough distinct paths for every measured and warmup iteration of every case
// to consume its own slice, so no two pushes ever share a store path.
const poolSize =
	batchSize * (iterations + warmupIterations) * concurrencyLevels.length;

const fileSize = 256 * 1024;
const blockSize = 8 * 1024;
const dictionaryBlocks = 24;

interface Harness {
	readonly server: CupboardTestServer;
	readonly source: NixStore;
	readonly client: PushClient;
	readonly nix: Nix;
	readonly workspace: string;
	readonly pool: string[];
	cursor: number;
}

interface PhaseSample {
	readonly concurrency: number;
	readonly label: string;
	readonly durationMs: number;
}

const state: { harness?: Harness } = {};
const samples: PhaseSample[] = [];

function pseudoRandomBytes(size: number, seed: number): Buffer {
	const buffer = Buffer.allocUnsafe(size);
	let value = seed >>> 0;

	for (let index = 0; index < size; index += 1) {
		value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
		buffer[index] = (value >>> 24) & 0xff;
	}

	return buffer;
}

// Semi-compressible content, so zstd does real work on varied bytes; the
// per-path index keeps every payload distinct.
function compressibleContent(seed: number): Buffer {
	const fallbackBlock = pseudoRandomBytes(blockSize, seed);
	const dictionary = Array.from({ length: dictionaryBlocks }, (_, index) =>
		pseudoRandomBytes(blockSize, seed + index + 1)
	);
	const buffer = Buffer.allocUnsafe(fileSize);
	let value = (seed * 2_246_822_519) >>> 0;
	let offset = 0;

	while (offset < fileSize) {
		value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
		const block = dictionary[value % dictionaryBlocks] ?? fallbackBlock;
		const length = Math.min(blockSize, fileSize - offset);
		block.copy(buffer, offset, 0, length);
		offset += length;
	}

	return buffer;
}

async function addStorePath(
	source: NixStore,
	root: string,
	index: number
): Promise<string> {
	const directory = path.join(root, `path-${String(index).padStart(5, '0')}`);
	await mkdir(directory, { recursive: true });
	await writeFile(path.join(directory, 'data'), compressibleContent(index));
	await writeFile(
		path.join(directory, 'id'),
		`cupboard-bench-${String(index)}`
	);

	return source.add(directory);
}

function captureReporter(): { reporter: Reporter; lines: string[] } {
	const lines: string[] = [];
	const sink = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			lines.push(chunk.toString());
			callback();
		}
	});

	return {
		reporter: createReporter({ stream: sink, out: sink }),
		lines
	};
}

function recordPhaseDurations(concurrency: number, lines: string[]): void {
	for (const line of lines.join('').split('\n')) {
		if (line.length === 0) {
			continue;
		}

		const event = JSON.parse(line) as {
			event?: string;
			status?: string;
			label?: string;
			durationMs?: number;
		};

		if (
			event.event === 'phase' &&
			event.status === 'ok' &&
			typeof event.label === 'string' &&
			typeof event.durationMs === 'number'
		) {
			samples.push({
				concurrency,
				label: event.label,
				durationMs: event.durationMs
			});
		}
	}
}

function takeBatch(harness: Harness): string[] {
	const end = harness.cursor + batchSize;

	if (end > harness.pool.length) {
		throw new Error(
			`Path pool exhausted at ${String(harness.cursor)}; increase poolSize`
		);
	}

	const batch = harness.pool.slice(harness.cursor, end);
	harness.cursor = end;

	return batch;
}

function storeClientFor(source: NixStore): Nix {
	const queryPathInfo = async (
		storePath: string
	): Promise<NixValidPathInfo> => {
		const info = await source.pathInfo(storePath);

		// The pool is built in the bench's own source store, which registers
		// local builds as ultimately trusted.
		return { ...info, signatures: [], ultimate: true };
	};

	return Nix.forStore(
		{
			queryPathInfo,
			resolveClosure: (storePaths: readonly string[]) =>
				Promise.all(storePaths.map((storePath) => queryPathInfo(storePath)))
		},
		{ storeDirectory: '/nix/store' }
	);
}

beforeAll(async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), 'cupboard-push-bench-'));
	const server = await CupboardTestServer.start(workspace);
	const source = await NixStore.host(path.join(workspace, 'source-home'));
	const token = await server.ownerAdminToken();
	const sourceRoot = path.join(workspace, 'sources');
	await mkdir(sourceRoot, { recursive: true });

	const pool: string[] = [];
	for (let index = 0; index < poolSize; index += 1) {
		// Sequential on purpose: `nix-store --add` is a subprocess, and a few
		// hundred at once would swamp the machine the benchmark then measures.
		pool.push(await addStorePath(source, sourceRoot, index));
	}

	state.harness = {
		server,
		source,
		client: server.pushClient(token),
		nix: storeClientFor(source),
		workspace,
		pool,
		cursor: 0
	};
});

afterAll(async () => {
	const harness = state.harness;

	if (harness !== undefined) {
		await harness.server.stop();
		await rm(harness.workspace, { recursive: true, force: true });
	}

	const labels = [...new Set(samples.map((sample) => sample.label))];

	const combinations = concurrencyLevels.flatMap((concurrency) =>
		labels.map((label) => ({ concurrency, label }))
	);

	for (const { concurrency, label } of combinations) {
		const matching = samples.filter(
			(sample) => sample.concurrency === concurrency && sample.label === label
		);

		if (matching.length > 0) {
			const meanMs =
				matching.reduce((sum, sample) => sum + sample.durationMs, 0) /
				matching.length;
			const perSecond = (batchSize / meanMs) * 1000;

			console.log(
				`[push-bench] uploadConcurrency=${String(concurrency)} "${label}" mean=${meanMs.toFixed(0)}ms (${perSecond.toFixed(1)} paths/s)`
			);
		}
	}
});

function pushBatch(concurrency: number): () => Promise<void> {
	return async () => {
		const harness = state.harness;

		if (harness === undefined) {
			throw new Error('Harness not initialised');
		}

		const batch = takeBatch(harness);
		const { reporter, lines } = captureReporter();

		await runPush(batch, reporter, {
			nix: harness.nix,
			client: harness.client,
			wait: false,
			uploadConcurrency: concurrency
		});

		recordPhaseDurations(concurrency, lines);
	};
}

for (const concurrency of concurrencyLevels) {
	bench(
		`push ${String(batchSize)} missing NARs, uploadConcurrency=${String(concurrency)}`,
		pushBatch(concurrency),
		{ iterations, warmupIterations, time: 0, warmupTime: 0 }
	);
}
