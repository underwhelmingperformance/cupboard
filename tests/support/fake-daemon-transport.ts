import { expect } from 'vitest';

import type { NixDaemonTransport } from '../../packages/nix/src/nix-daemon.ts';

import { ProtocolWriter } from './protocol-writer.ts';

export interface FakePathInfo {
	readonly hash: string;
	readonly narSize: number;
	readonly references: readonly string[];
	readonly deriver?: string;
	readonly ca?: string;
	readonly signatures: readonly string[];
	readonly ultimate?: boolean;
}

export class FakeDaemonTransport implements NixDaemonTransport {
	private readonly pendingBytes: Buffer[] = [];
	private writeCount = 0;

	closed = false;

	readonly temporaryRoots: string[] = [];

	constructor(
		private readonly paths: Readonly<Record<string, FakePathInfo>>,
		private readonly options: {
			readonly protocolMinor?: number;
			readonly trust?: number;
			readonly expectedSetOptions?: FakeSetOptionsFields;
			readonly expectedOverrides?: Readonly<Record<string, string>>;
			readonly substitutable?: FakeSubstitutable;
			readonly derivationOutputs?: FakeDerivationOutputs;
			readonly missing?: FakeMissing;
			readonly features?: readonly string[];
			readonly expectedPathInfoBatch?: readonly string[];
			readonly nar?: FakeNar;
			readonly builds?: FakeBuilds;
			readonly beforeOperation?: (request: Buffer) => Promise<void>;
		} = {}
	) {}

	async write(bytes: Uint8Array): Promise<void> {
		this.writeCount += 1;

		if (this.writeCount === 1) {
			this.pendingBytes.push(
				handshakeResponse(this.options.protocolMinor ?? 38)
			);
			return;
		}

		if (this.writeCount === 2) {
			expect(readStringList(Buffer.from(bytes), 0)).toStrictEqual([
				'queryPathInfos'
			]);
			this.pendingBytes.push(stringSetResponse(this.options.features ?? []));
			return;
		}

		if (this.writeCount === 3) {
			this.pendingBytes.push(postHandshakeResponse(this.options.trust ?? 0));
			return;
		}

		if (this.writeCount === 4) {
			const request = readSetOptionsRequest(Buffer.from(bytes));

			expect(request.overrides).toStrictEqual(
				this.options.expectedOverrides ?? {}
			);
			expect(request.overrideNames).toStrictEqual(
				[...request.overrideNames].toSorted((left, right) =>
					left.localeCompare(right)
				)
			);

			if (this.options.expectedSetOptions !== undefined) {
				expect(request.setOptions).toStrictEqual(
					this.options.expectedSetOptions
				);
			}

			this.pendingBytes.push(stderrLastResponse());
			return;
		}

		const request = Buffer.from(bytes);
		await this.options.beforeOperation?.(request);
		const response = daemonOperationResponse(
			request,
			this.paths,
			this.options,
			this.temporaryRoots
		);
		const buffers = Buffer.isBuffer(response) ? [response] : response;

		for (const buffer of buffers) {
			this.pendingBytes.push(buffer);
		}
	}

	// Serves reads across pending buffers the way a socket delivers bytes
	// regardless of how the peer's writes were framed.
	read(byteLength: number): Promise<Uint8Array> {
		if (byteLength === 0) {
			return Promise.resolve(new Uint8Array());
		}

		const available = this.pendingBytes.reduce(
			(total, chunk) => total + chunk.byteLength,
			0
		);

		if (available < byteLength) {
			throw new FakeDaemonReadUnderflowError(byteLength);
		}

		const result = Buffer.alloc(byteLength);
		let offset = 0;

		while (offset < byteLength) {
			const chunk = this.pendingBytes[0];

			if (chunk === undefined) {
				throw new FakeDaemonReadUnderflowError(byteLength);
			}

			const take = Math.min(chunk.byteLength, byteLength - offset);
			chunk.copy(result, offset, 0, take);
			offset += take;

			if (take === chunk.byteLength) {
				this.pendingBytes.shift();
				continue;
			}

			this.pendingBytes[0] = chunk.subarray(take);
		}

		return Promise.resolve(result);
	}

	close(): Promise<void> {
		this.closed = true;
		this.pendingBytes.length = 0;

		return Promise.resolve();
	}

