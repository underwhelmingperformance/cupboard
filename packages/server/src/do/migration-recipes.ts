import {
	type LocalMigrationRecipe,
	type LocalMigrationStage
} from './bounded-migration.ts';

const rowsPerPage = 1000;
const sourceRowsPerInvocation = 1000;
const structuralOperationsPerInvocation = 256;

interface RebuildTable {
	readonly table: string;
	readonly create: number;
	readonly copy: number;
	readonly indexes: readonly number[];
}

const reuseSelectorNativeColumns = [
	'id',
	'view',
	'kind',
	'cache_name',
	'prefix'
] as const;

function reuseSelectorNativeTable(table: string): string {
	return `CREATE TABLE \`${table}\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`view\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`cache_name\` text,
	\`prefix\` text,
	CONSTRAINT "reuse_view_selector_native_shape_check" CHECK(("${table}"."kind" IN ('default', 'all-named', 'all') AND "${table}"."cache_name" IS NULL AND "${table}"."prefix" IS NULL) OR ("${table}"."kind" = 'named' AND "${table}"."cache_name" IS NOT NULL AND "${table}"."prefix" IS NULL) OR ("${table}"."kind" = 'prefix' AND "${table}"."cache_name" IS NULL AND "${table}"."prefix" IS NOT NULL AND length("${table}"."prefix") > 0))
);`;
}

function copyReuseSelectorNativeStage(
	target: string,
	name: string
): LocalMigrationStage {
	return {
		kind: 'page',
		name,
		source: 'reuse_view_selector_native',
		writesPerSourceRow: 1,
		statements: (cursor, last) => [
			`INSERT OR REPLACE INTO \`${target}\` (${reuseSelectorNativeColumns.map((column) => `\`${column}\``).join(', ')})
SELECT ${reuseSelectorNativeColumns.map((column) => `\`${column}\``).join(', ')} FROM \`reuse_view_selector_native\`
WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)};`
		]
	};
}

interface LegacyCacheSource {
	readonly table: string;
	readonly column: string;
	readonly predicate?: string;
	readonly newPredicate?: string;
}

const legacyCacheSources: readonly LegacyCacheSource[] = [
	{ table: 'narinfo', column: 'cache' },
	{ table: 'narinfo_deletion', column: 'cache' },
	{ table: 'pending_upload', column: 'cache' },
	{ table: 'pending_attestation', column: 'cache' },
	{ table: 'retention_root', column: 'cache' },
	{ table: 'retention_root_target', column: 'cache' },
	{ table: 'retention_grace', column: 'cache' },
	{ table: 'garbage_collection_revision', column: 'cache' },
	{ table: 'garbage_collection_scan', column: 'cache' },
	{ table: 'garbage_collection_frontier', column: 'cache' },
	{ table: 'garbage_collection_mark', column: 'cache' },
	{ table: 'garbage_collection_tenant_run', column: 'cache' },
	{ table: 'verification_cursor', column: 'cache' },
	{
		table: 'retention_policy',
		column: 'pattern',
		predicate: "scope = 'cache'",
		newPredicate: "NEW.`scope` = 'cache'"
	}
];

const legacyCatalogueTable = '__bounded_legacy_cache_catalogue';

const catalogueSourceTriggerNames = legacyCacheSources.flatMap((source) => [
	`__bounded_catalogue_${source.table}_insert`,
	`__bounded_catalogue_${source.table}_update`
]);
const cacheCatalogueTriggerNames = [
	'__bounded_catalogue_cache_insert',
	'__bounded_catalogue_cache_update',
	'__bounded_catalogue_cache_delete'
] as const;
const catalogueIdentityTriggerNames = [
	'__bounded_catalogue_identity_insert',
	'__bounded_catalogue_identity_update'
] as const;
const reuseSelectorCompatibilityTriggerNames = [
	'__bounded_reuse_selector_insert',
	'__bounded_reuse_selector_update',
	'__bounded_reuse_selector_delete'
] as const;

function dropTriggers(names: readonly string[]): readonly string[] {
	return names.map((name) => `DROP TRIGGER \`${name}\`;`);
}

function legacyCacheValues(reference: string): string {
	return `CASE WHEN ${reference} = '' THEN 'default' ELSE 'named' END,
	CASE WHEN ${reference} = '' THEN '' WHEN ${reference} LIKE 'private/%' THEN substr(${reference}, 9) ELSE ${reference} END,
	CASE WHEN ${reference} LIKE 'private/%' THEN 'private' ELSE 'public' END,
	CASE WHEN ${reference} LIKE 'private/%' THEN 'private' ELSE NULL END`;
}

function deletedCatalogueInsert(
	source: LegacyCacheSource,
	reference: string,
	where: string
): string {
	return `INSERT INTO \`${legacyCatalogueTable}\` (
	\`kind\`, \`name\`, \`namespace\`, \`access\`, \`priority\`, \`grace_managed\`, \`created_at\`, \`deleted_at\`
)
SELECT ${legacyCacheValues(reference)}, 40, 0,
	'1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'
${where}
ON CONFLICT (\`kind\`, \`name\`) DO UPDATE SET
	\`namespace\` = CASE
		WHEN \`namespace\` = excluded.\`namespace\` THEN \`namespace\`
		ELSE 'conflict'
	END;`;
}

function catalogueSourceStage(source: LegacyCacheSource): LocalMigrationStage {
	const predicate =
		source.predicate === undefined ? '' : ` AND (${source.predicate})`;

	return {
		kind: 'page',
		name: `catalogue-${source.table}`,
		source: source.table,
		writesPerSourceRow: 1,
		statements: (cursor, last) => [
			deletedCatalogueInsert(
				source,
				`\`${source.column}\``,
				`FROM \`${source.table}\` WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)}${predicate}`
			)
		]
	};
}

function catalogueCompatibilityTriggers(
	source: LegacyCacheSource
): readonly string[] {
	const predicate =
		source.newPredicate === undefined ? '' : ` WHEN ${source.newPredicate}`;
	const insert = `INSERT INTO \`${legacyCatalogueTable}\` (
	\`kind\`, \`name\`, \`namespace\`, \`access\`, \`priority\`, \`grace_managed\`, \`created_at\`, \`deleted_at\`
)
VALUES (${legacyCacheValues(`NEW.\`${source.column}\``)}, 40, 0,
	'1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
