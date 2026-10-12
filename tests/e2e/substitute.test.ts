import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse
} from 'node:http';
import path from 'node:path';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import { renderNetrc } from '@cupboard/nix-store/nix-config';
import { storePathSchema } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CupboardClient } from '../../packages/cli/src/client/client.ts';
import { UploadVerificationFailedError } from '../../packages/cli/src/errors.ts';
import type { PushClient } from '../../packages/cli/src/push/push.ts';
import { fingerprint, pseudoRandomBytes } from '../support/bytes.ts';
import {
	CupboardTestServer,
	type TenantProvisionSpec
} from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import {
	generatePublicKey,
	type NixPathInfo,
	NixStore,
	type RealiseOptions
} from '../support/nix.ts';
import {
	negotiateUpload,
	type PushContext,
	pushStorePaths
} from '../support/push.ts';

const root = path.resolve(import.meta.dirname, '../..');
const contentAddressedFixture = path.join(root, 'tests/fixtures/simple/source');

async function isFilePresent(file: string): Promise<boolean> {
	try {
		await readFile(file);
		return true;
	} catch {
		return false;
	}
}

async function rejectedBy(run: () => Promise<unknown>): Promise<unknown> {
	let rejected: unknown;

	try {
		await run();
	} catch (error) {
		rejected = error;
	}

	return rejected;
}

function expectUploadVerificationFailed(
	error: unknown
): asserts error is UploadVerificationFailedError {
	expect(error).toBeInstanceOf(UploadVerificationFailedError);
}

function namedBytesShape(value: string): {
	readonly name: string;
	readonly rawBytes: number;
} {
	const [name, encoded] = z
		.tuple([z.string().min(1), z.string()])
		.parse(value.split(':'));

	return {
		name,
		rawBytes: Uint8Array.from(
			atob(encoded),
			(character) => character.codePointAt(0) ?? 0
		).byteLength
	};
}

// An input-addressed derivation whose single-file output embeds the path of a
// `builtins.toFile` dependency, so Nix records that dependency as a reference.
// Keeping the output to a single file lets the builder use only shell
// redirection, which matters because the build sandbox has no PATH.
const referencedDerivation = [
	'let dependency = builtins.toFile "cupboard-dependency" "cupboard dependency";',
	'in derivation {',
	'  name = "cupboard-referrer";',
	'  system = builtins.currentSystem;',
	'  builder = "/bin/sh";',
	'  args = [ "-c" "printf %s \\"${dependency}\\" > \\"$out\\"" ];',
	'}'
].join('\n');