	/**
	 * The response frames buffered so far, cleared. A fake that bridges this
	 * transport onto another byte channel (an ssh child's stdio) emits them
	 * there after each write.
	 */
	takeResponses(): readonly Buffer[] {
		const frames = [...this.pendingBytes];
		this.pendingBytes.length = 0;

		return frames;
	}
}

export class FakeDaemonReadUnderflowError extends Error {
	constructor(public readonly byteLength: number) {
		super(`Fake daemon read underflow: ${String(byteLength)}`);
		this.name = 'FakeDaemonReadUnderflowError';
	}
}

export interface FakeNar {
	readonly expectedPath: string;
	readonly frames: readonly Buffer[];
}

export interface FakeBuilds {
	readonly expectedTargets: readonly string[];
	readonly results: readonly FakeBuildResult[];
}

export interface FakeBuildResult {
	/** The derived path in its wire spelling, with `!` before outputs. */
	readonly target: string;
	readonly status: number;
	readonly errorMessage: string;
	readonly timesBuilt: number;
	readonly nonDeterministic: boolean;
	readonly startTime: number;
	readonly stopTime: number;
	readonly cpuUserMicroseconds?: number;
	readonly cpuSystemMicroseconds?: number;
	readonly builtOutputs: readonly {
		readonly id: string;
		readonly realisation: string;
	}[];
}

interface FakeSubstitutable {
	readonly expectedPaths: readonly string[];
	readonly paths: readonly string[];
}

type FakeDerivationOutputs = Readonly<
	Record<string, Readonly<Record<string, string | undefined>>>
>;

interface FakeMissing {
	readonly expectedTargets: readonly string[];
	readonly willBuild: readonly string[];
	readonly willSubstitute: readonly string[];
	readonly unknown: readonly string[];
	readonly downloadSize: number;
	readonly narSize: number;
}

function daemonOperationResponse(
	request: Buffer,
	paths: Readonly<Record<string, FakePathInfo>>,
	options: {
		readonly substitutable?: FakeSubstitutable;
		readonly derivationOutputs?: FakeDerivationOutputs;
		readonly missing?: FakeMissing;
		readonly expectedPathInfoBatch?: readonly string[];
		readonly nar?: FakeNar;
		readonly builds?: FakeBuilds;
	},
	temporaryRoots: string[]
): Buffer | readonly Buffer[] {
	const operation = Number(request.readBigUInt64LE(0));

	if (operation === 46) {
		return buildPathsWithResultsResponse(request, options.builds);
	}

	if (operation === 11) {
		temporaryRoots.push(readRequestStorePath(request));

		const response = new ProtocolWriter();
		response.writeInteger(0x61_6c_74_73);
		response.writeInteger(1);

		return response.bytes();
	}

	if (operation === 38) {
		if (options.nar === undefined) {
			throw new Error('Unexpected NarFromPath request');
		}

		expect(readRequestStorePath(request)).toBe(options.nar.expectedPath);

		return [stderrLastResponse(), ...options.nar.frames];
	}

	if (operation === 26) {
		return queryPathInfoResponse(request, paths);
	}

	if (operation === 31) {
		return queryValidPathsResponse(request, paths);
	}

	if (operation === 32) {
		return querySubstitutablePathsResponse(request, options.substitutable);
	}

	if (operation === 40) {
		return queryMissingResponse(request, options.missing);
	}

	if (operation === 41) {
		return queryDerivationOutputMapResponse(
			request,
			options.derivationOutputs ?? {}
		);
	}

	if (operation === 50) {
		return queryPathInfosResponse(
			request,
			paths,
			options.expectedPathInfoBatch
		);
	}

	throw new Error(`Unexpected fake daemon operation: ${String(operation)}`);
}

function queryPathInfosResponse(
	request: Buffer,
	paths: Readonly<Record<string, FakePathInfo>>,
	expectedPaths: readonly string[] | undefined
): Buffer {
	const requested = readRequestStringSet(request);

	if (expectedPaths !== undefined) {
		expect(requested).toStrictEqual(expectedPaths);
	}

	const infos = requested.flatMap((storePath) => {
		const info = paths[storePath];

		return info === undefined ? [] : [{ storePath, info }];
	});
	const response = new ProtocolWriter();
	response.writeInteger(0x61_6c_74_73);
	response.writeInteger(infos.length);

	for (const { storePath, info } of infos) {
		response.writeString(storePath);
		writeUnkeyedPathInfo(response, info);
	}

	return response.bytes();
}