ON CONFLICT (\`kind\`, \`name\`) DO UPDATE SET
	\`namespace\` = CASE
		WHEN \`namespace\` = excluded.\`namespace\` THEN \`namespace\`
		ELSE 'conflict'
	END;`;

	return [
		`CREATE TRIGGER \`__bounded_catalogue_${source.table}_insert\`
AFTER INSERT ON \`${source.table}\`${predicate}
BEGIN ${insert} END;`,
		`CREATE TRIGGER \`__bounded_catalogue_${source.table}_update\`
AFTER UPDATE OF \`${source.column}\` ON \`${source.table}\`${predicate}
BEGIN ${insert} END;`
	];
}

function liveCatalogueConflict(): string {
	return `ON CONFLICT (\`kind\`, \`name\`) DO UPDATE SET
	\`namespace\` = CASE
		WHEN \`namespace\` = excluded.\`namespace\` THEN \`namespace\`
		ELSE 'conflict'
	END,
	\`access\` = excluded.\`access\`,
	\`priority\` = excluded.\`priority\`,
	\`grace_managed\` = excluded.\`grace_managed\`,
	\`created_at\` = excluded.\`created_at\`,
	\`deleted_at\` = NULL;`;
}

function liveCatalogueSelect(reference: string, from: string): string {
	return `INSERT INTO \`${legacyCatalogueTable}\` (
	\`kind\`, \`name\`, \`namespace\`, \`access\`, \`priority\`, \`grace_managed\`, \`created_at\`, \`deleted_at\`
)
SELECT ${legacyCacheValues(reference)}, \`priority\`, \`grace_managed\`, \`created_at\`, NULL
${from}
${liveCatalogueConflict()}`;
}

function liveCatalogueValues(reference: string): string {
	return `INSERT INTO \`${legacyCatalogueTable}\` (
	\`kind\`, \`name\`, \`namespace\`, \`access\`, \`priority\`, \`grace_managed\`, \`created_at\`, \`deleted_at\`
)
VALUES (${legacyCacheValues(reference)}, NEW.\`priority\`, NEW.\`grace_managed\`, NEW.\`created_at\`, NULL)
${liveCatalogueConflict()}`;
}

function cacheCatalogueStage(): LocalMigrationStage {
	return {
		kind: 'page',
		name: 'catalogue-cache',
		source: 'cache',
		writesPerSourceRow: 1,
		statements: (cursor, last) => [
			liveCatalogueSelect(
				'`name`',
				`FROM \`cache\` WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)}`
			)
		]
	};
}

function cacheCatalogueTriggers(): readonly string[] {
	const upsert = liveCatalogueValues('NEW.`name`');

	return [
		`CREATE TRIGGER \`__bounded_catalogue_cache_insert\`
AFTER INSERT ON \`cache\`
BEGIN ${upsert} END;`,
		`CREATE TRIGGER \`__bounded_catalogue_cache_update\`
AFTER UPDATE OF \`name\`, \`priority\`, \`grace_managed\`, \`created_at\` ON \`cache\`
BEGIN ${upsert} END;`,
		`CREATE TRIGGER \`__bounded_catalogue_cache_delete\`
AFTER DELETE ON \`cache\`
BEGIN
	UPDATE \`${legacyCatalogueTable}\`
	SET \`deleted_at\` = CURRENT_TIMESTAMP
	WHERE \`kind\` = CASE WHEN OLD.\`name\` = '' THEN 'default' ELSE 'named' END
		AND \`name\` IS CASE WHEN OLD.\`name\` = '' THEN NULL WHEN OLD.\`name\` LIKE 'private/%' THEN substr(OLD.\`name\`, 9) ELSE OLD.\`name\` END;
END;`
	];
}

const narinfoColumns = [
	'cache',
	'store_path_hash',
	'store_path',
	'nar_hash',
	'nar_size',
	'references_json',
	'deriver',
	'ca',
	'sigs_json',
	'created_at',
	'generation',
	'signature_generation',
	'pending_signature_generation',
	'cache_id'
] as const;

function narinfoValues(prefix: 'NEW' | ''): string {
	return narinfoColumns
		.map((column) => `${prefix === '' ? '' : `${prefix}.`}\`${column}\``)
		.join(', ');
}

const compatibleNarinfoTable = `CREATE TABLE \`__bounded_0043_narinfo\` (
	\`cache\` text DEFAULT '' NOT NULL,
	\`store_path_hash\` text NOT NULL,
	\`store_path\` text NOT NULL,
	\`nar_hash\` text NOT NULL,
	\`nar_size\` integer NOT NULL,
	\`references_json\` text NOT NULL,
	\`deriver\` text,
	\`ca\` text,
	\`sigs_json\` text DEFAULT '[]' NOT NULL,
	\`created_at\` text NOT NULL,
	\`generation\` integer DEFAULT 0 NOT NULL,
	\`signature_generation\` integer DEFAULT 0 NOT NULL,
	\`pending_signature_generation\` integer,
	\`cache_id\` integer,
	PRIMARY KEY (\`cache\`, \`store_path_hash\`)
);`;

const canonicalNarinfoTable = compatibleNarinfoTable.replaceAll(
	'__bounded_0043_narinfo',
	'__bounded_canonical_0043_narinfo'
);

const canonicalNarinfoIndexes = [
	'CREATE INDEX `narinfo_store_path_hash_cache_idx` ON `__bounded_canonical_0043_narinfo` (`store_path_hash`, `cache`);',
	'CREATE INDEX `narinfo_pending_signature_generation_idx` ON `__bounded_canonical_0043_narinfo` (`pending_signature_generation`, `signature_generation`, `cache`, `store_path_hash`);',
	'CREATE INDEX `narinfo_signature_generation_idx` ON `__bounded_canonical_0043_narinfo` (`signature_generation`);',
	'CREATE INDEX `narinfo_missing_cache_identity_idx` ON `__bounded_canonical_0043_narinfo` (`cache_id`) WHERE `cache_id` IS NULL;',
	'CREATE INDEX `narinfo_cache_id_store_path_hash_idx` ON `__bounded_canonical_0043_narinfo` (`cache_id`, `store_path_hash`);'
] as const;

const narinfoMirrorTriggers = [
	`CREATE TRIGGER \`__bounded_0043_narinfo_insert\` AFTER INSERT ON \`narinfo\`
BEGIN
	INSERT OR REPLACE INTO \`__bounded_0043_narinfo\` (${narinfoColumns.map((column) => `\`${column}\``).join(', ')})
	VALUES (${narinfoValues('NEW')});
END;`,
	`CREATE TRIGGER \`__bounded_0043_narinfo_update\` AFTER UPDATE ON \`narinfo\`
BEGIN
	DELETE FROM \`__bounded_0043_narinfo\`
	WHERE \`cache\` = OLD.\`cache\` AND \`store_path_hash\` = OLD.\`store_path_hash\`;
	INSERT OR REPLACE INTO \`__bounded_0043_narinfo\` (${narinfoColumns.map((column) => `\`${column}\``).join(', ')})
	VALUES (${narinfoValues('NEW')});
