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
const narSize = 4096;

/**
 * A binary cache over loopback whose contents a test moves in and out while a
 * real Nix daemon reads it. It answers `nix-cache-info` and the narinfo of
 * every path {@link FakeSubstituter.serve} registered, records the narinfo
 * requests that reach it, and answers 404 for anything else, so a test can
 * tell a request that crossed the wire from an answer Nix had already cached.
 *
 * The paths it serves exist nowhere: only their metadata is ever read, and the
 * NAR each narinfo names is never requested.
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
			this.server.once('error', reject);
			this.server.listen(0, '127.0.0.1', () => {
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

	/** The substituter URL a Nix `substituters` setting names. */
	get url(): string {
		return this.origin;
	}

	/** The hash part of every narinfo requested since the last forgetting. */
	get narInfoRequests(): readonly string[] {
		return [...this.requestedHashes];
	}

	/**
	 * Registers a store path this cache serves, under a name of the caller's
	 * choosing and a hash part fresh for this run, and returns it. Nothing
	 * else on the machine holds the path, so an answer about it can only have
	 * come from this cache or from a client's memory of it.
	 */
	serve(name: string): StorePathString {
		const digest = NixSha256Hash.fromDigest(randomBytes(32));
		const hash = storePathHashSchema.parse(
			toNixBase32(randomBytes(32)).slice(0, 32)
		);
		const storePath = storePathSchema.parse(
			`${this.storeDirectory}/${hash}-${name}`
		);

		this.served.set(
			hash,
			new NarInfo(
				new StorePath(storePath),
				`nar/${hash}.nar`,
				'zstd',
				digest,
				narSize,
				digest,
				narSize,
				[]
			)
		);

		return storePath;
	}

	/** Stops serving a path, as an upstream dropping it does. */
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
