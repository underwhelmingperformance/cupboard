import { randomBytes } from 'node:crypto';
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { CacheInfo } from '@cupboard/nix-store/cache-info';
import { NixSha256Hash, toNixBase32 } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	cachePrioritySchema,
	type StoreDirectory,
	storePathHashSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';

const narInfoSuffix = '.narinfo';
const cacheInfoPath = '/nix-cache-info';
const priority = cachePrioritySchema.parse(41);
export const servedNarSize = 4096;

/**
 * A loopback binary cache for tests that exercise a real Nix daemon. It serves
 * `nix-cache-info` and a narinfo for each path registered with
 * {@link FakeSubstituter.serve}, records every narinfo request, and returns 404
 * for all other paths. Tests can therefore distinguish a request that reached
 * this cache from a response Nix had already cached.
 *
 * The store paths exist only as metadata. Tests never request their NAR
 * contents.
 */
export class FakeSubstituter {
	static async start(storeDirectory: StoreDirectory): Promise<FakeSubstituter> {
		const substituter = new FakeSubstituter(storeDirectory);

		await substituter.listen();

		return substituter;
	}

	private readonly served = new Map<string, NarInfo>();
	private readonly requestedHashes: string[] = [];
	private readonly cacheInfo: CacheInfo;
	private readonly server: Server;
	private origin = '';

	private constructor(private readonly storeDirectory: StoreDirectory) {
		this.cacheInfo = new CacheInfo(storeDirectory, true, priority);
		this.server = createServer((request, response) => {
			this.route(request, response);
		});
	}

	private listen(): Promise<void> {
		return new Promise((resolve, reject) => {
			const onError = (error: Error): void => {
				reject(error);
			};

			this.server.once('error', onError);
			this.server.listen(0, '127.0.0.1', () => {
				this.server.removeListener('error', onError);
				const address = this.server.address();

				if (address === null || typeof address === 'string') {
					reject(new FakeSubstituterAddressError(address));
					return;
				}

				this.origin = originOf(address);
				resolve();
			});
		});
	}

	private route(request: IncomingMessage, response: ServerResponse): void {
		const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');

		if (pathname === cacheInfoPath) {
			send(response, 200, this.cacheInfo.render());
			return;
		}

		if (!pathname.endsWith(narInfoSuffix)) {
			send(response, 404, '');
			return;
		}

		const hash = pathname.slice(1, -narInfoSuffix.length);
		this.requestedHashes.push(hash);

		const narInfo = this.served.get(hash);

		if (narInfo === undefined) {
			send(response, 404, '');
			return;
		}

		send(response, 200, narInfo.render());
	}

	/**
	The URL to use in Nix's `substituters` setting.
	*/
	get url(): string {
		return this.origin;
	}

	/**
	Narinfo hash parts requested since `forgetRequests` was last called.
	*/
	get narInfoRequests(): readonly string[] {
		return [...this.requestedHashes];
	}

	/**
	 * Creates a fresh store path, registers it with this cache, and returns the
	 * path. Nothing else on the machine has that path, so an availability result
	 * can come only from this cache or from a client's cached result.
	 */
	serve(name: string): StorePathString {
		const hash = storePathHashSchema.parse(
			toNixBase32(randomBytes(32)).slice(0, 32)
		);
		const storePath = storePathSchema.parse(
			`${this.storeDirectory}/${hash}-${name}`
		);

		this.servePath(storePath);

		return storePath;
	}

	/**
	 * Serves a path that already exists elsewhere, such as an output path from a
	 * real derivation. Unless the caller provides a NAR hash, the cache advertises
	 * a hash of its own fixture bytes.
	 */
	servePath(
		storePath: StorePathString,
		narHash?: NixSha256Hash
	): NixSha256Hash {
		const digest = narHash ?? NixSha256Hash.fromDigest(randomBytes(32));
		const hash = StorePath.hash(storePath);

		this.served.set(
			hash,
			new NarInfo(
				new StorePath(storePath),
				`nar/${hash}.nar`,
				'zstd',
				digest,
				servedNarSize,
				digest,
				servedNarSize,
				[]
			)
		);

		return digest;
	}

	/**
	Stops serving a path, which simulates an upstream removing it.
	*/
	withdraw(storePath: StorePathString): void {
		this.served.delete(StorePath.hash(storePath));
	}

	forgetRequests(): void {
		this.requestedHashes.length = 0;
	}

	async stop(): Promise<void> {
		this.server.closeAllConnections();

		await new Promise<void>((resolve, reject) => {
			this.server.close((error) => {
				if (error === undefined) {
					resolve();
					return;
				}

				reject(error);
			});
		});
	}
}

export class FakeSubstituterAddressError extends Error {
	constructor(public readonly address: string | null) {
		super('the fake substituter did not report a TCP address');
		this.name = 'FakeSubstituterAddressError';
	}
}

function originOf(address: AddressInfo): string {
	return `http://127.0.0.1:${String(address.port)}`;
}

function send(response: ServerResponse, status: number, body: string): void {
	response.writeHead(status, {
		'content-type': 'text/plain; charset=utf-8',
		'content-length': String(Buffer.byteLength(body))
	});
	response.end(body);
}