END;`,
	`CREATE TRIGGER \`__bounded_0043_narinfo_delete\` AFTER DELETE ON \`narinfo\`
BEGIN
	DELETE FROM \`__bounded_0043_narinfo\`
	WHERE \`cache\` = OLD.\`cache\` AND \`store_path_hash\` = OLD.\`store_path_hash\`;
END;`
];

const narinfoOperationalTriggers = [
	`CREATE TRIGGER \`garbage_collection_revision_narinfo_insert\`
AFTER INSERT ON \`narinfo\`
BEGIN
	INSERT INTO \`garbage_collection_revision\` (\`cache\`, \`revision\`)
	VALUES (NEW.\`cache\`, 1)
	ON CONFLICT (\`cache\`) DO UPDATE SET \`revision\` = \`revision\` + 1;
END;`,
	`CREATE TRIGGER \`garbage_collection_revision_narinfo_update\`
AFTER UPDATE ON \`narinfo\`
BEGIN
	INSERT INTO \`garbage_collection_revision\` (\`cache\`, \`revision\`)
	VALUES (OLD.\`cache\`, 1)
	ON CONFLICT (\`cache\`) DO UPDATE SET \`revision\` = \`revision\` + 1;
	INSERT INTO \`garbage_collection_revision\` (\`cache\`, \`revision\`)
	SELECT NEW.\`cache\`, 1 WHERE NEW.\`cache\` <> OLD.\`cache\`
	ON CONFLICT (\`cache\`) DO UPDATE SET \`revision\` = \`revision\` + 1;
END;`,
	`CREATE TRIGGER \`garbage_collection_revision_narinfo_delete\`
AFTER DELETE ON \`narinfo\`
BEGIN
	INSERT INTO \`garbage_collection_revision\` (\`cache\`, \`revision\`)
	VALUES (OLD.\`cache\`, 1)
	ON CONFLICT (\`cache\`) DO UPDATE SET \`revision\` = \`revision\` + 1;
END;`,
	`CREATE TRIGGER \`narinfo_backfill_insert\`
AFTER INSERT ON \`narinfo\`
WHEN NEW.\`cache_id\` IS NULL
	AND (
		(NEW.\`cache\` = '' AND EXISTS (SELECT 1 FROM \`cache_identity\` WHERE \`kind\` = 'default' AND \`deleted_at\` IS NULL))
		OR (NEW.\`cache\` <> '' AND EXISTS (
			SELECT 1 FROM \`cache_identity\`
			WHERE \`kind\` = 'named' AND \`deleted_at\` IS NULL
				AND \`name\` = CASE WHEN NEW.\`cache\` LIKE 'private/%' THEN substr(NEW.\`cache\`, 9) ELSE NEW.\`cache\` END
		))
	)
BEGIN
	UPDATE \`cache_identity_backfill_revision\` SET \`revision\` = \`revision\` + 1 WHERE \`table_name\` = 'narinfo';
END;`,
	`CREATE TRIGGER \`narinfo_backfill_update\`
AFTER UPDATE OF \`cache_id\`, \`cache\` ON \`narinfo\`
WHEN NEW.\`cache_id\` IS NULL
	AND (
		(NEW.\`cache\` = '' AND EXISTS (SELECT 1 FROM \`cache_identity\` WHERE \`kind\` = 'default' AND \`deleted_at\` IS NULL))
		OR (NEW.\`cache\` <> '' AND EXISTS (
			SELECT 1 FROM \`cache_identity\`
			WHERE \`kind\` = 'named' AND \`deleted_at\` IS NULL
				AND \`name\` = CASE WHEN NEW.\`cache\` LIKE 'private/%' THEN substr(NEW.\`cache\`, 9) ELSE NEW.\`cache\` END
		))
	)
	AND (OLD.\`cache_id\` IS NOT NULL OR OLD.\`cache\` IS NOT NEW.\`cache\`)
BEGIN
	UPDATE \`cache_identity_backfill_revision\` SET \`revision\` = \`revision\` + 1 WHERE \`table_name\` = 'narinfo';
END;`
];
function selectorProjection(prefix: '' | 'NEW' | 'OLD'): string {
	const column = (name: string) =>
		`${prefix === '' ? '' : `${prefix}.`}\`${name}\``;

	return `${column('view')},
	CASE
		WHEN ${column('kind')} = 'exact' AND ${column('pattern')} = '_default' THEN 'default'
		WHEN ${column('kind')} = 'exact' THEN 'named'
		WHEN ${column('pattern')} = '' AND ${column('view')} LIKE 'private/%' THEN 'all-named'
		WHEN ${column('pattern')} = '' THEN 'all'
		ELSE 'prefix'
	END,
	CASE WHEN ${column('kind')} = 'exact' AND ${column('pattern')} <> '_default' THEN ${column('pattern')} ELSE NULL END,
	CASE WHEN ${column('kind')} = 'prefix' AND ${column('pattern')} <> '' THEN ${column('pattern')} ELSE NULL END`;
}

const reuseSelectorCompatibilityTriggers = [
	`CREATE TRIGGER \`__bounded_reuse_selector_insert\`
AFTER INSERT ON \`reuse_view_selector\`
BEGIN
	INSERT OR IGNORE INTO \`reuse_view_selector_native\` (\`view\`, \`kind\`, \`cache_name\`, \`prefix\`)
	VALUES (${selectorProjection('NEW')});
END;`,
	`CREATE TRIGGER \`__bounded_reuse_selector_update\`
AFTER UPDATE ON \`reuse_view_selector\`
BEGIN
	DELETE FROM \`reuse_view_selector_native\`
	WHERE (\`view\`, \`kind\`, \`cache_name\`, \`prefix\`) IS (${selectorProjection('OLD')});
	INSERT OR IGNORE INTO \`reuse_view_selector_native\` (\`view\`, \`kind\`, \`cache_name\`, \`prefix\`)
	VALUES (${selectorProjection('NEW')});
END;`,
	`CREATE TRIGGER \`__bounded_reuse_selector_delete\`
AFTER DELETE ON \`reuse_view_selector\`
BEGIN
	DELETE FROM \`reuse_view_selector_native\`
	WHERE (\`view\`, \`kind\`, \`cache_name\`, \`prefix\`) IS (${selectorProjection('OLD')});
END;`
];