function buildPathsWithResultsResponse(
	request: Buffer,
	builds: FakeBuilds | undefined
): Buffer {
	if (builds === undefined) {
		throw new Error('Unexpected BuildPathsWithResults request');
	}

	expect(readRequestStringSet(request)).toStrictEqual(builds.expectedTargets);

	const buildModeOffset = request.byteLength - 8;
	expect(Number(request.readBigUInt64LE(buildModeOffset))).toBe(0);

	const response = new ProtocolWriter();
	response.writeInteger(0x61_6c_74_73);
	response.writeInteger(builds.results.length);

	for (const result of builds.results) {
		response.writeString(result.target);
		response.writeInteger(result.status);
		response.writeString(result.errorMessage);
		response.writeInteger(result.timesBuilt);
		response.writeBoolean(result.nonDeterministic);
		response.writeInteger(result.startTime);
		response.writeInteger(result.stopTime);
		writeOptionalInteger(response, result.cpuUserMicroseconds);
		writeOptionalInteger(response, result.cpuSystemMicroseconds);
		response.writeInteger(result.builtOutputs.length);

		for (const output of result.builtOutputs) {
			response.writeString(output.id);
			response.writeString(output.realisation);
		}
	}

	return response.bytes();
}

function writeOptionalInteger(
	response: ProtocolWriter,
	value: number | undefined
): void {
	if (value === undefined) {
		response.writeBoolean(false);
		return;
	}

	response.writeBoolean(true);
	response.writeInteger(value);
}

function queryMissingResponse(
	request: Buffer,
	missing: FakeMissing | undefined
): Buffer {
	if (missing === undefined) {
		throw new Error('Unexpected QueryMissing request');
	}

	expect(readRequestStringSet(request)).toStrictEqual(missing.expectedTargets);

	const response = new ProtocolWriter();
	response.writeInteger(0x61_6c_74_73);
	response.writeStringSet(missing.willBuild);
	response.writeStringSet(missing.willSubstitute);
	response.writeStringSet(missing.unknown);
	response.writeInteger(missing.downloadSize);
	response.writeInteger(missing.narSize);

	return response.bytes();
}

function queryDerivationOutputMapResponse(
	request: Buffer,
	outputs: FakeDerivationOutputs
): Buffer {
	const drvPath = readRequestStorePath(request);
	const entries = Object.entries(outputs[drvPath] ?? {}).toSorted(
		([left], [right]) => left.localeCompare(right)
	);
	const response = new ProtocolWriter();
	response.writeInteger(0x61_6c_74_73);
	response.writeInteger(entries.length);

	for (const [output, storePath] of entries) {
		response.writeString(output);
		response.writeString(storePath ?? '');
	}

	return response.bytes();
}

function queryValidPathsResponse(
	request: Buffer,
	paths: Readonly<Record<string, FakePathInfo>>
): Buffer {
	const requested = readRequestStringSet(request);
	const substituteFlagOffset = request.byteLength - 8;

	expect(Number(request.readBigUInt64LE(substituteFlagOffset))).toBe(0);

	const response = new ProtocolWriter();
	response.writeInteger(0x61_6c_74_73);
	response.writeStringSet(
		requested.filter((storePath) => paths[storePath] !== undefined)
	);

	return response.bytes();
}

function querySubstitutablePathsResponse(
	request: Buffer,
	substitutable: FakeSubstitutable | undefined
): Buffer {
	if (substitutable === undefined) {
		throw new Error('Unexpected QuerySubstitutablePaths request');
	}

	expect(readRequestStringSet(request)).toStrictEqual(
		substitutable.expectedPaths
	);

	const response = new ProtocolWriter();
	response.writeInteger(0x61_6c_74_73);
	response.writeStringSet(substitutable.paths);

	return response.bytes();
}

