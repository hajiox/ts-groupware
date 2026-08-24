-- Read-only audit for approved users whose unread count is unexpectedly large.
-- Content and external identity fields are intentionally excluded.

WITH approved_memberships AS (
  SELECT
    u.id AS user_id,
    u.display_name,
    gm.group_id,
    gm.joined_at
  FROM gw_users u
  JOIN gw_group_members gm ON gm.user_id = u.id
  WHERE u.status = 'approved'
),
unread_by_group AS (
  SELECT
    am.user_id,
    am.display_name,
    g.name AS group_name,
    rs.last_read_at,
    count(p.id) AS all_time_other_posts,
    count(p.id) FILTER (
      WHERE rs.last_read_at IS NULL OR p.created_at > rs.last_read_at
    ) AS unread_count
  FROM approved_memberships am
  JOIN gw_groups g ON g.id = am.group_id
  LEFT JOIN gw_read_status rs
    ON rs.user_id = am.user_id
   AND rs.group_id = am.group_id
  LEFT JOIN gw_posts p
    ON p.group_id = am.group_id
   AND p.parent_id IS NULL
   AND p.user_id <> am.user_id
  GROUP BY am.user_id, am.display_name, g.name, rs.last_read_at
)
SELECT
  display_name,
  group_name,
  last_read_at,
  all_time_other_posts,
  unread_count,
  CASE
    WHEN last_read_at IS NULL THEN 'missing_read_row'
    ELSE 'read_row_present'
  END AS state
FROM unread_by_group
WHERE unread_count >= 10
ORDER BY unread_count DESC, display_name, group_name;
