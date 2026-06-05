export class CacheInfo {
	static readonly default = new CacheInfo('/nix/store', true, 40);

	constructor(
		public readonly storeDirectory: string,
		public readonly wantMassQuery: boolean,
		public readonly priority: number
	) {}

	render(): string {
		return [
			`StoreDir: ${this.storeDirectory}`,
			`WantMassQuery: ${this.wantMassQuery ? '1' : '0'}`,
			`Priority: ${String(this.priority)}`,
			''
		].join('\n');
	}
}
