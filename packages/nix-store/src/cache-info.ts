import { CacheInfoParseError } from './errors.ts';

export class CacheInfo {
	static readonly default = new CacheInfo('/nix/store', true, 40);

	/**
	 * Parses a `nix-cache-info` document. Every field the class carries must be
	 * present and well-formed; a missing `Priority` is refused with
	 * {@link CacheInfoParseError} so a consumer comparing priorities reads the
	 * cache's real value, never a guessed default.
	 */
	static parse(source: string): CacheInfo {
		const fields = new Map<string, string>();

		for (const line of source.split(/\r?\n/u)) {
			const separator = line.indexOf(':');

			if (separator === -1) {
				continue;
			}

			fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
		}

		const storeDirectory = fields.get('StoreDir');

		if (storeDirectory === undefined || storeDirectory === '') {
			throw new CacheInfoParseError('StoreDir');
		}

		const massQuery = fields.get('WantMassQuery');

		if (massQuery !== '0' && massQuery !== '1') {
			throw new CacheInfoParseError('WantMassQuery');
		}

		const priority = fields.get('Priority');

		if (priority === undefined || !/^\d+$/u.test(priority)) {
			throw new CacheInfoParseError('Priority');
		}

		return new CacheInfo(storeDirectory, massQuery === '1', Number(priority));
	}

	constructor(
		public readonly storeDirectory: string,
		public readonly hasMassQuery: boolean,
		public readonly priority: number
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

// The gap by which a reuse view's priority is set below its destination cache,
// so Nix prefers the destination while still consulting the view.
export const viewPriorityMargin = 10;

/**
 * Whether a destination cache stays preferred over a reuse view: true when the
 * view's priority is strictly greater, since Nix prefers the lower priority.
 */
export function isDestinationPreferred(
	destinationPriority: number,
	viewPriority: number
): boolean {
	return viewPriority > destinationPriority;
}