function catalogueSchema(shouldUseIfNotExists = false): readonly string[] {
	return [
		`CREATE TABLE${shouldUseIfNotExists ? ' IF NOT EXISTS' : ''} \`${legacyCatalogueTable}\` (
	\`kind\` text NOT NULL,
	\`name\` text NOT NULL,
	\`namespace\` text NOT NULL CHECK (\`namespace\` IN ('public', 'private')),
	\`access\` text,
	\`priority\` integer NOT NULL,
	\`grace_managed\` integer NOT NULL,
	\`created_at\` text NOT NULL,
	\`deleted_at\` text,
	\`identity_id\` integer,
	PRIMARY KEY (\`kind\`, \`name\`)
	);`
	];
}

function catalogueIdentityTriggers(): readonly string[] {
	return [
		`CREATE TRIGGER \`__bounded_catalogue_identity_insert\`
AFTER INSERT ON \`${legacyCatalogueTable}\`
BEGIN
	INSERT INTO \`cache_identity\` (\`kind\`, \`name\`, \`access\`, \`priority\`, \`grace_managed\`, \`created_at\`, \`deleted_at\`)
	VALUES (NEW.\`kind\`, CASE WHEN NEW.\`kind\` = 'default' THEN NULL ELSE NEW.\`name\` END, NEW.\`access\`, NEW.\`priority\`, NEW.\`grace_managed\`, NEW.\`created_at\`, NEW.\`deleted_at\`);
	UPDATE \`${legacyCatalogueTable}\` SET \`identity_id\` = last_insert_rowid() WHERE rowid = NEW.rowid;
END;`,
		`CREATE TRIGGER \`__bounded_catalogue_identity_update\`
AFTER UPDATE OF \`access\`, \`priority\`, \`grace_managed\`, \`created_at\`, \`deleted_at\` ON \`${legacyCatalogueTable}\`
BEGIN
	UPDATE \`cache_identity\` SET
		\`access\` = NEW.\`access\`,
		\`priority\` = NEW.\`priority\`,
		\`grace_managed\` = NEW.\`grace_managed\`,
		\`created_at\` = NEW.\`created_at\`,
		\`deleted_at\` = NEW.\`deleted_at\`
	WHERE \`id\` = NEW.\`identity_id\`;
END;`
	];
}

function statementAt(statements: readonly string[], index: number): string {
	const statement = statements[index];

	if (statement === undefined) {
		throw new Error(
			`Bounded migration recipe has no statement ${String(index)}`
		);
	}

	return statement;
}

function shadowIndex(statement: string, table: string): string {
	const named = statement
		.replace('CREATE UNIQUE INDEX `', 'CREATE UNIQUE INDEX `__bounded_')
		.replace('CREATE INDEX `', 'CREATE INDEX `__bounded_');

	return named
		.replace(` ON \`${table}\``, () => ` ON \`__new_${table}\``)
		.replaceAll(`"${table}".`, () => `"__new_${table}".`);
}

function canonicalTableName(table: string): string {
	return `__bounded_canonical_${table}`;
}

function canonicalTable(statement: string, table: string): string {
	return statement.replaceAll(`__new_${table}`, () =>
		canonicalTableName(table)
	);
}

function canonicalIndex(statement: string, table: string): string {
	const canonical = canonicalTableName(table);

	return statement
		.replace(` ON \`${table}\``, () => ` ON \`${canonical}\``)
		.replaceAll(`"${table}".`, () => `"${canonical}".`);
}

function boundedCopy(
	statement: string,
	table: string,
	cursor: number,
	last: number
): string {
	if (!statement.endsWith(';')) {
		throw new Error(`Bounded copy for ${table} is not terminated`);
	}

	return `${statement.slice(0, -1)} WHERE \`${table}\`.rowid > ${String(cursor)} AND \`${table}\`.rowid <= ${String(last)};`;
}

function assertionStage(table: string, predicate: string): LocalMigrationStage {
	return {
		kind: 'page',
		name: `assert-${table}`,
		source: table,
		writesPerSourceRow: 0,
		statements: (cursor, last) => [
			`INSERT INTO \`_cache_identity_contract_assertion\` (\`valid\`)
SELECT 0 WHERE EXISTS (
	SELECT 1 FROM \`${table}\`
	WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)} AND (${predicate})
);`
		]
	};
}

function uniquenessStage(
	table: string,
	family: string,
	key: string,
	predicate?: string
): LocalMigrationStage {
	return {
		kind: 'page',
		name: `assert-unique-${family}`,
		source: table,
		writesPerSourceRow: 1,
		statements: (cursor, last) => [
			`INSERT INTO \`__bounded_cache_identity_keys\` (\`family\`, \`key\`)
SELECT '${family}', json_array(${key}) FROM \`${table}\`
WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)}${predicate === undefined ? '' : ` AND (${predicate})`};`
		]
	};
}

function boundedMutation(
	statement: string,
	table: string,
	hasWhere: boolean,
	cursor: number,
	last: number
): string {
	if (!statement.endsWith(';')) {
		throw new Error(`Bounded mutation for ${table} is not terminated`);
	}

	const connector = hasWhere ? ' AND' : ' WHERE';

	return `${statement.slice(0, -1)}${connector} \`${table}\`.rowid > ${String(cursor)} AND \`${table}\`.rowid <= ${String(last)};`;
}

function mutationStage(
	statements: readonly string[],
	index: number,
	table: string,
	hasWhere: boolean
): LocalMigrationStage {
	return {
		kind: 'page',
		name: `mutate-${table}-${String(index)}`,
		source: table,
		writesPerSourceRow: 1,
		statements: (cursor, last) => [
			boundedMutation(
				statementAt(statements, index),
				table,
				hasWhere,
				cursor,
				last
			)
		]
	};
}