function queryPathInfoResponse(
	request: Buffer,
	paths: Readonly<Record<string, FakePathInfo>>
): Buffer {
	const storePath = readRequestStorePath(request);
	const pathInfo = paths[storePath];
	const response = new ProtocolWriter();
	response.writeInteger(0x61_6c_74_73);

	if (pathInfo === undefined) {
		response.writeBoolean(false);
		return response.bytes();
	}

	response.writeBoolean(true);
	writeUnkeyedPathInfo(response, pathInfo);

	return response.bytes();
}

function writeUnkeyedPathInfo(
	response: ProtocolWriter,
	pathInfo: FakePathInfo
): void {
	response.writeString(pathInfo.deriver ?? '');
	response.writeString(pathInfo.hash);
	response.writeStringSet(pathInfo.references);
	response.writeInteger(1);
	response.writeInteger(pathInfo.narSize);
	response.writeBoolean(pathInfo.ultimate ?? false);
	response.writeStringSet(pathInfo.signatures);
	response.writeString(pathInfo.ca ?? '');
}

interface FakeSetOptionsFields {
	readonly keepFailed: boolean;
	readonly keepGoing: boolean;
	readonly tryFallback: boolean;
	readonly maxBuildJobs: number;
	readonly maxSilentTime: number;
	readonly buildCores: number;
	readonly useSubstitutes: boolean;
}

function readSetOptionsRequest(request: Buffer): {
	readonly setOptions: FakeSetOptionsFields;
	readonly overrides: Readonly<Record<string, string>>;
	readonly overrideNames: readonly string[];
} {
	let offset = 8;
	const readInteger = (): number => {
		const value = Number(request.readBigUInt64LE(offset));
		offset += 8;

		return value;
	};
	const readString = (): string => {
		const length = readInteger();
		const value = request.subarray(offset, offset + length).toString('utf8');
		offset += length + ((8 - (length % 8)) % 8);

		return value;
	};

	const isKeepFailed = readInteger() !== 0;
	const shouldKeepGoing = readInteger() !== 0;
	const shouldTryFallback = readInteger() !== 0;
	readInteger();
	const maxBuildJobs = readInteger();
	const maxSilentTime = readInteger();
	readInteger();
	readInteger();
	readInteger();
	readInteger();
	const buildCores = readInteger();
	const shouldUseSubstitutes = readInteger() !== 0;
	const count = readInteger();
	const overrides: Record<string, string> = {};
	const overrideNames: string[] = [];

	for (let index = 0; index < count; index += 1) {
		const key = readString();
		overrideNames.push(key);
		overrides[key] = readString();
	}

	return {
		overrideNames,
		setOptions: {
			keepFailed: isKeepFailed,
			keepGoing: shouldKeepGoing,
			tryFallback: shouldTryFallback,
			maxBuildJobs,
			maxSilentTime,
			buildCores,
			useSubstitutes: shouldUseSubstitutes
		},
		overrides
	};
}

export function readRequestStorePath(request: Buffer): string {
	let offset = 8;
	const length = Number(request.readBigUInt64LE(offset));
	offset += 8;

	return request.subarray(offset, offset + length).toString('utf8');
}

function readRequestStringSet(request: Buffer): string[] {
	return readStringList(request, 8);
}

function readStringList(request: Buffer, start: number): string[] {
	let offset = start;
	const count = Number(request.readBigUInt64LE(offset));
	offset += 8;
	const values: string[] = [];

	for (let index = 0; index < count; index += 1) {
		const length = Number(request.readBigUInt64LE(offset));
		offset += 8;
		values.push(request.subarray(offset, offset + length).toString('utf8'));
		offset += length + ((8 - (length % 8)) % 8);
	}

	return values;
}

function handshakeResponse(protocolMinor: number): Buffer {
	const response = new ProtocolWriter();
	response.writeInteger(0x64_78_69_6f);
	response.writeInteger((1 << 8) | protocolMinor);

	return response.bytes();
}

function stringSetResponse(values: readonly string[]): Buffer {
	const response = new ProtocolWriter();
	response.writeStringSet(values);

	return response.bytes();
}

function postHandshakeResponse(trust: number): Buffer {
	const response = new ProtocolWriter();
	response.writeString('2.33.3');
	response.writeInteger(trust);
	response.writeInteger(0x61_6c_74_73);

	return response.bytes();
}

function stderrLastResponse(): Buffer {
	const response = new ProtocolWriter();
	response.writeInteger(0x61_6c_74_73);

	return response.bytes();
}
