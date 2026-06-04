import { buildVersion } from './build-info.generated.ts';
import { TextBody, textResponse } from './http.ts';

const healthBody = new TextBody('ok\n');
const versionBody = new TextBody(`${buildVersion}\n`);

// Deployment-level endpoints served at the bare host regardless of tenancy: a
// liveness probe and the build version. They carry no tenant or cache prefix.
export async function handleDeployment(
	request: Request
): Promise<Response | undefined> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return undefined;
	}

	const { pathname } = new URL(request.url);

	if (pathname === '/_health') {
		return textResponse(request, healthBody, {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store'
		});
	}

	if (pathname === '/_version') {
		return textResponse(request, versionBody, {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store'
		});
	}

	return undefined;
}
