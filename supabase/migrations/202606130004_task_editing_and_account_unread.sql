-- Task edit support: keep removed assignees as canceled history.
ALTER TABLE gw_tasks
  ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS canceled_by UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_gw_tasks_assignee_open_active
  ON gw_tasks(assignee_id, due_date)
  WHERE completed_at IS NULL AND canceled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_gw_tasks_post_active
  ON gw_tasks(post_id, due_date)
  WHERE canceled_at IS NULL;

COMMENT ON COLUMN gw_tasks.canceled_at IS 'Set when a task assignee is removed by editing the task request. The row is kept as history.';
COMMENT ON COLUMN gw_tasks.canceled_by IS 'User who removed the assignee from the task request.';
COMMENT ON COLUMN gw_tasks.cancel_reason IS 'Reason for canceling this assignee row.';

NOTIFY pgrst, 'reload schema';
