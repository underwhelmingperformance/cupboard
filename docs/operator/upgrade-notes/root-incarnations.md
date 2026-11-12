# Root replacements finish in a background pass

From this version, replacing or removing a retention root no longer releases the
root's old targets inside the request. The tenant records a root release, and a
background pass applies the grace period to the old targets and deletes them in
pages. The grace period still counts from the replacement or the removal. Until
the pass reaches them, the old targets stay kept, so a cache can keep released
store paths slightly longer than before. An expired root leaves
`cupboard root list` as soon as a collection starts on its cache.

A push that finishes after garbage collection has removed its expired run root,
or after the root has been removed, no longer adds its store paths to the root.
Earlier versions added them to a root that no longer existed, and nothing
released them again. These leftover targets don't appear in `cupboard root list`
or `cupboard root targets`. Creating a root of the same name, with
`cupboard root set` or a push that creates its run root, releases them. To
release them without a new root, run `cupboard root remove` for the root's name.
The names to try are those of run roots whose CI runs pushed again after the run
root had expired. With the CLI from this release, the command reports
`not present; its leftover store paths are released` when it releases leftover
store paths. An earlier CLI releases them too, but reports only `not present`.

The upgrade adds two columns, four indexes and a table to each tenant's storage.
One of the indexes has an entry for every existing root target, so the upgrade
writes about one row for each root target that a tenant has. Building that index
over 10 million root targets took about 5 seconds with SQLite 3.53, on a
database file whose pages were already in the operating system's cache. A cold
build takes longer.

## Rolling back

You can't roll back past this release. Once a tenant has upgraded its storage,
an earlier version refuses every request for that tenant, and the tenant stays
unavailable until you deploy this release or a later one again.
