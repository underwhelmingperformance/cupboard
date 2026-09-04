import {
	type LocalMigrationRecipe,
	type LocalMigrationStage
} from './bounded-migration.ts';

const rowsPerPage = 1000;
const sourceRowsPerInvocation = 1000;
const structuralOperationsPerInvocation = 256;

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

export function localMigrationRecipe(
	tag: string,
	statements: readonly string[]
): LocalMigrationRecipe | undefined {
	if (tag === '0043_cache_access_backfill') {
		return cacheAccessBackfillRecipe(tag, statements);
	}

	return undefined;
}
