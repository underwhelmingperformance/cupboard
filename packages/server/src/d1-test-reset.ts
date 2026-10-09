import { isoTimestamp } from '@cupboard/protocol/scalars';
import { drizzle } from 'drizzle-orm/d1';

import * as controlSchema from './db/control-d1-schema.ts';
import {
	attestationReference,
	blobReference,
	blobState,
	cacheLifecycle,
	casObject,
	controlAuthKey,
	controlConsumedSubjectNonce,
	controlDatabaseSplit,
	controlRefreshSessionFamily,
	controlRefreshSessionMember,
	controlTrust,
	deploymentPhase,
	deploymentTransition,
	globalAdmin,
	localStepWakeCursor,
	manifestState,
	objectDeletion,
	objectIncarnation,
	pathReadRevocation,
	publication,
	tenant,
	tenantBlob,
	tenantCacheReadCredential,
	tenantCasBlob,
	tenantMaintenanceEligibility,
	tenantMaintenanceFailure,
	tenantUsage
} from './db/d1-schema.ts';

export async function resetD1TestState(binding: D1Database): Promise<void> {
	const database = drizzle(binding);
	const now = isoTimestamp(new Date());
	await database.batch([
		database.delete(controlDatabaseSplit),
		database.delete(attestationReference),
		database.delete(blobReference),
		database.delete(pathReadRevocation),
		database.delete(publication),
		database.delete(cacheLifecycle),
		database.delete(tenantCacheReadCredential),
		database.delete(tenantCasBlob),
		database.delete(tenantBlob),
		database.delete(tenantMaintenanceEligibility),
		database.delete(tenantMaintenanceFailure),
		database.delete(tenantUsage),
		database.delete(objectDeletion),
		database.delete(objectIncarnation),
		database.delete(casObject),
		database.delete(blobState),
		database.delete(controlAuthKey),
		database.delete(controlConsumedSubjectNonce),
		database.delete(controlRefreshSessionMember),
		database.delete(controlRefreshSessionFamily),
		database.delete(controlTrust),
		database.delete(deploymentPhase),
		database.delete(deploymentTransition),
		database.insert(deploymentTransition).values({
			id: 'blob-reference-read-authority',
			state: 'complete',
			updatedAt: now
		}),
		database.delete(globalAdmin),
		database.delete(tenant),
		database.delete(manifestState),
		database.delete(localStepWakeCursor)
	]);
}

export async function resetControlD1TestState(
	binding: D1Database
): Promise<void> {
	const database = drizzle(binding);
	await database.batch([
		database.delete(controlSchema.controlAuthKey),
		database.delete(controlSchema.controlConsumedSubjectNonce),
		database.delete(controlSchema.controlRefreshSessionMember),
		database.delete(controlSchema.controlRefreshSessionFamily),
		database.delete(controlSchema.controlTrust),
		database.delete(controlSchema.globalAdmin),
		database.delete(controlSchema.tenantMaintenanceFailure),
		database.delete(controlSchema.deploymentTransition),
		database.delete(controlSchema.controlDatabaseReady)
	]);
}
