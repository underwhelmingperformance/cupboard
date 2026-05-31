import type { CupboardClient, TokenProvider } from './client.ts';

/**
 * Exchanges the deployment bootstrap secret for a short-lived admin access JWT
 * and returns a provider that caches it and re-exchanges on demand. A long
 * push can outlive a single token, so the client refreshes through this
 * provider and retries once on a 401. The CLI stays stateless: nothing is
 * persisted between invocations.
 *
 * The first exchange happens eagerly so an invalid bootstrap secret fails the
 * command up front.
 */
export async function authenticate(
	client: CupboardClient,
	bootstrapSecret: string
): Promise<TokenProvider> {
	const provider = new BootstrapTokenProvider(client, bootstrapSecret);
	await provider.get();

	return provider;
}

class BootstrapTokenProvider implements TokenProvider {
	#token: string | undefined;

	constructor(
		private readonly client: CupboardClient,
		private readonly bootstrapSecret: string
	) {}

	async get(): Promise<string> {
		return (this.#token ??= await this.exchange());
	}

	async refresh(): Promise<string> {
		this.#token = await this.exchange();

		return this.#token;
	}

	private async exchange(): Promise<string> {
		const { token } = await this.client.bootstrap(this.bootstrapSecret);

		return token;
	}
}