describe('Nix substitution', () => {
	it.each(['private-origin', 'public-edge'] as const)(
		'resumes interrupted multipart and multi-frame downloads through %s',
		(mode) =>
			withHarness(
				`cupboard-e2e-download-retry-${mode}-`,
				async (harness) => {
					const contents = pseudoRandomBytes(40 * 1024 * 1024, 3);
					const storePath = await withTemporaryDirectory(
						'cupboard-e2e-download-source-',
						async (directory) => {
							const source = path.join(directory, 'cupboard-interrupted');
							await mkdir(source);
							await writeFile(path.join(source, 'payload.bin'), contents);

							return harness.source.add(source);
						}
					);

					await pushStorePaths(pushContext(harness), [storePath]);
					const narInfo = await fetchNarInfo(harness.server, storePath, mode);
					const interruptions = [8 * 1024 * 1024 - 13, 17 * 1024 * 1024 + 13];
					const proxy = await InterruptedDownloadProxy.start(
						harness.server.url,
						mode,
						interruptions
					);

					try {
						const netrcFile = path.join(harness.directory, 'download.netrc');
						await writeFile(
							netrcFile,
							renderNetrc(proxy.url, 'download-reader', downloadPassword)
						);
						await harness.target.realise(storePath, {
							...signedBy(harness, harness.publicKey),
							substituter: new URL(harness.server.tenantUrl.pathname, proxy.url)
								.href,
							...(mode === 'private-origin' && { netrcFile })
						});
						const realised = await readFile(
							path.join(harness.target.physicalPath(storePath), 'payload.bin')
						);
						const [first, second] = z
							.tuple([z.number(), z.number()])
							.parse(interruptions);

						expect({
							payload: fingerprint(realised),
							storedObject: proxy.storedObject,
							narOriginRequests: proxy.narOriginRequests,
							requests: proxy.observations,
							errors: proxy.errors
						}).toStrictEqual({
							payload: fingerprint(contents),
							storedObject: {
								size: narInfo.fileSize,
								sha256: narInfo.fileHash.digestHex()
							},
							narOriginRequests: mode === 'private-origin' ? 3 : 1,
							requests: [
								{
									range: undefined,
									originStatus: 200,
									status: 200,
									sentBytes: first,
									isInterrupted: true
								},
								{
									range: `bytes=${String(first)}-`,
									originStatus: mode === 'private-origin' ? 206 : 200,
									status: 206,
									sentBytes: second - first,
									isInterrupted: true
								},
								{
									range: `bytes=${String(second)}-`,
									originStatus: mode === 'private-origin' ? 206 : 200,
									status: 206,
									sentBytes: narInfo.fileSize - second,
									isInterrupted: false
								}
							],
							errors: []
						});
					} finally {
						await proxy.stop();
					}
				},
				{
					defaultCacheAccess: mode === 'private-origin' ? 'private' : 'public',
					read: { user: 'download-reader', password: downloadPassword }
				}
			)
	);

	it('substitutes a content-addressed path into a clean store', () =>
		withHarness('cupboard-e2e-ca-', async (harness) => {
			const storePath = await harness.source.add(contentAddressedFixture);

			await pushStorePaths(pushContext(harness), [storePath]);
			await harness.target.realise(
				storePath,
				signedBy(harness, harness.publicKey)
			);

			const realised = harness.target.physicalPath(storePath);

			expect({
				message: await readFile(path.join(realised, 'message.txt'), 'utf8'),
				nested: await readFile(path.join(realised, 'nested/data.txt'), 'utf8')
			}).toStrictEqual({
				message: 'cupboard fixture\n',
				nested: 'stored through nix-store dump\n'
			});
		}));

	it('substitutes a path whose NAR spans several zstd frames', () =>
		withHarness('cupboard-e2e-frames-', async (harness) => {
			// A 40 MiB file gives a NAR of three zstd frames: two of 16 MiB and
			// one of about 8 MiB. zstd cannot compress the bytes, so the upload
			// also has several 8 MiB parts. Fixed bytes give every run the same
			// store path, so repeated runs add nothing new to the host's store.
			const contents = pseudoRandomBytes(40 * 1024 * 1024, 1);
			const storePath = await withTemporaryDirectory(
				'cupboard-e2e-frames-source-',
				async (directory) => {
					const source = path.join(directory, 'cupboard-multi-frame');
					await mkdir(source);
					await writeFile(path.join(source, 'payload.bin'), contents);

					return harness.source.add(source);
				}
			);

			await pushStorePaths(pushContext(harness), [storePath]);
			await harness.target.realise(
				storePath,
				signedBy(harness, harness.publicKey)
			);

			const realised = await readFile(
				path.join(harness.target.physicalPath(storePath), 'payload.bin')
			);

			expect(fingerprint(realised)).toStrictEqual(fingerprint(contents));
		}));

	it('substitutes a path after the uploader pads its last streamed part', () =>
		withHarness('cupboard-e2e-uploader-padding-', async (harness) => {
			// The first 9 MiB cannot be compressed, so after the first 8 MiB part
			// the uploader estimates that about 40 MiB of compressed bytes remain
			// and streams the second part. The 40 MiB of zeros after them compress
			// to almost nothing, so the compressed NAR ends early in the second
			// part, and a skippable frame fills the rest of it.
			const contents = Buffer.concat([
				pseudoRandomBytes(9 * 1024 * 1024, 2),
				Buffer.alloc(40 * 1024 * 1024)
			]);
			const storePath = await withTemporaryDirectory(
				'cupboard-e2e-uploader-padding-source-',
				async (directory) => {
					const source = path.join(directory, 'cupboard-padded-part');
					await mkdir(source);
					await writeFile(path.join(source, 'payload.bin'), contents);

					return harness.source.add(source);
				}
			);

			await pushStorePaths(pushContext(harness), [storePath]);
			await harness.target.realise(
				storePath,
				signedBy(harness, harness.publicKey)
			);
			const narInfo = await fetchNarInfo(harness.server, storePath);
			const realised = await readFile(
				path.join(harness.target.physicalPath(storePath), 'payload.bin')
			);

			expect({
				fileSize: narInfo.fileSize,
				payload: fingerprint(realised)
			}).toStrictEqual({
				fileSize: 2 * 8 * 1024 * 1024,
				payload: fingerprint(contents)
			});
		}));

	it('substitutes a path whose stored object ends with a skippable frame', () =>
		withHarness('cupboard-e2e-padded-', async (harness) => {
			// The CLI pads a streamed part with a zstd skippable frame when the
			// compressed NAR ends before the part does.
			// Nix must skip the frame when it decompresses the stored object.
			const storePath = await harness.source.add(contentAddressedFixture);
			const upload = await negotiateUpload(pushContext(harness), storePath);
			const padded = Buffer.concat([
				upload.compressed,
				skippableFrame(3 * 1024 * 1024 + 5)
			]);
			await harness.server.stageObject(upload.r2Key, padded);

			const outcome = await harness.client.commit(
				{
					uploadId: upload.uploadId,
					storePathHash: upload.storePathHash,
					narHash: upload.narHash
				},
				{}
			);
			await outcome.settled;
			await harness.target.realise(
				storePath,
				signedBy(harness, harness.publicKey)
			);
			const narInfo = await fetchNarInfo(harness.server, storePath);
			const paddedHash = NixSha256Hash.fromDigest(
				createHash('sha256').update(padded).digest()
			);
			const message = await readFile(
				path.join(harness.target.physicalPath(storePath), 'message.txt'),
				'utf8'
			);

			expect({
				fileSize: narInfo.fileSize,
				fileHash: narInfo.fileHash.toString(),
				message
			}).toStrictEqual({
				fileSize: padded.byteLength,
				fileHash: paddedHash.toString(),
				message: 'cupboard fixture\n'
			});
		}));

	it('substitutes an input-addressed path and its references under require-sigs', () =>
		withHarness('cupboard-e2e-signed-', async (harness) => {
			const referrer = await harness.source.build(referencedDerivation);
			const dependency = singleReference(
				await harness.source.pathInfo(referrer)
			);

			await pushStorePaths(pushContext(harness), [dependency, referrer]);

			const narInfo = await fetchNarInfo(harness.server, referrer);

			expect({
				references: narInfo.references,
				signatures: narInfo.sigs.map((signature) => namedBytesShape(signature))
			}).toStrictEqual({
				references: [StorePath.basename(dependency)],
				signatures: [
					{
						name: namedBytesShape(harness.publicKey).name,
						rawBytes: 64
					}
				]
			});

			await harness.target.realise(
				referrer,
				signedBy(harness, harness.publicKey)
			);

			await expect(
				readFile(harness.target.physicalPath(referrer), 'utf8')
			).resolves.toBe(dependency);
		}));

	it('refuses an input-addressed path signed by an untrusted key', () =>
		withHarness('cupboard-e2e-untrusted-', async (harness) => {
			const referrer = await harness.source.build(referencedDerivation);
			const { references } = await harness.source.pathInfo(referrer);

			await pushStorePaths(pushContext(harness), [...references, referrer]);

			const untrustedKey = await generatePublicKey('cupboard-untrusted-1');

			let outcome: { realised: boolean; targetPresent: boolean };
			try {
				await harness.target.realise(referrer, signedBy(harness, untrustedKey));
				outcome = { realised: true, targetPresent: true };
			} catch {
				outcome = {
					realised: false,
					targetPresent: await isFilePresent(
						harness.target.physicalPath(referrer)
					)
				};
			}

			expect(outcome).toStrictEqual({
				realised: false,
				targetPresent: false
			});
		}));

	it('rejects a commit whose staged bytes do not match the negotiated NAR', () =>
		withHarness('cupboard-e2e-tamper-', async (harness) => {
			const storePath = await harness.source.add(contentAddressedFixture);
			const upload = await negotiateUpload(pushContext(harness), storePath);

			// Corrupt the compressed bytes so they no longer decode to the NAR the
			// commit names. The server derives the hash from what was staged, so a
			// commit over tampered bytes must fail verification.
			const tampered = Uint8Array.from(
				upload.compressed,
				(byte) => byte ^ 0xff
			);
			await harness.server.stageObject(upload.r2Key, tampered);

			const error = await rejectedBy(async () => {
				const outcome = await harness.client.commit(
					{
						uploadId: upload.uploadId,
						storePathHash: upload.storePathHash,
						narHash: upload.narHash
					},
					{}
				);

				// The commit acks first; the tampered bytes fail the background
				// verification, so the mismatch surfaces on the verdict.
				await outcome.settled;
			});

			expectUploadVerificationFailed(error);
			expect({
				uploadId: error.uploadId,
				status: error.status
			}).toStrictEqual({
				uploadId: upload.uploadId,
				status: 'mismatch'
			});
		}));
});

