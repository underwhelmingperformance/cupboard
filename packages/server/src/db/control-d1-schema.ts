import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export {
	controlAuthKey,
	controlConsumedSubjectNonce,
	controlRefreshSessionFamily,
	controlRefreshSessionMember,
	controlTrust,
	deploymentTransition,
	globalAdmin,
	tenantMaintenanceFailure
} from './d1-schema.ts';

export const controlDatabaseReady = sqliteTable('control_database_ready', {
	id: text('id').primaryKey(),
	sourceDatabaseId: text('source_database_id').notNull(),
	state: text('state', { enum: ['copying', 'ready'] }).notNull()
});
