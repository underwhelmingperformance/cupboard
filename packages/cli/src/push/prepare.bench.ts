import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import pathModule from 'node:path';

import { afterAll, beforeAll, bench, describe } from 'vitest';

import { compressAndHashNarToFile } from '../nix/blob.ts';
import { NarArchive } from '../nix/nar.ts';

import { runWithConcurrency } from './pool.ts';

// The prepare phase builds, compresses and hashes one NAR per missing path,
// all of which lean on the libuv thread pool. This benchmark runs that local
// pipeline over a synthetic closure at a range of concurrencies so the
// throughput curve is visible. It deliberately excludes the per-path presign
// round-trip the real phase makes: that latency belongs to a deterministic
// fake-timer test, not to a wall-clock benchmark, and keeping it out isolates
// what the local compute alone can sustain.

const pathCount = 48;
const concurrencyLevels = [1, 2, 4, 6, 8, 12, 16];

const blockSize = 8 * 1024;
const dictionaryBlocks = 24;

interface FixturePath {
	readonly source: string;
	readonly output: string;
}

interface Fixture {
	sourceRoot: string;
	outputRoot: string;
	paths: FixturePath[];
}

const fixture: Fixture = { sourceRoot: '', outputRoot: '', paths: [] };

function pseudoRandomBytes(size: number, seed: number): Buffer {
	const buffer = Buffer.allocUnsafe(size);
	let state = seed >>> 0;

	for (let index = 0; index < size; index += 1) {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		buffer[index] = (state >>> 24) & 0xff;
	}

	return buffer;
}

// Semi-compressible content: a small pool of random blocks reassembled in a
// pseudo-random order, so zstd finds repeats the way it does in real package
// payloads rather than seeing incompressible noise or trivial runs.
function compressibleContent(size: number, seed: number): Buffer {
	const fallbackBlock = pseudoRandomBytes(blockSize, seed);
	const dictionary = Array.from({ length: dictionaryBlocks }, (_, index) =>
		pseudoRandomBytes(blockSize, seed + index + 1)
	);
	const buffer = Buffer.allocUnsafe(size);
	let state = (seed * 2_246_822_519) >>> 0;
	let offset = 0;

	while (offset < size) {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		const block = dictionary[state % dictionaryBlocks] ?? fallbackBlock;
		const length = Math.min(blockSize, size - offset);
		block.copy(buffer, offset, 0, length);
		offset += length;
	}

	return buffer;
}

const fileSizes = [
	1_500_000, 768_000, 384_000, 131_072, 64_000, 4096, 512
] as const;

async function writeStorePath(root: string, index: number): Promise<string> {
	const source = pathModule.join(
		root,
		`path-${String(index).padStart(4, '0')}`
	);
	await mkdir(pathModule.join(source, 'bin'), { recursive: true });
	await mkdir(pathModule.join(source, 'lib'), { recursive: true });

	const fileCount = 3 + (index % (fileSizes.length - 2));

	await Promise.all(
		Array.from({ length: fileCount }, (_, fileIndex) => {
			const size = fileSizes[fileIndex % fileSizes.length] ?? 4096;
			const directory = fileIndex === 0 ? 'bin' : 'lib';
			const file = pathModule.join(
				source,
				directory,
				`file-${String(fileIndex)}`
			);

			return writeFile(file, compressibleContent(size, index * 31 + fileIndex));
		})
	);

	return source;
}

async function prepareClosure(concurrency: number): Promise<void> {
	await runWithConcurrency(fixture.paths, concurrency, async (path) => {
		await compressAndHashNarToFile(new NarArchive(path.source), path.output);
	});
}

beforeAll(async () => {
	const sourceRoot = await mkdtemp(
		pathModule.join(process.cwd(), 'prepare-bench-src-')
	);
	const outputRoot = await mkdtemp(
		pathModule.join(process.cwd(), 'prepare-bench-out-')
	);

	const sources = await Promise.all(
		Array.from({ length: pathCount }, (_, index) =>
			writeStorePath(sourceRoot, index)
		)
	);

	fixture.sourceRoot = sourceRoot;
	fixture.outputRoot = outputRoot;
	fixture.paths = sources.map((source, index) => ({
		source,
		output: pathModule.join(outputRoot, `path-${String(index)}.nar.zst`)
	}));

	const threadPool = process.env.UV_THREADPOOL_SIZE ?? '4 (default)';

	console.log(
		`[prepare-bench] paths=${String(pathCount)} cpus=${String(availableParallelism())} UV_THREADPOOL_SIZE=${threadPool}`
	);
});

afterAll(async () => {
	await rm(fixture.sourceRoot, { recursive: true, force: true });
	await rm(fixture.outputRoot, { recursive: true, force: true });
});

describe('prepare phase: build, compress and hash a closure of NARs', () => {
	for (const concurrency of concurrencyLevels) {
		bench(`concurrency=${String(concurrency)}`, async () => {
			await prepareClosure(concurrency);
		});
	}
});
