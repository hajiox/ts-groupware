-- Read-only audit for the executive account currently reporting inflated unread counts.
-- Do not select post bodies, LINE identifiers, or other personal data.

WITH target_user AS (
  SELECT id
  FROM gw_users
  WHERE status = 'approved'
    AND regexp_replace(display_name, '\s+', '', 'g') = '佐藤正彦'
  ORDER BY created_at
  LIMIT 1
),
device_reads AS (
  SELECT user_id, group_id, max(last_read_at) AS last_device_read_at
  FROM gw_device_read_status
  WHERE user_id = (SELECT id FROM target_user)
  GROUP BY user_id, group_id
),
group_audit AS (
  SELECT
    g.id AS group_id,
    g.name AS group_name,
    g.type AS group_type,
    gm.joined_at,
    rs.last_read_at AS account_read_at,
    dr.last_device_read_at,
    max(p.created_at) AS latest_post_at,
    count(p.id) AS all_time_other_posts,
    count(p.id) FILTER (
      WHERE rs.last_read_at IS NULL OR p.created_at > rs.last_read_at
    ) AS current_unread_count,
    count(p.id) FILTER (
      WHERE p.created_at > coalesce(
        rs.last_read_at,
        dr.last_device_read_at,
        gm.joined_at
      )
    ) AS recovered_unread_count,
    CASE
      WHEN rs.last_read_at IS NOT NULL THEN 'account'
      WHEN dr.last_device_read_at IS NOT NULL THEN 'device_fallback'
      ELSE 'membership_fallback'
    END AS recovery_source
  FROM target_user u
  JOIN gw_group_members gm ON gm.user_id = u.id
  JOIN gw_groups g ON g.id = gm.group_id
  LEFT JOIN gw_read_status rs
    ON rs.user_id = u.id
   AND rs.group_id = gm.group_id
  LEFT JOIN device_reads dr
    ON dr.user_id = u.id
   AND dr.group_id = gm.group_id
  LEFT JOIN gw_posts p
    ON p.group_id = gm.group_id
   AND p.parent_id IS NULL
   AND p.user_id <> u.id
  GROUP BY
    g.id,
    g.name,
    g.type,
    gm.joined_at,
    rs.last_read_at,
    dr.last_device_read_at
),
approved_memberships AS (
  SELECT gm.user_id, gm.group_id
  FROM gw_group_members gm
  JOIN gw_users u ON u.id = gm.user_id
  WHERE u.status = 'approved'
),
device_pairs AS (
  SELECT DISTINCT user_id, group_id
  FROM gw_device_read_status
),
account_pairs AS (
  SELECT user_id, group_id
  FROM gw_read_status
),
audit_summary AS (
  SELECT
    count(*) AS approved_membership_pairs,
    count(*) FILTER (WHERE ar.user_id IS NULL) AS missing_account_read_pairs,
    count(*) FILTER (
      WHERE ar.user_id IS NULL AND dr.user_id IS NOT NULL
    ) AS recoverable_from_device_pairs,
    count(*) FILTER (
      WHERE ar.user_id IS NULL AND dr.user_id IS NULL
    ) AS membership_fallback_pairs
  FROM approved_memberships am
  LEFT JOIN account_pairs ar
    ON ar.user_id = am.user_id
   AND ar.group_id = am.group_id
  LEFT JOIN device_pairs dr
    ON dr.user_id = am.user_id
   AND dr.group_id = am.group_id
)
SELECT
  group_name,
  group_type,
  joined_at,
  account_read_at,
  last_device_read_at,
  latest_post_at,
  all_time_other_posts,
  current_unread_count,
  recovered_unread_count,
  recovery_source
FROM group_audit
UNION ALL
SELECT
  '__SUMMARY__',
  'audit',
  NULL,
  NULL,
  NULL,
  NULL,
  approved_membership_pairs,
  missing_account_read_pairs,
  recoverable_from_device_pairs,
  'membership_fallback=' || membership_fallback_pairs
FROM audit_summary
ORDER BY current_unread_count DESC, group_name;
