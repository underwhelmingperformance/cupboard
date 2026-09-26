import type { CloudflareApi } from './cloudflare-api.ts';
import type { ScriptName } from './identifiers.ts';

/**
 * The deployment's URL: the custom domain, or the script's workers.dev
 * hostname when the account has a workers.dev subdomain. This function only
 * reads the subdomain. Onboarding enables the workers.dev route.
 */
export async function deploymentUrl(
	api: Pick<CloudflareApi, 'getWorkersDevSubdomain'>,
	controlScriptName: ScriptName,
	domain: string | undefined
): Promise<string | undefined> {
	if (domain !== undefined) {
		return `https://${domain}`;
	}

	const subdomain = await api.getWorkersDevSubdomain();

	return subdomain === undefined
		? undefined
		: `https://${controlScriptName}.${subdomain}.workers.dev`;
}