function cacheAccessBackfillRecipe(
	tag: string,
	statements: readonly string[]
): LocalMigrationRecipe {
	const updates: readonly [number, string, boolean][] = [
		[27, 'narinfo', false],
		[28, 'generation_seq', false],
		[29, 'pending_upload', false],
		[30, 'pending_attestation', false],
		[31, 'narinfo_deletion', false],
		[32, 'retention_root', false],
		[33, 'retention_root_target', false],
		[34, 'retention_grace', false],
		[35, 'garbage_collection_revision', false],
		[36, 'garbage_collection_scan', false],
		[37, 'garbage_collection_frontier', false],
		[38, 'garbage_collection_mark', false],
		[39, 'garbage_collection_tenant_run', false],
		[40, 'verification_cursor', false],
		[41, 'retention_policy', false],
		[42, 'reuse_view', false]
	];
	const narinfoCatalogueTriggers = catalogueCompatibilityTriggers(
		legacyCacheSources[0] ?? { table: 'narinfo', column: 'cache' }
	);

	return {
		tag,
		rowsPerPage,
		sourceRowsPerInvocation,
		structuralOperationsPerInvocation,
		stages: [
			{
				kind: 'batch',
				name: 'prepare-compatible-catalogue-and-indexed-shadows',
				statements: [
					...catalogueSchema(),
					...legacyCacheSources.flatMap((source) =>
						catalogueCompatibilityTriggers(source)
					),
					...cacheCatalogueTriggers(),
					'CREATE TABLE `__bounded_reuse_names` (`name` text PRIMARY KEY NOT NULL);',
					statementAt(statements, 45),
					"CREATE UNIQUE INDEX `__bounded_reuse_selector_identity_idx` ON `reuse_view_selector_native` (`view`, `kind`, coalesce(`cache_name`, ''), coalesce(`prefix`, ''));",
					...reuseSelectorCompatibilityTriggers,
					compatibleNarinfoTable,
					'CREATE INDEX `__bounded_0043_narinfo_store_path_hash_cache_idx` ON `__bounded_0043_narinfo` (`store_path_hash`, `cache`);',
					'CREATE INDEX `__bounded_0043_narinfo_pending_signature_generation_idx` ON `__bounded_0043_narinfo` (`pending_signature_generation`, `signature_generation`, `cache`, `store_path_hash`);',
					'CREATE INDEX `__bounded_0043_narinfo_signature_generation_idx` ON `__bounded_0043_narinfo` (`signature_generation`);',
					'CREATE INDEX `__bounded_0043_narinfo_missing_cache_identity_idx` ON `__bounded_0043_narinfo` (`cache_id`) WHERE `cache_id` IS NULL;',
					'CREATE INDEX `__bounded_0043_narinfo_cache_id_store_path_hash_idx` ON `__bounded_0043_narinfo` (`cache_id`, `store_path_hash`);',
					...narinfoMirrorTriggers
				]
			},
			cacheCatalogueStage(),
			...legacyCacheSources.map((source) => catalogueSourceStage(source)),
			{
				kind: 'page',
				name: 'assert-reuse-view-namespace',
				source: 'reuse_view',
				writesPerSourceRow: 1,
				statements: (cursor, last) => [
					`INSERT INTO \`__bounded_reuse_names\` (\`name\`)
SELECT CASE WHEN \`name\` LIKE 'private/%' THEN substr(\`name\`, 9) ELSE \`name\` END
FROM \`reuse_view\` WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)};`
				]
			},
			{
				kind: 'batch',
				name: 'finish-reuse-view-assertion',
				statements: [
					'DROP TABLE `__bounded_reuse_names`;',
					...catalogueIdentityTriggers()
				]
			},
			{
				kind: 'page',
				name: 'materialise-cache-identities',
				source: legacyCatalogueTable,
				writesPerSourceRow: 2,
				statements: (cursor, last) => [
					`INSERT INTO \`cache_identity\` (\`kind\`, \`name\`, \`access\`, \`priority\`, \`grace_managed\`, \`created_at\`, \`deleted_at\`)
SELECT \`kind\`, CASE WHEN \`kind\` = 'default' THEN NULL ELSE \`name\` END,
	\`access\`, \`priority\`, \`grace_managed\`, \`created_at\`, \`deleted_at\`
FROM \`${legacyCatalogueTable}\`
WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)} AND \`identity_id\` IS NULL;`,
					`UPDATE \`${legacyCatalogueTable}\` SET \`identity_id\` = (
	SELECT \`id\` FROM \`cache_identity\`
	WHERE \`kind\` = \`${legacyCatalogueTable}\`.\`kind\`
		AND \`name\` IS CASE WHEN \`${legacyCatalogueTable}\`.\`kind\` = 'default' THEN NULL ELSE \`${legacyCatalogueTable}\`.\`name\` END
		AND \`created_at\` = \`${legacyCatalogueTable}\`.\`created_at\`
		AND \`deleted_at\` IS \`${legacyCatalogueTable}\`.\`deleted_at\`
	ORDER BY \`id\` DESC LIMIT 1
)
WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)} AND \`identity_id\` IS NULL;`
				]
			},
			...updates.map(([index, table, hasWhere]) =>
				mutationStage(statements, index, table, hasWhere)
			),
			{
				kind: 'page',
				name: 'copy-reuse-view-selectors',
				source: 'reuse_view_selector',
				writesPerSourceRow: 1,
				statements: (cursor, last) => [
					`INSERT OR IGNORE INTO \`reuse_view_selector_native\` (\`view\`, \`kind\`, \`cache_name\`, \`prefix\`)
SELECT ${selectorProjection('')} FROM \`reuse_view_selector\`
WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)};`
				]
			},
			{
				kind: 'page',
				name: 'copy-indexed-narinfos',
				source: 'narinfo',
				writesPerSourceRow: 1,
				statements: (cursor, last) => [
					`INSERT OR REPLACE INTO \`__bounded_0043_narinfo\` (${narinfoColumns.map((column) => `\`${column}\``).join(', ')})
SELECT ${narinfoValues('')} FROM \`narinfo\`
WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)};`
				]
			},
			{
				kind: 'batch',
				name: 'switch-indexed-narinfos',
				statements: [
					...['insert', 'update', 'delete'].map(
						(event) => `DROP TRIGGER \`__bounded_0043_narinfo_${event}\`;`
					),
					...['insert', 'update'].map(
						(event) => `DROP TRIGGER \`__bounded_catalogue_narinfo_${event}\`;`
					),
					...[
						'garbage_collection_revision_narinfo_insert',
						'garbage_collection_revision_narinfo_update',
						'garbage_collection_revision_narinfo_delete',
						'narinfo_backfill_insert',
						'narinfo_backfill_update'
					].map((trigger) => `DROP TRIGGER \`${trigger}\`;`),
					'ALTER TABLE `narinfo` RENAME TO `__bounded_old_0043_narinfo`;',
					'ALTER TABLE `__bounded_0043_narinfo` RENAME TO `narinfo`;',
					...narinfoOperationalTriggers,
					...narinfoCatalogueTriggers
				]
			},
			{
				kind: 'page',
				name: 'drain-old-0043-narinfos',
				source: '__bounded_old_0043_narinfo',
				writesPerSourceRow: 1,
				statements: (cursor, last) => [
					`DELETE FROM \`__bounded_old_0043_narinfo\` WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)};`
				]
			},
			{
				kind: 'batch',
				name: 'drop-old-0043-narinfos',
				statements: ['DROP TABLE `__bounded_old_0043_narinfo`;']
			},
			{
				kind: 'batch',
				name: 'prepare-canonical-0043-narinfos',
				statements: [canonicalNarinfoTable, ...canonicalNarinfoIndexes]
			},
			{
				kind: 'page',
				name: 'copy-canonical-0043-narinfos',
				source: 'narinfo',
				writesPerSourceRow: 1,
				statements: (cursor, last) => [
					`INSERT OR REPLACE INTO \`__bounded_canonical_0043_narinfo\` (${narinfoColumns.map((column) => `\`${column}\``).join(', ')})