interface Harness {
	readonly directory: string;
	readonly server: CupboardTestServer;
	readonly source: NixStore;
	readonly target: NixStore;
	readonly client: PushClient;
	readonly publicKey: string;
}

function withHarness(
	prefix: string,
	body: (harness: Harness) => Promise<void>,
	provision?: TenantProvisionSpec
): Promise<void> {
	return withTemporaryDirectory(
		prefix,
		async (directory) => {
			const server = await CupboardTestServer.start(directory, { provision });

			try {
				const raw = new CupboardClient(server.tenantUrl, fetch, {
					kind: 'default'
				});
				const token = await server.ownerAdminToken();
				const publicKey = await raw.publicKey();

				await body({
					directory,
					server,
					source: await NixStore.host(path.join(directory, 'source-home')),
					target: await NixStore.chroot(
						path.join(directory, 'target-store'),
						path.join(directory, 'target-home')
					),
					client: server.pushClient(token),
					publicKey
				});
			} finally {
				await server.stop();
			}
		},
		{ makeWritableBeforeCleanup: true }
	);
}

function pushContext(harness: Harness): PushContext {
	return {
		client: harness.client,
		store: harness.source
	};
}

function signedBy(harness: Harness, trustedPublicKey: string): RealiseOptions {
	return {
		substituter: harness.server.tenantUrl.href,
		trustedPublicKeys: [trustedPublicKey],
		requireSigs: true
	};
}

