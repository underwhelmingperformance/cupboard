export class NixConfig {
	constructor(
		public readonly url: string,
		public readonly publicKey: string
	) {}

	render(): string {
		return [
			`substituters = ${this.url}`,
			`trusted-public-keys = ${this.publicKey}`,
			''
		].join('\n');
	}
}