SELECT ${narinfoValues('')} FROM \`narinfo\`
WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)};`
				]
			},
			{
				kind: 'batch',
				name: 'switch-canonical-0043-narinfos',
				statements: [
					...['insert', 'update'].map(
						(event) => `DROP TRIGGER \`__bounded_catalogue_narinfo_${event}\`;`
					),
					...[
						'garbage_collection_revision_narinfo_insert',
						'garbage_collection_revision_narinfo_update',
						'garbage_collection_revision_narinfo_delete',
						'narinfo_backfill_insert',
						'narinfo_backfill_update'
					].map((trigger) => `DROP TRIGGER \`${trigger}\`;`),
					'ALTER TABLE `narinfo` RENAME TO `__bounded_noncanonical_0043_narinfo`;',
					'ALTER TABLE `__bounded_canonical_0043_narinfo` RENAME TO `narinfo`;',
					...narinfoOperationalTriggers,
					...narinfoCatalogueTriggers
				]
			},
			{
				kind: 'page',
				name: 'drain-noncanonical-0043-narinfos',
				source: '__bounded_noncanonical_0043_narinfo',
				writesPerSourceRow: 1,
				statements: (cursor, last) => [
					`DELETE FROM \`__bounded_noncanonical_0043_narinfo\` WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)};`
				]
			},
			{
				kind: 'batch',
				name: 'drop-noncanonical-0043-narinfos',
				statements: ['DROP TABLE `__bounded_noncanonical_0043_narinfo`;']
			},
			{
				kind: 'batch',
				name: 'detach-completed-0043-mirrors',
				statements: [
					...dropTriggers(catalogueSourceTriggerNames),
					...dropTriggers(cacheCatalogueTriggerNames),
					...dropTriggers(reuseSelectorCompatibilityTriggerNames)
				]
			},
			{
				kind: 'page',
				name: 'drain-completed-0043-catalogue',
				source: legacyCatalogueTable,
				writesPerSourceRow: 1,
				statements: (cursor, last) => [
					`DELETE FROM \`${legacyCatalogueTable}\` WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)};`
				]
			},
			{
				kind: 'batch',
				name: 'drop-completed-0043-catalogue',
				statements: [
					...dropTriggers(catalogueIdentityTriggerNames),
					'DROP INDEX `__bounded_reuse_selector_identity_idx`;',
					`DROP TABLE \`${legacyCatalogueTable}\`;`
				]
			}
		]
	};
}

const finalTables: readonly RebuildTable[] = [
	{ table: 'retention_policy', create: 33, copy: 34, indexes: [38, 39] },
	{ table: 'narinfo', create: 40, copy: 41, indexes: [44, 45, 46] },
	{ table: 'retention_root', create: 47, copy: 48, indexes: [51, 52] },
	{ table: 'garbage_collection_frontier', create: 53, copy: 54, indexes: [] },
	{ table: 'garbage_collection_mark', create: 57, copy: 58, indexes: [] },
	{ table: 'generation_seq', create: 61, copy: 62, indexes: [65, 66] },
	{ table: 'narinfo_deletion', create: 67, copy: 68, indexes: [] },
	{ table: 'retention_grace', create: 71, copy: 72, indexes: [75] },
	{ table: 'retention_root_target', create: 76, copy: 77, indexes: [] },
	{ table: 'cache_identity', create: 80, copy: 81, indexes: [84, 85, 86, 87] },
	{ table: 'garbage_collection_revision', create: 88, copy: 89, indexes: [] },
	{ table: 'garbage_collection_scan', create: 92, copy: 93, indexes: [] },
	{ table: 'garbage_collection_tenant_run', create: 96, copy: 97, indexes: [] },
	{ table: 'pending_attestation', create: 100, copy: 101, indexes: [104, 105] },
	{
		table: 'pending_upload',
		create: 106,
		copy: 107,
		indexes: [110, 111, 112, 113, 114]
	},
	{ table: 'reuse_view', create: 115, copy: 116, indexes: [119] },
	{ table: 'verification_cursor', create: 120, copy: 121, indexes: [] }
];

function copyStage(
	table: RebuildTable,
	statements: readonly string[]
): LocalMigrationStage {
	return {
		kind: 'page',
		name: `copy-${table.table}`,
		source: table.table,
		writesPerSourceRow: 1,
		statements: (cursor, last) => [
			boundedCopy(
				statementAt(statements, table.copy),
				table.table,
				cursor,
				last
			)
		]
	};
}

function drainStage(table: string): LocalMigrationStage {
	return {
		kind: 'page',
		name: `drain-old-${table}`,
		source: `__bounded_old_${table}`,
		writesPerSourceRow: 1,
		statements: (cursor, last) => [
			`DELETE FROM \`__bounded_old_${table}\` WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)};`
		]
	};
}

function canonicalCopyStage(
	table: RebuildTable,
	statements: readonly string[]
): LocalMigrationStage {
	return {
		kind: 'page',
		name: `copy-canonical-${table.table}`,
		source: table.table,
		writesPerSourceRow: 1,
		statements: (cursor, last) => [
			boundedCopy(
				canonicalTable(statementAt(statements, table.copy), table.table),
				table.table,
				cursor,
				last
			)
		]
	};
}

function drainNoncanonicalStage(table: string): LocalMigrationStage {
	const source = `__bounded_noncanonical_${table}`;

	return {
		kind: 'page',
		name: `drain-noncanonical-${table}`,
		source,
		writesPerSourceRow: 1,
		statements: (cursor, last) => [
			`DELETE FROM \`${source}\` WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)};`
		]
	};
}

