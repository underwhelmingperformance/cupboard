import type { NarSource } from '../../packages/cli/src/nix/nar-source.ts';

export interface MemoryNarSourceOptions {
	/**
	 * Returns the NAR contents for the open at index `open`, counting from 0. A
	 * test returns different bytes to simulate a NAR that changes between
	 * reads.
	 */
	readonly contents: (open: number) => Uint8Array;
	/**
	 * Returns the length of the pieces that the open at index `open` yields.
	 */
	readonly pieceSize?: (open: number) => number;
	/**
	 * Runs before the open at index `open` yields the piece that starts at
	 * `offset`. The piece waits for a returned promise.
	 */
	readonly beforePiece?: (open: number, offset: number) => Promise<void> | void;
	/**
	 * Refuses to start reading an open while an earlier open is still being
	 * read, as a store with one connection would.
	 */
	readonly isExclusive?: boolean;
}

/**
 * Fails an open of an exclusive `MemoryNarSource` that starts while another
 * open is still being read.
 */
export class ConcurrentNarOpenError extends Error {
	constructor(public readonly offset: number) {
		super(`The NAR was opened at ${String(offset)} while it was still open`);
		this.name = 'ConcurrentNarOpenError';
	}
}

/**
 * A NAR held in memory that can be opened at any offset. It records the
 * offset of every open, the number of bytes that each open yields, and how
 * many opens have finished.
 */
export class MemoryNarSource implements NarSource {
	static of(contents: Uint8Array): MemoryNarSource {
		return new MemoryNarSource({ contents: () => contents });
	}

	private active = 0;

	private closedOpens = 0;

	readonly opens: number[] = [];

	readonly bytesRead: number[] = [];

	constructor(private readonly options: MemoryNarSourceOptions) {}

	/**
	 * The number of opens whose reading has finished or been stopped.
	 */
	get closed(): number {
		return this.closedOpens;
	}

	async *open(offset: number): AsyncIterable<Uint8Array> {
		if (this.options.isExclusive === true && this.active > 0) {
			throw new ConcurrentNarOpenError(offset);
		}

		const open = this.opens.length;
		this.opens.push(offset);
		this.bytesRead.push(0);
		this.active += 1;

		try {
			const contents = this.options.contents(open);
			const pieceSize = this.options.pieceSize?.(open) ?? 1024 * 1024;

			for (let at = offset; at < contents.byteLength; at += pieceSize) {
				await this.options.beforePiece?.(open, at);

				const piece = contents.subarray(at, at + pieceSize);
				this.bytesRead[open] = (this.bytesRead[open] ?? 0) + piece.byteLength;

				yield piece;
			}
		} finally {
			this.active -= 1;
			this.closedOpens += 1;
		}
	}
}
