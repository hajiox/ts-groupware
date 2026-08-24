ALTER TABLE gw_users
  ADD COLUMN IF NOT EXISTS department TEXT;

CREATE TEMP TABLE IF NOT EXISTS _gw_users_department_seed AS
SELECT id
FROM gw_users
WHERE department IS NULL
   OR department NOT IN ('フロア', '製造', '道の駅');

UPDATE gw_users
SET department = '製造'
WHERE id IN (SELECT id FROM _gw_users_department_seed);

UPDATE gw_users
SET department = 'フロア'
WHERE id IN (
  SELECT DISTINCT gm.user_id
  FROM gw_group_members gm
  JOIN gw_groups g ON g.id = gm.group_id
  WHERE gm.user_id IN (SELECT id FROM _gw_users_department_seed)
    AND g.name LIKE '%TS%'
    AND g.name LIKE '%売上%'
    AND g.name LIKE '%新規%'
    AND g.name LIKE '%HAPPY%'
);

UPDATE gw_users
SET department = '道の駅'
WHERE id IN (
  SELECT DISTINCT gm.user_id
  FROM gw_group_members gm
  JOIN gw_groups g ON g.id = gm.group_id
  WHERE gm.user_id IN (SELECT id FROM _gw_users_department_seed)
    AND g.name LIKE '%staff%'
    AND g.name LIKE '%道の駅%'
    AND g.name LIKE '%会津食のブランド館%'
);

DROP TABLE IF EXISTS _gw_users_department_seed;

ALTER TABLE gw_users
  ALTER COLUMN department SET DEFAULT '製造',
  ALTER COLUMN department SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gw_users_department_check'
  ) THEN
    ALTER TABLE gw_users
      ADD CONSTRAINT gw_users_department_check
      CHECK (department IN ('フロア', '製造', '道の駅'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gw_users_department ON gw_users(department);

COMMENT ON COLUMN gw_users.department IS 'TSG department: フロア, 製造, 道の駅';
