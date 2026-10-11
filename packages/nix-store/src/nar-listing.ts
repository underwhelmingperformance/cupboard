import { ProtocolError } from './errors.ts';

export class InvalidNarListingError extends ProtocolError {
	constructor(reason: string) {
		super(`Cannot generate NAR listing: ${reason}`);
		this.name = 'InvalidNarListingError';
	}
}

export interface NarListingOptions {
	readonly write: (json: string) => void | Promise<void>;
	readonly maxOutputBytes?: number;
	readonly maxEntries?: number;
	readonly maxDepth?: number;
}

interface NarToken {
	readonly text: string;
	readonly size: number;
	readonly offset: number;
}

type TokenMode = 'text' | 'contents';
type Grammar = Generator<TokenMode, void, NarToken>;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function fail(reason: string): never {
	throw new InvalidNarListingError(reason);
}

function isOrderedBefore(left: string, right: string): boolean {
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	const rightBytes = b.values();
	for (const leftByte of a) {
		const rightByte = rightBytes.next();
		if (rightByte.done) {
			return false;
		}
		if (leftByte !== rightByte.value) {
			return leftByte < rightByte.value;
		}
	}
	return a.length < b.length;
}

/**
Emits a bounded version-1 listing from a NAR stream without buffering file contents.
*/
export class NarListingWriter {
	private readonly header = new Uint8Array(8);
	private headerBytes = 0;
	private length: number | undefined;
	private remaining = 0;
	private padding = 0;
	private tokenBytes: Uint8Array | undefined;
	private offset = 0;
	private payloadOffset = 0;
	private readonly grammar: Grammar;
	private request: IteratorResult<TokenMode, void>;
	private readonly pending: string[] = [];
	private outputBytes = 0;
	private entries = 0;
	private ended = false;

	constructor(private readonly options: NarListingOptions) {
		this.grammar = this.archive();
		this.request = this.grammar.next();
	}

	private emit(json: string): void {
		this.outputBytes += encoder.encode(json).byteLength;
		if (this.outputBytes > (this.options.maxOutputBytes ?? 64 * 1024 * 1024)) {
			fail('output size limit exceeded');
		}
		this.pending.push(json);
	}

	private *expect(value: string): Grammar {
		const token = yield 'text';
		if (token.text !== value) {
			fail(
				`expected ${JSON.stringify(value)}, received ${JSON.stringify(token.text)}`
			);
		}
	}

	private *archive(): Grammar {
		yield* this.expect('nix-archive-1');
		this.emit('{"version":1,"root":');
		yield* this.node(0);
		this.emit('}');
	}

	private *node(depth: number): Grammar {
		if (depth > (this.options.maxDepth ?? 64)) {
			fail('nesting limit exceeded');
		}
		this.entries += 1;
		if (this.entries > (this.options.maxEntries ?? 1_000_000)) {
			fail('entry limit exceeded');
		}
		yield* this.expect('(');
		yield* this.expect('type');
		const type = (yield 'text').text;
		if (type === 'directory') {
			yield* this.directory(depth);
			return;
		}
		if (type === 'symlink') {
			yield* this.expect('target');
			const target = (yield 'text').text;
			if (target.includes('\0')) {
				fail('symlink target contains NUL');
			}
			this.emit(`{"type":"symlink","target":${JSON.stringify(target)}}`);
			yield* this.expect(')');
			return;
		}
		if (type !== 'regular') {
			fail(`unknown node type ${JSON.stringify(type)}`);
		}
		let field = (yield 'text').text;
		const isExecutable = field === 'executable';
		if (isExecutable) {
			yield* this.expect('');
			field = (yield 'text').text;
		}
		if (field !== 'contents') {
			fail('regular file has no contents');
		}
		const contents = yield 'contents';
		this.emit(
			`{"type":"regular","size":${String(contents.size)}${isExecutable ? ',"executable":true' : ''},"narOffset":${String(contents.offset)}}`
		);
		yield* this.expect(')');
	}

	private *directory(depth: number): Grammar {
		this.emit('{"type":"directory","entries":{');
		let previous: string | undefined;
		for (;;) {
			const field = (yield 'text').text;
			if (field === ')') {
				this.emit('}}');
				return;
			}
			if (field !== 'entry') {
				fail('directory has an unknown field');
			}
			yield* this.expect('(');
			yield* this.expect('name');
			const name = (yield 'text').text;
			if (
				name === '' ||
				name === '.' ||
				name === '..' ||
				name.includes('/') ||
				name.includes('\0')
			) {
				fail('invalid directory entry');
			}
			if (previous !== undefined && !isOrderedBefore(previous, name)) {
				fail('directory entries are duplicated or unordered');
			}
			this.emit(`${previous === undefined ? '' : ','}${JSON.stringify(name)}:`);
			previous = name;
			yield* this.expect('node');
			yield* this.node(depth + 1);
			yield* this.expect(')');
		}
	}

	private startToken(): void {
		const size = new DataView(this.header.buffer).getBigUint64(0, true);
		if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
			fail('token length exceeds the integer limit');
		}
		this.length = Number(size);
		this.remaining = this.length;
		this.padding = (8 - (this.length % 8)) % 8;
		this.payloadOffset = this.offset;
		if (this.request.value !== 'text') {
			return;
		}

		if (this.length > 16 * 1024) {
			fail('metadata length limit exceeded');
		}
		this.tokenBytes = new Uint8Array(this.length);
	}

	private completeToken(): void {
		let text = '';
		if (this.tokenBytes !== undefined) {
			try {
				text = decoder.decode(this.tokenBytes);
			} catch {
				fail('metadata is not valid UTF-8');
			}
		}
		this.request = this.grammar.next({
			text,
			size: this.length ?? 0,
			offset: this.payloadOffset
		});
		this.length = undefined;
		this.tokenBytes = undefined;
		this.headerBytes = 0;
	}

	/**
	Consumes the next archive chunk and applies backpressure to the JSON sink.
	*/
	async write(chunk: Uint8Array): Promise<void> {
		if (this.ended) {
			fail('writer has already ended');
		}
		let position = 0;
		while (position < chunk.length) {
			if (this.request.done) {
				fail('trailing archive bytes');
			}
			if (this.length === undefined) {
				const count = Math.min(8 - this.headerBytes, chunk.length - position);
				this.header.set(
					chunk.subarray(position, position + count),
					this.headerBytes
				);
				this.headerBytes += count;
				position += count;
				this.offset += count;
				if (this.headerBytes !== 8) {
					continue;
				}
				this.startToken();
			}
			const count = Math.min(this.remaining, chunk.length - position);
			this.tokenBytes?.set(
				chunk.subarray(position, position + count),
				(this.length ?? 0) - this.remaining
			);
			this.remaining -= count;
			position += count;
			this.offset += count;
			if (this.remaining > 0) {
				continue;
			}
			while (this.padding > 0 && position < chunk.length) {
				if (chunk[position] !== 0) {
					fail('nonzero archive padding');
				}
				position += 1;
				this.offset += 1;
				this.padding -= 1;
			}
			if (this.padding > 0) {
				continue;
			}
			this.completeToken();
			for (const json of this.pending.splice(0)) {
				await this.options.write(json);
			}
		}
	}

	/**
	Refuses an incomplete archive before the caller publishes the listing.
	*/
	async end(): Promise<void> {
		if (!this.request.done || this.headerBytes !== 0) {
			fail('incomplete archive');
		}
		this.ended = true;
		for (const json of this.pending.splice(0)) {
			await this.options.write(json);
		}
	}
}