function finalContractRecipe(
	tag: string,
	statements: readonly string[]
): LocalMigrationRecipe {
	const discarded = ['cache', 'reuse_view_selector'] as const;
	const indexedFinalTables = finalTables.filter(
		(table) => table.indexes.length > 0
	);

	return {
		tag,
		rowsPerPage,
		sourceRowsPerInvocation,
		structuralOperationsPerInvocation: 365,
		stages: [
			{
				kind: 'batch',
				name: 'prepare-indexed-final-shadows',
				statements: [
					...finalTables.flatMap((table) => [
						statementAt(statements, table.create),
						...table.indexes.map((index) =>
							shadowIndex(statementAt(statements, index), table.table)
						)
					]),
					reuseSelectorNativeTable('__new_reuse_view_selector_native'),
					'CREATE INDEX `__bounded_reuse_view_selector_native_view_idx` ON `__new_reuse_view_selector_native` (`view`);',
					'CREATE TABLE `__bounded_reuse_selector_native_sequence` (`seq` integer NOT NULL);',
					"INSERT INTO `__bounded_reuse_selector_native_sequence` (`seq`) SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'reuse_view_selector_native';"
				]
			},
			...finalTables.map((table) => copyStage(table, statements)),
			copyReuseSelectorNativeStage(
				'__new_reuse_view_selector_native',
				'copy-reuse-view-selector-native'
			),
			{
				kind: 'batch',
				name: 'switch-final-shadows',
				statements: [
					...legacyCacheSources.flatMap((source) => [
						`DROP TRIGGER IF EXISTS \`${source.table}_backfill_insert\`;`,
						`DROP TRIGGER IF EXISTS \`${source.table}_backfill_update\`;`
					]),
					'DROP TRIGGER IF EXISTS `cache_identity_backfill_insert`;',
					'DROP TRIGGER IF EXISTS `cache_identity_backfill_revive`;',
					...discarded.map(
						(table) =>
							`ALTER TABLE \`${table}\` RENAME TO \`__bounded_old_${table}\`;`
					),
					'PRAGMA foreign_keys=OFF;',
					...finalTables.flatMap((table) => [
						`ALTER TABLE \`${table.table}\` RENAME TO \`__bounded_old_${table.table}\`;`,
						`ALTER TABLE \`__new_${table.table}\` RENAME TO \`${table.table}\`;`
					]),
					'ALTER TABLE `reuse_view_selector_native` RENAME TO `__bounded_old_reuse_view_selector_native`;',
					'ALTER TABLE `__new_reuse_view_selector_native` RENAME TO `reuse_view_selector_native`;',
					'PRAGMA foreign_keys=ON;'
				]
			},
			...discarded.map((table) => drainStage(table)),
			...finalTables.map((table) => drainStage(table.table)),
			drainStage('reuse_view_selector_native'),
			{
				kind: 'batch',
				name: 'drop-empty-expanded-tables',
				statements: [
					...discarded.map((table) => `DROP TABLE \`__bounded_old_${table}\`;`),
					...finalTables.map(
						(table) => `DROP TABLE \`__bounded_old_${table.table}\`;`
					),
					'DROP TABLE `__bounded_old_reuse_view_selector_native`;',
					statementAt(statements, 124)
				]
			},
			{
				kind: 'batch',
				name: 'prepare-canonical-final-shadows',
				statements: [
					...indexedFinalTables.flatMap((table) => [
						canonicalTable(statementAt(statements, table.create), table.table),
						...table.indexes.map((index) =>
							canonicalIndex(statementAt(statements, index), table.table)
						)
					]),
					reuseSelectorNativeTable(
						'__bounded_canonical_reuse_view_selector_native'
					),
					'CREATE INDEX `reuse_view_selector_native_view_idx` ON `__bounded_canonical_reuse_view_selector_native` (`view`);'
				]
			},
			...indexedFinalTables.map((table) =>
				canonicalCopyStage(table, statements)
			),
			copyReuseSelectorNativeStage(
				'__bounded_canonical_reuse_view_selector_native',
				'copy-canonical-reuse-view-selector-native'
			),
			{
				kind: 'batch',
				name: 'switch-canonical-final-shadows',
				statements: [
					...indexedFinalTables.flatMap((table) => [
						`ALTER TABLE \`${table.table}\` RENAME TO \`__bounded_noncanonical_${table.table}\`;`,
						`ALTER TABLE \`${canonicalTableName(table.table)}\` RENAME TO \`${table.table}\`;`
					]),
					'ALTER TABLE `reuse_view_selector_native` RENAME TO `__bounded_noncanonical_reuse_view_selector_native`;',
					"DELETE FROM `sqlite_sequence` WHERE `name` = '__bounded_canonical_reuse_view_selector_native';",
					"INSERT INTO `sqlite_sequence` (`name`, `seq`) SELECT '__bounded_canonical_reuse_view_selector_native', `seq` FROM `__bounded_reuse_selector_native_sequence`;",
					'ALTER TABLE `__bounded_canonical_reuse_view_selector_native` RENAME TO `reuse_view_selector_native`;'
				]
			},
			...indexedFinalTables.map((table) => drainNoncanonicalStage(table.table)),
			drainNoncanonicalStage('reuse_view_selector_native'),
			{
				kind: 'batch',
				name: 'drop-noncanonical-final-tables',
				statements: [
					...indexedFinalTables.map(
						(table) => `DROP TABLE \`__bounded_noncanonical_${table.table}\`;`
					),
					'DROP TABLE `__bounded_noncanonical_reuse_view_selector_native`;',
					'DROP TABLE `__bounded_reuse_selector_native_sequence`;'
				]
			}
		]
	};
}

function generationSourceStage(
	table: 'generation_seq' | 'narinfo' | 'narinfo_deletion'
): LocalMigrationStage {
	const selection =
		table === 'generation_seq'
			? '`cache`, `cache_kind`, `cache_name`, `store_path_hash`, `next_generation`'
			: `\`cache\`, CASE WHEN \`cache\` = '' THEN 'default' ELSE 'named' END,
	CASE WHEN \`cache\` = '' THEN NULL WHEN \`cache\` LIKE 'private/%' THEN substr(\`cache\`, 9) ELSE \`cache\` END,
	\`store_path_hash\`, \`generation\` + 1`;

	return {
		kind: 'page',
		name: `collect-generation-${table}`,
		source: table,
		writesPerSourceRow: 1,
		statements: (cursor, last) => [
			`INSERT INTO \`__bounded_generation_seq\` (
	\`cache\`, \`cache_kind\`, \`cache_name\`, \`store_path_hash\`, \`next_generation\`
)
SELECT ${selection} FROM \`${table}\`
WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)}
ON CONFLICT (\`cache\`, \`store_path_hash\`) DO UPDATE SET
	\`next_generation\` = max(\`next_generation\`, excluded.\`next_generation\`);`
		]
	};
}

