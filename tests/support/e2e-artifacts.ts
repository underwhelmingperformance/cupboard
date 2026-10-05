import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import {
	type DeploymentArtifact,
	type EmbeddedPayload,
	payloadToArtifact
} from '../../packages/cli/src/deploy/artifact.ts';
import { parseEmbeddedPayload } from '../../packages/cli/src/deploy/embedded.ts';

export interface TestWorkerBundle {
	readonly directory: string;
	readonly controlEntrypoint: string;
	readonly tenantEntrypoint: string;
}

export interface PredecessorBundles {
	readonly control: string;
	readonly tenant: string;
}

export interface EndToEndArtifactManifest {
	readonly checkoutRoot: string;
	readonly workerBundle: TestWorkerBundle;
	readonly predecessorBundlesPath: string;
	readonly currentPayloadPath: string;
}

export interface EndToEndArtifactBuilders {
	readonly currentPayload: (checkoutRoot: string) => Promise<EmbeddedPayload>;
	readonly workerBundle: (
		checkoutRoot: string,
		directory: string
	) => Promise<TestWorkerBundle>;
	readonly predecessorBundles: (
		checkoutRoot: string
	) => Promise<PredecessorBundles>;
}

export interface StagedDeploymentArtifacts {
	readonly bundles: PredecessorBundles;
	readonly artifact: DeploymentArtifact;
}

class ArtifactRunDisposedError extends Error {
	constructor() {
		super('The end-to-end artifact run has been disposed');
		this.name = 'ArtifactRunDisposedError';
	}
}

export class EndToEndArtifactRun {
	readonly #directories = new Set<string>();
	readonly #preparations = new Set<Promise<EndToEndArtifactManifest>>();
	#preparing: Promise<EndToEndArtifactManifest> | undefined;
	#disposal: Promise<void> | undefined;
	#isDisposed = false;
	#generation = 0;

	constructor(
		private readonly checkoutRoot: string,
		private readonly builders: EndToEndArtifactBuilders
	) {}

	private async build(): Promise<EndToEndArtifactManifest> {
		const checkoutRoot = await realpath(this.checkoutRoot);
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-e2e-artifacts-')
		);
		this.#directories.add(directory);

		try {
			const payload = await this.builders.currentPayload(checkoutRoot);
			const [worker, predecessor] = await Promise.allSettled([
				this.builders.workerBundle(checkoutRoot, directory),
				this.builders.predecessorBundles(checkoutRoot)
			]);
			if (worker.status === 'rejected') {
				const error: unknown = worker.reason;
				throw error;
			}
			if (predecessor.status === 'rejected') {
				const error: unknown = predecessor.reason;
				throw error;
			}
			const workerBundle = worker.value;
			const predecessorBundles = predecessor.value;
			const currentPayloadPath = path.join(directory, 'current-payload.json');
			const predecessorBundlesPath = path.join(
				directory,
				'predecessor-bundles.json'
			);
			await Promise.all([
				writeFile(currentPayloadPath, JSON.stringify(payload)),
				writeFile(predecessorBundlesPath, JSON.stringify(predecessorBundles))
			]);

			return {
				checkoutRoot,
				workerBundle,
				predecessorBundlesPath,
				currentPayloadPath
			};
		} catch (error) {
			await rm(directory, { recursive: true, force: true });
			this.#directories.delete(directory);
			throw error;
		}
	}

	private async prepareBuild(
		generation: number
	): Promise<EndToEndArtifactManifest> {
		try {
			const manifest = await this.build();
			if (this.#isDisposed) {
				throw new ArtifactRunDisposedError();
			}
			return manifest;
		} catch (error) {
			if (generation === this.#generation) {
				this.#preparing = undefined;
			}
			throw error;
		}
	}

	private async removeArtifacts(): Promise<void> {
		await Promise.allSettled(this.#preparations);
		await Promise.all(
			[...this.#directories].map((directory) =>
				rm(directory, { recursive: true, force: true })
			)
		);
		this.#directories.clear();
		this.#preparations.clear();
		this.#preparing = undefined;
	}

	isDisposed(): boolean {
		return this.#isDisposed;
	}

	prepare(): Promise<EndToEndArtifactManifest> {
		if (this.#isDisposed) {
			return Promise.reject(new ArtifactRunDisposedError());
		}
		if (this.#preparing === undefined) {
			this.#preparing = this.prepareBuild(++this.#generation);
			this.#preparations.add(this.#preparing);
		}

		return this.#preparing;
	}

	rebuild(): Promise<EndToEndArtifactManifest> {
		if (this.#isDisposed) {
			return Promise.reject(new ArtifactRunDisposedError());
		}
		this.#preparing = undefined;
		return this.prepare();
	}

	dispose(): Promise<void> {
		this.#isDisposed = true;
		this.#disposal ??= this.removeArtifacts();
		return this.#disposal;
	}
}

export function createEndToEndArtifactRerun(
	run: EndToEndArtifactRun,
	publish: (manifest: EndToEndArtifactManifest) => void
): () => Promise<void> {
	let pending = Promise.resolve();
	async function rebuild(previous: Promise<void>): Promise<void> {
		await Promise.allSettled([previous]);
		if (run.isDisposed()) {
			return;
		}
		try {
			const manifest = await run.rebuild();
			if (!run.isDisposed()) {
				publish(manifest);
			}
		} catch (error) {
			if (!run.isDisposed()) {
				throw error;
			}
		}
	}

	return () => {
		pending = rebuild(pending);
		return pending;
	};
}

const predecessorBundlesSchema = z.strictObject({
	control: z.string(),
	tenant: z.string()
});

class EndToEndArtifactProvider {
	#staged: Promise<StagedDeploymentArtifacts> | undefined;

	constructor(readonly manifest: EndToEndArtifactManifest) {}

	private async readStaged(): Promise<StagedDeploymentArtifacts> {
		const [predecessor, current] = await Promise.all([
			readFile(this.manifest.predecessorBundlesPath, 'utf8'),
			readFile(this.manifest.currentPayloadPath, 'utf8')
		]);

		return {
			bundles: predecessorBundlesSchema.parse(JSON.parse(predecessor)),
			artifact: payloadToArtifact(parseEmbeddedPayload(current))
		};
	}

	async matches(checkoutRoot: string): Promise<boolean> {
		return (await realpath(checkoutRoot)) === this.manifest.checkoutRoot;
	}

	staged(): Promise<StagedDeploymentArtifacts> {
		this.#staged ??= this.readStaged();
		return this.#staged;
	}
}

const registration: { provider: EndToEndArtifactProvider | undefined } = {
	provider: undefined
};

export function registerEndToEndArtifacts(
	manifest: EndToEndArtifactManifest | undefined
): void {
	registration.provider =
		manifest === undefined ? undefined : new EndToEndArtifactProvider(manifest);
}

export async function sharedWorkerBundle(
	checkoutRoot: string
): Promise<TestWorkerBundle | undefined> {
	const current = registration.provider;
	if (current === undefined || !(await current.matches(checkoutRoot))) {
		return undefined;
	}

	return current.manifest.workerBundle;
}

export async function sharedStagedDeployment(
	checkoutRoot: string
): Promise<StagedDeploymentArtifacts | undefined> {
	const current = registration.provider;
	if (current === undefined || !(await current.matches(checkoutRoot))) {
		return undefined;
	}

	return current.staged();
}
