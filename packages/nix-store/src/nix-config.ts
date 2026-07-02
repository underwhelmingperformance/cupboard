export class NixConfig {
	constructor(
		public readonly url: string,
		public readonly publicKey: string
	) {}

	render(): string {
		// During a key rotation `/pubkey` returns several keys, newline-separated,
		// but `trusted-public-keys` is a single space-separated line. Collapse any
		// whitespace so every published key lands in the setting.
		const trustedPublicKeys = this.publicKey.split(/\s+/).filter(Boolean);

		return [
			`extra-substituters = ${this.url}`,
			`extra-trusted-public-keys = ${trustedPublicKeys.join(' ')}`,
			''
		].join('\n');
	}
}

/**
 * The netrc line Nix needs to read a private cache. netrc keys on the host
 * alone, so the caller passes the substituter host with any path stripped.
 */
export function renderNetrc(
	host: string,
	user: string,
	password: string
): string {
	return `machine ${host} login ${user} password ${password}\n`;
}