async function fetchNarInfo(
	server: CupboardTestServer,
	storePath: string,
	mode?: DownloadMode
): Promise<NarInfo> {
	const response = await fetch(
		server.tenantPath(`/${StorePath.hash(storePath)}.narinfo`),
		mode === 'private-origin'
			? {
					headers: {
						authorization: `Basic ${Buffer.from(`download-reader:${downloadPassword}`).toString('base64')}`
					}
				}
			: undefined
	);

	return NarInfo.parse(await response.text());
}

type DownloadMode = 'private-origin' | 'public-edge';
const downloadPassword = 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23';

interface DownloadObservation {
	readonly range: string | undefined;
	readonly originStatus: number;
	readonly status: number;
	readonly sentBytes: number;
	readonly isInterrupted: boolean;
}

interface CachedDownload {
	readonly bytes: Uint8Array;
	readonly headers: Headers;
	readonly status: number;
}

class DownloadProxyAddressError extends Error {
	constructor() {
		super('The download proxy did not receive an IP address.');
		this.name = 'DownloadProxyAddressError';
	}
}

class InterruptedDownloadProxy {
	static async start(
		upstream: URL,
		mode: DownloadMode,
		interruptions: readonly number[]
	): Promise<InterruptedDownloadProxy> {
		const proxy = new InterruptedDownloadProxy(upstream, mode, interruptions);
		await new Promise<void>((resolve, reject) => {
			proxy.server.once('error', reject);
			proxy.server.listen(0, '127.0.0.1', () => {
				proxy.server.removeListener('error', reject);
				resolve();
			});
		});
		return proxy;
	}

	private readonly server: Server;
	private readonly active = new Set<Promise<void>>();
	private readonly controller = new AbortController();
	private readonly cached = new Map<string, CachedDownload>();
	readonly observations: DownloadObservation[] = [];
	readonly errors: string[] = [];
	storedObject: ReturnType<typeof fingerprint> | undefined;
	narOriginRequests = 0;

	private constructor(
		private readonly upstream: URL,
		private readonly mode: DownloadMode,
		private readonly interruptions: readonly number[]
	) {
		this.server = createServer((request, response) => {
			const pending = this.respond(request, response);
			this.active.add(pending);
			void pending.finally(() => this.active.delete(pending));
		});
	}

