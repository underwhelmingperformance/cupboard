import { type CacheScope, type TenantId } from '@cupboard/nix-store/scalars';

import { AccessKeyReadCache } from '../read/access-key-read-cache.ts';
import { isCacheReadCovered } from '../read/cache-read-grants.ts';

import { tenantServer } from './durable-object.ts';

const accessKeyReads = new AccessKeyReadCache();

/**
Whether an access key authorises a read of `cache`. The tenant object
verifies a key that this isolate has not verified recently.
*/
export async function isAccessKeyReadAuthorised(
	env: Env,
	tenant: TenantId,
	secret: string,
	cache: CacheScope,
	isAbsent: boolean
): Promise<boolean> {
	const grants = await accessKeyReads.grantsFor(tenant, secret, (presented) =>
		tenantServer(env, tenant).verifyAccessKey(presented)
	);

	return grants !== undefined && isCacheReadCovered(grants, cache, isAbsent);
}