function cacheIdentityAssertionRecipe(
	tag: string,
	statements: readonly string[]
): LocalMigrationRecipe {
	const updates: readonly [number, string, boolean][] = [
		[2, 'reuse_view', true],
		[3, 'reuse_view_revision_seq', true],
		[4, 'reuse_view_selector_native', true],
		[5, 'narinfo', true],
		[6, 'narinfo_deletion', true],
		[7, 'pending_upload', true],
		[8, 'pending_attestation', true],
		[9, 'retention_root', true],
		[10, 'retention_root_target', true],
		[11, 'retention_grace', true],
		[12, 'garbage_collection_revision', true],
		[13, 'garbage_collection_scan', true],
		[14, 'garbage_collection_frontier', true],
		[15, 'garbage_collection_mark', true],
		[16, 'garbage_collection_tenant_run', true],
		[17, 'verification_cursor', true],
		[18, 'retention_policy', true],
		[19, 'retention_policy', true],
		[20, 'retention_policy', true]
	];
	const nullableColumns: readonly [string, string][] = [
		['cache_identity', '`access` IS NULL'],
		['reuse_view', '`access` IS NULL'],
		['narinfo', '`cache_id` IS NULL'],
		['narinfo_deletion', '`cache_id` IS NULL'],
		['pending_upload', '`cache_id` IS NULL'],
		['pending_attestation', '`cache_id` IS NULL'],
		['retention_root', '`cache_id` IS NULL'],
		['retention_root_target', '`cache_id` IS NULL'],
		['retention_grace', '`cache_id` IS NULL'],
		['garbage_collection_revision', '`cache_id` IS NULL'],
		['garbage_collection_scan', '`cache_id` IS NULL'],
		['garbage_collection_frontier', '`cache_id` IS NULL'],
		['garbage_collection_mark', '`cache_id` IS NULL'],
		['garbage_collection_tenant_run', '`cache_id` IS NULL'],
		['verification_cursor', '`cache_id` IS NULL'],
		['retention_policy', '`kind` IS NULL']
	];
	const uniqueKeys: readonly [string, string, string, string?][] = [
		['narinfo', 'narinfo', '`cache_id`, `store_path_hash`'],
		[
			'narinfo_deletion',
			'narinfo-deletion',
			'`cache_id`, `store_path_hash`, `generation`'
		],
		['retention_root', 'retention-root', '`cache_id`, `name`'],
		[
			'retention_root_target',
			'retention-root-target',
			'`cache_id`, `root_name`, `store_path_hash`'
		],
		['retention_grace', 'retention-grace', '`cache_id`, `store_path_hash`'],
		['garbage_collection_revision', 'gc-revision', '`cache_id`'],
		['garbage_collection_scan', 'gc-scan', '`cache_id`'],
		[
			'garbage_collection_frontier',
			'gc-frontier',
			'`cache_id`, `store_path_hash`'
		],
		['garbage_collection_mark', 'gc-mark', '`cache_id`, `store_path_hash`'],
		['retention_policy', 'policy-cache', '`cache_id`', "`kind` = 'cache'"],
		[
			'retention_policy',
			'policy-root-prefix',
			'`root_name_prefix`',
			"`kind` = 'root-name-prefix'"
		]
	];

	return {
		tag,
		rowsPerPage,
		sourceRowsPerInvocation,
		structuralOperationsPerInvocation: 365,
		stages: [
			{
				kind: 'batch',
				name: 'prepare-contract-assertions',
				statements: [
					statementAt(statements, 0),
					'CREATE TABLE `__bounded_reuse_revision_names` (`name` text PRIMARY KEY NOT NULL);',
					'CREATE TABLE `__bounded_cache_identity_keys` (`family` text NOT NULL, `key` text NOT NULL, PRIMARY KEY (`family`, `key`));'
				]
			},
			{
				kind: 'page',
				name: 'assert-reuse-revision-names',
				source: 'reuse_view_revision_seq',
				writesPerSourceRow: 1,
				statements: (cursor, last) => [
					`INSERT INTO \`__bounded_reuse_revision_names\` (\`name\`)
SELECT CASE WHEN \`name\` LIKE 'private/%' THEN substr(\`name\`, 9) ELSE \`name\` END
FROM \`reuse_view_revision_seq\`
WHERE rowid > ${String(cursor)} AND rowid <= ${String(last)};`
				]
			},
			{
				kind: 'batch',
				name: 'finish-reuse-revision-assertion',
				statements: ['DROP TABLE `__bounded_reuse_revision_names`;']
			},
			...updates.map(([index, table, hasWhere]) =>
				mutationStage(statements, index, table, hasWhere)
			),
			{
				kind: 'batch',
				name: 'prepare-generation-shadow',
				statements: [
					`CREATE TABLE \`__bounded_generation_seq\` (
	\`cache\` text DEFAULT '' NOT NULL,
	\`store_path_hash\` text NOT NULL,
	\`next_generation\` integer DEFAULT 0 NOT NULL,
	\`cache_kind\` text, \`cache_name\` text,
	PRIMARY KEY(\`cache\`, \`store_path_hash\`)
);`
				]
			},
			...(['generation_seq', 'narinfo', 'narinfo_deletion'] as const).map(
				(table) => generationSourceStage(table)
			),
			{
				kind: 'batch',
				name: 'switch-generation-shadow',
				statements: [
					'ALTER TABLE `generation_seq` RENAME TO `__bounded_old_generation_seq`;',
					'ALTER TABLE `__bounded_generation_seq` RENAME TO `generation_seq`;'
				]
			},
			drainStage('generation_seq'),
			...nullableColumns.map(([table, predicate]) =>
				assertionStage(table, predicate)
			),
			...uniqueKeys.map(([table, family, key, predicate]) =>
				uniquenessStage(table, family, key, predicate)
			),
			{
				kind: 'batch',
				name: 'drop-old-generation-sequence',
				statements: [
					'DROP TABLE `__bounded_old_generation_seq`;',
					'DROP TABLE `__bounded_cache_identity_keys`;',
					statementAt(statements, 28)
				]
			}
		]
	};
}

export function localMigrationRecipe(
	tag: string,
	statements: readonly string[]
): LocalMigrationRecipe | undefined {
	if (tag === '0043_cache_access_backfill') {
		return cacheAccessBackfillRecipe(tag, statements);
	}

	if (tag === '0052_cache_identity_contract') {
		return finalContractRecipe(tag, statements);
	}

	if (tag === '0051_cache_identity_contract_assertions') {
		return cacheIdentityAssertionRecipe(tag, statements);
	}

	return undefined;
}