	private async respond(
		request: IncomingMessage,
		response: ServerResponse
	): Promise<void> {
		try {
			await this.forward(request, response);
		} catch (error) {
			this.errors.push(error instanceof Error ? error.message : String(error));
			if (response.destroyed) {
				return;
			}
			response.writeHead(500);
			response.end();
		}
	}

	private async forward(
		request: IncomingMessage,
		response: ServerResponse
	): Promise<void> {
		const url = new URL(request.url ?? '/', this.upstream);
		const headers = new Headers();
		for (const [key, value] of Object.entries(request.headers)) {
			if (value === undefined || key === 'host') {
				continue;
			}
			const parts = Array.isArray(value) ? value : [value];
			for (const part of parts) {
				headers.append(key, part);
			}
		}
		const isNar = url.pathname.includes('/nar/');
		const upstream = await this.originResponse(url, headers, isNar);
		const bytes = upstream.bytes;
		const outgoing = new Headers(upstream.headers);
		outgoing.delete('transfer-encoding');
		outgoing.set('connection', 'close');
		if (!isNar) {
			response.writeHead(upstream.status, Object.fromEntries(outgoing));
			response.end(bytes);
			return;
		}

		const range = request.headers.range;
		const offset =
			range === undefined
				? 0
				: Number(
						z
							.string()
							.regex(/^bytes=\d+-$/)
							.parse(range)
							.slice(6, -1)
					);
		let body = bytes;
		let status = upstream.status;
		if (this.observations.length === 0) {
			this.storedObject = fingerprint(bytes);
		}
		if (
			range !== undefined &&
			this.mode === 'public-edge' &&
			upstream.status === 200
		) {
			body = bytes.subarray(offset);
			status = 206;
			outgoing.set(
				'content-range',
				`bytes ${String(offset)}-${String(bytes.byteLength - 1)}/${String(bytes.byteLength)}`
			);
			outgoing.set('content-length', String(body.byteLength));
		}
		const cutoff = this.interruptions[this.observations.length];
		const isInterrupted = cutoff !== undefined;
		const sent =
			cutoff === undefined ? body : body.subarray(0, cutoff - offset);
		this.observations.push({
			range,
			originStatus: upstream.status,
			status,
			sentBytes: sent.byteLength,
			isInterrupted
		});
		response.writeHead(status, Object.fromEntries(outgoing));
		response.end(sent);
	}

	private async originResponse(
		url: URL,
		headers: Headers,
		isNar: boolean
	): Promise<CachedDownload> {
		if (isNar && this.mode === 'public-edge') {
			const cached = this.cached.get(url.href);
			if (cached !== undefined) {
				return cached;
			}
			headers.delete('range');
		}
		if (isNar) {
			this.narOriginRequests += 1;
		}
		const response = await fetch(url, {
			headers,
			signal: this.controller.signal
		});
		const result: CachedDownload = {
			bytes: new Uint8Array(await response.arrayBuffer()),
			headers: new Headers(response.headers),
			status: response.status
		};
		if (isNar && this.mode === 'public-edge' && response.status === 200) {
			this.cached.set(url.href, result);
		}
		return result;
	}
	get url(): URL {
		const address = this.server.address();
		if (address === null || typeof address === 'string') {
			throw new DownloadProxyAddressError();
		}
		return new URL(`http://127.0.0.1:${String(address.port)}`);
	}

	async stop(): Promise<void> {
		this.controller.abort();
		this.server.closeAllConnections();
		await new Promise<void>((resolve, reject) => {
			this.server.close((error) => {
				if (error !== undefined) {
					reject(error);
					return;
				}
				resolve();
			});
		});
		await Promise.allSettled(this.active);
	}
}

// A zstd skippable frame of `size` bytes: the magic number, the payload
// length and a payload of zeros.
function skippableFrame(size: number): Buffer {
	const frame = Buffer.alloc(size);

	frame.writeUInt32LE(0x18_4d_2a_50, 0);
	frame.writeUInt32LE(size - 8, 4);

	return frame;
}

function singleReference(info: NixPathInfo): string {
	const [reference] = z.tuple([storePathSchema]).parse(info.references);

	return reference;
}
