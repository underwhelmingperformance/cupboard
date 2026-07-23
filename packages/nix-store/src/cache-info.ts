import { CacheInfoParseError } from './errors.ts';
import { type CachePriority, cachePrioritySchema } from './scalars.ts';

export class CacheInfo {
	static readonly default = new CacheInfo(
		'/nix/store',
		true,
		cachePrioritySchema.parse(40)
	);

	/**
	/**
	 * Parses a `nix-cache-info` document. `StoreDir` and `Priority` are
	 * required and refused with {@link CacheInfoParseError} when absent or
	 * malformed, so a consumer comparing priorities reads the cache's real
	 * value, never a guessed default. An absent `WantMassQuery` reads as
	 * disabled and unknown lines are ignored.
	 */
	static parse(source: string): CacheInfo {
		const fields = new Map<string, string>();

		for (const line of source.split(/\r?\n/u)) {
			const separator = line.indexOf(':');

			if (separator <= 0) {
				continue;
			}

			fields.set(
				line.slice(0, separator).trim(),
				line.slice(separator + 1).trim()
			);
		}

		const storeDirectory = fields.get('StoreDir');

		if (storeDirectory === undefined || storeDirectory === '') {
			throw new CacheInfoParseError('StoreDir');
		}

		const massQuery = fields.get('WantMassQuery') ?? '0';

		if (massQuery !== '0' && massQuery !== '1') {
			throw new CacheInfoParseError('WantMassQuery');
		}

		const priorityText = fields.get('Priority');

		if (priorityText === undefined || !/^\d+$/u.test(priorityText)) {
			throw new CacheInfoParseError('Priority');
		}

		const priority = Number(priorityText);

		if (!Number.isSafeInteger(priority)) {
			throw new CacheInfoParseError('Priority');
		}

		return new CacheInfo(
			storeDirectory,
			massQuery === '1',
			cachePrioritySchema.parse(priority)
		);
	}

	constructor(
		public readonly storeDirectory: string,
		public readonly hasMassQuery: boolean,
		public readonly priority: CachePriority
	) {}

	render(): string {
		return [
			`StoreDir: ${this.storeDirectory}`,
			`WantMassQuery: ${this.hasMassQuery ? '1' : '0'}`,
			`Priority: ${String(this.priority)}`,
			''
		].join('\n');
	}
}
