import {
	cacheDataMigrationsStage,
	cacheMigrationFoundationStage,
	cacheStorageContractStage
} from '@cupboard/protocol/cache-deployment-manifest';
import type { RuntimeStageId } from '@cupboard/protocol/deployment-manifest';
import { z } from 'zod';

const runtimeStageSchema = z.enum([
	cacheMigrationFoundationStage,
	cacheDataMigrationsStage,
	cacheStorageContractStage
]);
const runtimeEnvironmentSchema = z.looseObject({
	CUPBOARD_RUNTIME_STAGE: runtimeStageSchema.optional()
});

export const additiveLocalMigrationCeiling = 49;
export const contractLocalMigrationCeiling = 57;

export function configuredRuntimeStage(env: unknown): RuntimeStageId {
	const { CUPBOARD_RUNTIME_STAGE } = runtimeEnvironmentSchema.parse(env);

	return CUPBOARD_RUNTIME_STAGE ?? cacheStorageContractStage;
}

export function localMigrationCeiling(stage: RuntimeStageId): number {
	return stage === cacheStorageContractStage
		? contractLocalMigrationCeiling
		: additiveLocalMigrationCeiling;
}
