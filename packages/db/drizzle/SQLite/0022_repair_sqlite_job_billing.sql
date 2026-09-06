-- SQLite's original billing history omitted the column used by the jobs model.
-- PostgreSQL already adds it in 0010; existing applied migrations are unchanged.
ALTER TABLE `jobs` ADD `deducted_at` integer;
