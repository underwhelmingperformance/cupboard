export class CacheInfo {
	static readonly default = new CacheInfo('/nix/store', true, 40);

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
