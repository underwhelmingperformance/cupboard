insert into cache_identity (kind, name, access, priority, grace_managed, created_at)
		select
			'named',
			case when cache.name like 'private/%' then substr(cache.name, 9) else cache.name end,
			case when cache.name like 'private/%' then 'private' else null end,
			priority,
			grace_managed,
			created_at
		from cache
		where cache.name <> ''
			and not exists (
				select 1 from cache_identity identity
				where identity.kind = 'named'
					and identity.name = case when cache.name like 'private/%' then substr(cache.name, 9) else cache.name end
					and (
						identity.deleted_at is null
						or identity.deleted_at >= cache.created_at
					)
			)
		on conflict do nothing;
