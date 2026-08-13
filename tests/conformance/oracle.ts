import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it } from 'vitest';

import {
	ConformanceNixUnavailableError,
	type NixOptions,
	type NixResult,
	oracleFileName,
	oracleFilePath,
	type OracleRecord,
	parseFlakeLockRevision,
	parseOracleRecord,
	readNixVersion,
	requiresConformanceOracle,
	resolveConformanceNixBinary,
	runNix
} from '../../scripts/conformance-oracle.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { isolatedEnvironment } from '../support/nix.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

/** The nix the record names, read once so a case can assert against it. */
export const recordedOracle: OracleRecord = parseOracleRecord(
	readFileSync(path.join(import.meta.dirname, oracleFileName), 'utf8')
);

/** The nixpkgs revision the lockfile pins, which the oracle is built from. */
export const lockedNixpkgsRevision: string = parseFlakeLockRevision(
	readFileSync(path.join(repositoryRoot, 'flake.lock'), 'utf8')
);

export class OracleVersionDriftError extends Error {
	constructor(
		public readonly recorded: string,
		public readonly resolved: string
	) {
		super(
			`${oracleFilePath} records ${recorded}, but the flake now builds ` +
				`${resolved}. Run \`pnpm update:conformance-oracle\` to refresh it.`
		);
		this.name = 'OracleVersionDriftError';
	}
}

/**
 * The `nix` a conformance case compares our client against. Every invocation
 * runs in an environment the caller supplies, which is how a case states the
 * configuration it is asking about.
 */
export class Oracle {
	constructor(
		private readonly binary: string,
		public readonly version: string
	) {}

	run(
		arguments_: readonly string[],
		options: NixOptions = {}
	): Promise<NixResult> {
		return runNix(this.binary, arguments_, options);
	}

	/**
	 * Runs one of the other tools this same `nix` ships, such as `nix-store`.
	 * They sit beside it, so a case asking one of them asks the pinned oracle
	 * rather than whatever the machine has on its `PATH`.
	 */
	runTool(
		tool: string,
		arguments_: readonly string[],
		options: NixOptions = {}
	): Promise<NixResult> {
		return runNix(
			path.join(path.dirname(this.binary), tool),
			arguments_,
			options
		);
	}
}

type OracleResolution =
	| { readonly kind: 'available'; readonly oracle: Oracle }
	| { readonly kind: 'unavailable'; readonly reason: string }
	| { readonly kind: 'drifted'; readonly error: OracleVersionDriftError };

async function resolveOracle(): Promise<OracleResolution> {
	let binary: string;

	try {
		binary = await resolveConformanceNixBinary(repositoryRoot);
	} catch (error) {
		if (error instanceof ConformanceNixUnavailableError) {
			if (requiresConformanceOracle()) {
				throw error;
			}

			return { kind: 'unavailable', reason: error.reason };
		}

		throw error;
	}

	const version = await withTemporaryDirectory(
		'cupboard-conformance-version-',
		async (home) => readNixVersion(binary, await isolatedEnvironment(home))
	);

	if (version !== recordedOracle.version) {
		return {
			kind: 'drifted',
			error: new OracleVersionDriftError(recordedOracle.version, version)
		};
	}

	return { kind: 'available', oracle: new Oracle(binary, version) };
}

// Resolving costs a flake build, so each test file does it once and every case
// in the file shares the answer.
const resolution = await resolveOracle();

/**
 * Declares a suite of cases that run against the pinned oracle.
 *
 * A machine that cannot build the oracle reports the suite as skipped, naming
 * why, so a missing oracle never reads as a pass. A machine that builds one the
 * record does not name reports a single failure instead: comparing our client
 * against an unrecorded `nix` would answer a question nobody asked.
 */
export function describeConformance(
	name: string,
	body: (oracle: Oracle) => void
): void {
	if (resolution.kind === 'unavailable') {
		const { reason } = resolution;

		describe(name, () => {
			it('compares our client against the nix the flake pins', (context) => {
				context.skip(reason);
			});
		});

		return;
	}

	if (resolution.kind === 'drifted') {
		const { error } = resolution;

		describe(name, () => {
			it('compares our client against the nix the record names', () => {
				throw error;
			});
		});

		return;
	}

	const { oracle } = resolution;

	describe(name, () => {
		body(oracle);
	});
}
