export type BusinessMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type BusinessOperation = {
  id: string
  area: string
  description: string
  method: BusinessMethod
  path: string
  readOnly: boolean
  params: string[]
  queryFields: string[]
  bodyFields: string[]
  actions: string[]
  bodyMode: 'none' | 'json' | 'multipart'
  formFields: string[]
  fileFields: string[]
  sideEffects?: string
}

type Contract = Partial<Pick<BusinessOperation, 'queryFields' | 'bodyFields' | 'actions' | 'bodyMode' | 'formFields' | 'fileFields' | 'sideEffects'>>
const operations: BusinessOperation[] = []
function add(area: string, id: string, method: BusinessMethod, path: string, description: string, contract: Contract = {}) {
  operations.push({
    id, area, method, path, description,
    readOnly: method === 'GET' && !contract.sideEffects,
    params: [...path.matchAll(/\[([A-Za-z]+)\]/g)].map(match => match[1]),
    queryFields: [], bodyFields: [], actions: [], formFields: [], fileFields: [],
    bodyMode: method === 'GET' ? 'none' : 'json',
    ...contract,
  })
}

// Paths and methods are owned by the server. Client input can never choose a URL,
// HTTP method, module, table, credentials or an authentication endpoint.
add('users', 'users.list', 'GET', '/api/admin/users', 'List staff and their current approval, department, role and employment status.')
add('users', 'users.update', 'PUT', '/api/admin/users', 'Update staff identity, role, department or approval with the existing role restrictions.', { bodyFields: ['user_id', 'role', 'status', 'display_name', 'real_name', 'department'] })
add('users', 'users.delete', 'DELETE', '/api/admin/users', 'Delete a user using the existing user-deletion policy. For retirement use hr.employees.update with action retire.', { bodyFields: ['user_id'] })
add('groups', 'groups.list', 'GET', '/api/groups', 'List the current principal’s visible groups, boards and chats.')
add('groups', 'groups.create', 'POST', '/api/groups', 'Create a board or chat and its members with the current principal’s existing permissions.', { bodyFields: ['name', 'description', 'type', 'icon', 'add_all_members', 'addAllMembers'] })
add('groups', 'groups.admin.list', 'GET', '/api/admin/groups', 'List groups available to group management.')
add('groups', 'groups.delete', 'DELETE', '/api/admin/groups', 'Delete a group with the existing management policy.', { bodyFields: ['group_id'] })
add('groups', 'groups.members.list', 'GET', '/api/groups/[id]/members', 'List members of an authorized group.')
add('groups', 'groups.members.admin.list', 'GET', '/api/admin/members', 'List group-management members and candidates.', { queryFields: ['group_id'] })
add('groups', 'groups.members.add', 'POST', '/api/admin/members', 'Add selected users to a group.', { bodyFields: ['group_id', 'user_ids'] })
add('groups', 'groups.members.remove', 'DELETE', '/api/admin/members', 'Remove a user from a group.', { bodyFields: ['group_id', 'user_id'] })

add('hr', 'hr.employees.list', 'GET', '/api/admin/hr/employees', 'Read employee HR profiles, employment terms and linked resumes.')
add('hr', 'hr.employees.update', 'PATCH', '/api/admin/hr/employees', 'Update an employee profile or retire an employee without deleting historical records.', {
  bodyFields: ['id', 'action', 'resigned_date', 'employee_code', 'hire_date', 'kana', 'birth_date', 'gender', 'payroll_status', 'work_style', 'basic_work_start', 'basic_work_end', 'basic_break_minutes', 'user_id', 'hr_profile'], actions: ['retire'],
})
add('hr', 'hr.employees.delete', 'DELETE', '/api/admin/hr/employees', 'Apply the existing HR soft-deletion workflow.', { bodyFields: ['id', 'reason'] })
add('hr', 'hr.resumes.download', 'GET', '/api/admin/hr/resumes', 'Download a stored employee resume PDF.', { queryFields: ['document_id'] })
add('hr', 'hr.resumes.upload', 'POST', '/api/admin/hr/resumes', 'Upload a resume PDF for an existing employee and run its existing OCR workflow.', { bodyMode: 'multipart', formFields: ['employee_id'], fileFields: ['file'] })
add('hr', 'hr.resumes.reprocess', 'PUT', '/api/admin/hr/resumes', 'Reprocess an existing resume with the configured OCR workflow.', { bodyFields: ['document_id'] })
add('hr', 'hr.resumes.delete', 'DELETE', '/api/admin/hr/resumes', 'Delete an HR resume with the existing HR permission check.', { bodyFields: ['document_id'] })

const attendanceFields = ['user_id', 'punch_type', 'work_date', 'time', 'device_id', 'memo', 'private_vehicle_place', 'private_vehicle_distance_km', 'break_override_minutes', 'break_override_reason']
add('attendance', 'attendance.admin.list', 'GET', '/api/admin/attendance', 'Read punches, corrections, daily summaries and monthly staff memos.', { queryFields: ['date', 'date_from', 'date_to', 'include_voided', 'user_id', 'device_id'] })
add('attendance', 'attendance.punches.create', 'POST', '/api/admin/attendance', 'Register a manual attendance punch as an administrator.', { bodyFields: attendanceFields })
add('attendance', 'attendance.admin.update', 'PATCH', '/api/admin/attendance', 'Correct or void punches, edit a day, or save monthly staff memos and checks.', {
  bodyFields: [...attendanceFields, 'id', 'action', 'ids', 'reason', 'clock_in_time', 'clock_out_time', 'month', 'expected_updated_at', 'checked'],
  actions: ['update', 'void', 'bulk_void', 'monthly_day_delete', 'monthly_day_update', 'monthly_memo_save', 'monthly_staff_check'],
})
add('attendance', 'attendance.export', 'GET', '/api/admin/attendance/export', 'Download the existing attendance export workbook.', { queryFields: ['month', 'department'] })
add('attendance', 'attendance.submission.prepare', 'GET', '/api/admin/attendance/submit', 'Read labor-office submission recipients and available employee documents.', { queryFields: ['month'] })
add('attendance', 'attendance.submission.send', 'POST', '/api/admin/attendance/submit', 'Send the attendance report to the configured labor-office recipients; this sends real email.', { bodyMode: 'multipart', formFields: ['month', 'doc_scanner_document_ids'], fileFields: ['new_employee_files', 'doc_scanner_files'] })
add('attendance', 'attendance.present', 'GET', '/api/attendance/present', 'Read the current attendance/presence display.')
add('attendance', 'attendance.punches.own', 'GET', '/api/attendance/punches', 'Read the current principal’s punches.', { queryFields: ['month', 'include_voided'] })

add('payroll', 'payroll.employees.list', 'GET', '/api/admin/payroll/employees', 'Read payroll employee identities and linked TSG accounts.')
add('payroll', 'payroll.employees.update', 'PATCH', '/api/admin/payroll/employees', 'Link a payroll employee to a user or update its active/inactive state. Retirement is in HR.', { bodyFields: ['id', 'user_id', 'payroll_status'] })
add('payroll', 'payroll.aliases.merge', 'POST', '/api/admin/payroll/employee-aliases', 'Merge an explicitly selected duplicate payroll identity into another employee.', { bodyFields: ['sourceEmployeeId', 'targetEmployeeId'] })
add('payroll', 'payroll.diff', 'GET', '/api/admin/payroll/diff', 'Read the current payroll comparison with the labor-office import.', { queryFields: ['periodId', 'payrollMonth', 'payrollKind'] })
add('payroll', 'payroll.calculation-profiles', 'GET', '/api/admin/payroll/calculation-profiles', 'Read the saved payroll calculation profiles.', { queryFields: ['month'] })
add('payroll', 'payroll.labor-costs', 'GET', '/api/admin/payroll/labor-costs', 'Read payroll labor-cost analysis.')
add('payroll', 'payroll.stability', 'GET', '/api/admin/payroll/stability', 'Read month-to-month payroll logic stability analysis.', { queryFields: ['payrollMonth'] })
add('payroll', 'payroll.mail-jobs.list', 'GET', '/api/admin/payroll/mail-jobs', 'Read the latest 24 saved payroll email import/comparison jobs, uncompleted reasons, DM report status and matching employee names shown in payroll-mail management.')
add('payroll', 'payroll.imports.list', 'GET', '/api/admin/labor/imports', 'List labor-office import batches and source documents.')
add('payroll', 'payroll.imports.upload', 'POST', '/api/admin/labor/imports/upload', 'Upload an existing-format labor-office ZIP and import its payroll/attendance sources.', { bodyMode: 'multipart', formFields: ['payrollMonth', 'attendanceMonth', 'payrollKind'], fileFields: ['file'] })
add('payroll', 'payroll.imports.analyze', 'POST', '/api/admin/labor/imports/[batchId]/analyze', 'Analyze an uploaded labor-office batch using the existing import logic.')
add('payroll', 'payroll.imports.reconcile', 'POST', '/api/admin/labor/imports/reconcile', 'Create missing payroll periods from existing nonvoided import batches.')

add('leave', 'leave.admin.list', 'GET', '/api/admin/paid-leave', 'Read the leave-management dashboard, balances, grants and pending attendance resolutions.', { queryFields: ['user_id'], sideEffects: 'The existing dashboard synchronizes grant lots and account profiles, or voids leave data for excluded employees.' })
add('leave', 'leave.admin.update', 'POST', '/api/admin/paid-leave', 'Register or approve/reject leave, resolve attendance issues, and adjust grants with the existing approver policy.', {
  bodyFields: ['action', 'employee_id', 'leave_date', 'leave_unit', 'memo', 'request_id', 'assignment_id', 'work_date', 'resolution_type', 'manager_memo', 'resolution_id', 'grant_date', 'days', 'notes', 'effective_date'],
  actions: ['register_employee_leave', 'approve_request', 'resolve_unanswered_issue', 'reject_request', 'confirm_resolution', 'reopen_resolution', 'add_grant', 'deduct_opening_usage'],
})
add('leave', 'leave.pending', 'GET', '/api/admin/paid-leave/pending', 'Read pending leave approvals.')
add('leave', 'leave.own', 'GET', '/api/paid-leave', 'Read personal leave information; authorized proxy views retain the existing proxy audit.', { queryFields: ['user_id'], sideEffects: 'The existing dashboard synchronizes grant lots and account profiles, or voids leave data for excluded employees.' })
add('leave', 'leave.request', 'POST', '/api/paid-leave', 'Submit personal leave or answer an unresolved attendance issue.', { bodyFields: ['action', 'leave_date', 'leave_unit', 'memo', 'work_date', 'assignment_id', 'resolution_type'], actions: ['request_leave', 'answer_missing'] })
add('leave', 'leave.bereavement.list', 'GET', '/api/bereavement-leave', 'Read eligible bereavement leave and visible requests.')
add('leave', 'leave.bereavement.update', 'POST', '/api/bereavement-leave', 'Preview, submit, approve, reject or cancel bereavement leave with the existing employment/approver checks.', { bodyFields: ['action', 'relationship_code', 'leave_start_date', 'employee_memo', 'requested_days', 'request_id', 'manager_memo'], actions: ['preview', 'submit', 'approve', 'reject', 'cancel'] })

add('appraisals', 'appraisals.list', 'GET', '/api/admin/appraisals', 'Read monthly appraisals and reviewer assignments visible to the current principal.', { queryFields: ['month'] })
add('appraisals', 'appraisals.save', 'POST', '/api/admin/appraisals', 'Assign/unassign reviewers or save a versioned appraisal and interview checklist. Only assigned employees can be appraised.', { bodyFields: ['employeeId', 'action', 'reviewerId', 'month', 'assessedOn', 'ratings', 'talkChecklist', 'status', 'version'], actions: ['assign', 'unassign'] })
add('pledges', 'pledges.admin.list', 'GET', '/api/admin/pledges', 'Read pledge templates, deliveries and submission status.')
add('pledges', 'pledges.admin.update', 'POST', '/api/admin/pledges', 'Save/activate a pledge template or send a pledge to specified recipients. send/send_test deliver real requests.', { bodyFields: ['action', 'template_id', 'title', 'body', 'agreement_label', 'company_name', 'is_active', 'check_items', 'target_type', 'department', 'user_ids'], actions: ['save_template', 'set_template_active', 'send', 'send_test'] })
add('pledges', 'pledges.paper.read', 'GET', '/api/admin/pledges/paper', 'Read an existing pledge’s paper-print data.', { queryFields: ['assignment_id', 'delivery_id'] })
add('pledges', 'pledges.paper.create', 'POST', '/api/admin/pledges/paper', 'Create a paper delivery from a pledge template.', { bodyFields: ['template_id'] })
add('pledges', 'pledges.own', 'GET', '/api/pledges', 'Read a pledge assigned to the current principal.', { queryFields: ['assignment_id'], sideEffects: 'The existing handler resets pledge assignments left processing for more than ten minutes to pending.' })
add('pledges', 'pledges.submit', 'POST', '/api/pledges', 'Submit the current principal’s actual pledge agreement using the accepted item IDs.', { bodyFields: ['assignment_id', 'accepted_item_ids'] })
add('pledges', 'pledges.pdf', 'GET', '/api/pledges/pdf', 'Download the current principal’s submitted pledge PDF.', { queryFields: ['assignment_id'] })

add('shifts', 'shifts.admin.list', 'GET', '/api/admin/shifts', 'Read shift periods, requests, assignments, patterns and planning settings.', { queryFields: ['period_id', 'department', 'calendar_refresh'], sideEffects: 'The existing handler may synchronize floor calendar sales into the selected shift period.' })
add('shifts', 'shifts.periods.create', 'POST', '/api/admin/shifts', 'Create a department shift period and its existing planning defaults.', { bodyFields: ['department', 'start_date', 'end_date', 'request_deadline', 'notes'] })
add('shifts', 'shifts.admin.update', 'PATCH', '/api/admin/shifts', 'Edit/confirm shifts, collection targets, requests, assignments, planning settings, order, patterns and sales. Notifications follow the existing action.', {
  bodyFields: ['action', 'period_id', 'ec_sale_tags', 'required_count', 'workplace_label', 'notes', 'notes2', 'notes3', 'production_plan', 'timee_count', 'ec_sale_times', 'shift_label', 'start_time', 'end_time', 'break_minutes', 'user_id', 'employee_id', 'note', 'department', 'start_date', 'end_date', 'request_deadline', 'label', 'color', 'sale_id', 'pattern_role', 'pattern_id', 'pattern_ids', 'effective_from', 'previous_start', 'previous_end', 'next_start', 'next_end', 'requirements', 'work_date', 'user_ids', 'finalize', 'assignments', 'request_changes', 'cell_styles', 'status', 'title', 'target_user_ids', 'cell_key', 'background_color', 'request_type', 'priority', 'memo', 'overwrite_ai'],
  actions: ['create_sale', 'update_sale', 'delete_sale', 'restore_sale', 'create_pattern', 'update_pattern', 'delete_pattern', 'reorder_patterns', 'apply_basic_work_time_change', 'update_confirmed_notes', 'convert_confirmed_request_to_company_off', 'delete_period', 'reorder_employees', 'reset_shift', 'save_shift_changes', 'update_period', 'start_test_collection', 'start_collection', 'remove_period_employee', 'restore_period_employee', 'bulk_clear_assignments', 'clear_requests', 'save_requirement', 'save_cell_color', 'save_request', 'save_assignment', 'generate_draft'],
})
add('shifts', 'shifts.export', 'GET', '/api/admin/shifts/export', 'Download the existing department shift export workbook.', { queryFields: ['period_id'] })
add('shifts', 'shifts.confirmed', 'GET', '/api/shifts/confirmed', 'Read confirmed shifts available in the staff view.')
add('shifts', 'shifts.requests.list', 'GET', '/api/shifts/requests', 'Read the current principal’s open shift-request periods and requests.', { sideEffects: 'The existing request view synchronizes the current principal’s paid-leave grant lots/account profile, or voids excluded leave data when checking availability.' })
add('shifts', 'shifts.requests.save', 'PATCH', '/api/shifts/requests', 'Save the current principal’s shift requests and constraints during an eligible collection period.', { bodyFields: ['period_id', 'requests', 'request_comment', 'max_work_days', 'target_work_days', 'min_days_off', 'max_consecutive_days'] })
add('shifts', 'shifts.alerts.list', 'GET', '/api/shifts/alerts', 'Read current principal’s shift confirmation alerts.')
add('shifts', 'shifts.alerts.read', 'POST', '/api/shifts/alerts', 'Mark a shift confirmation alert as seen.', { bodyFields: ['alert_id'] })

const calendarFields = ['id', 'title', 'starts_at', 'ends_at', 'description', 'location', 'all_day', 'color']
add('calendar', 'calendar.events.list', 'GET', '/api/calendar/events', 'Read visible calendar events.', { queryFields: ['range_start', 'range_end'], sideEffects: 'The existing handler may import configured Google calendar changes for this range.' })
add('calendar', 'calendar.events.create', 'POST', '/api/calendar/events', 'Create an event with the existing calendar permission checks.', { bodyFields: calendarFields })
add('calendar', 'calendar.events.update', 'PATCH', '/api/calendar/events', 'Update an editable event.', { bodyFields: calendarFields })
add('calendar', 'calendar.events.delete', 'DELETE', '/api/calendar/events', 'Delete an editable event.', { queryFields: ['id'] })
add('calendar', 'calendar.google.import', 'POST', '/api/calendar/import/google', 'Import the configured Google calendar for a specified date range.', { bodyFields: ['range_start', 'range_end'] })

add('posts', 'posts.list', 'GET', '/api/posts', 'Read an authorized board post/thread or board page.', { queryFields: ['id', 'group_id', 'parent_only', 'parent_id', 'limit', 'before'], sideEffects: 'The existing board view marks the group read for the current principal.' })
add('posts', 'posts.create', 'POST', '/api/posts', 'Create a board post, reply or task using existing posting policy; existing mention/task Push behavior applies.', { bodyFields: ['group_id', 'content', 'attachments', 'parent_id', 'reply_to_id', 'task'] })
add('posts', 'posts.update', 'PATCH', '/api/posts', 'Edit, pin or replace attachments of an authorized post.', { bodyFields: ['post_id', 'content', 'action', 'attachments', 'is_pinned', 'task'], actions: ['pin', 'attachments'] })
add('posts', 'posts.delete', 'DELETE', '/api/posts', 'Delete an authorized post and its existing associated records.', { queryFields: ['post_id'] })
add('chat', 'chat.messages.list', 'GET', '/api/chat', 'Read a chat/DM visible to the current principal.', { queryFields: ['id', 'group_id', 'since', 'limit'], sideEffects: 'The existing chat view may synchronize CodexMTG management membership and marks the group read.' })
add('chat', 'chat.messages.create', 'POST', '/api/chat', 'Send a chat/DM message using the existing chat and notification policy.', { bodyFields: ['group_id', 'content', 'attachments'] })
add('chat', 'chat.messages.update', 'PATCH', '/api/chat', 'Edit an authorized chat/DM message.', { bodyFields: ['message_id', 'content', 'attachments'] })
add('chat', 'chat.messages.delete', 'DELETE', '/api/chat', 'Delete an authorized chat/DM message.', { queryFields: ['message_id'] })
add('chat', 'chat.direct.list', 'GET', '/api/chat/direct', 'List direct-message recipients and existing direct chats.')
add('chat', 'chat.direct.open', 'POST', '/api/chat/direct', 'Open or create the current principal’s direct chat with an explicitly selected user.', { bodyFields: ['target_user_id'] })
add('chat', 'chat.direct.unread', 'GET', '/api/dm/unread', 'Read the current principal’s unread direct-message counts.')
add('tasks', 'tasks.list', 'GET', '/api/tasks', 'Read the current principal’s tasks and task summary.', { queryFields: ['summary', 'status'], sideEffects: 'The existing detailed task view prunes expired mention history for the current principal.' })
add('tasks', 'tasks.update', 'PATCH', '/api/tasks', 'Complete a task assigned to the current principal or manageable under the existing management policy.', { bodyFields: ['task_id'] })
add('posts', 'reactions.toggle', 'POST', '/api/reactions', 'Toggle a reaction on an authorized post.', { bodyFields: ['post_id', 'emoji'] })

add('company-messages', 'company-messages.list', 'GET', '/api/home-company-messages', 'Read visible all-staff messages or message history.', { queryFields: ['view'], sideEffects: 'The existing inbox handler runs due new-hire deliveries when view is not history.' })
add('company-messages', 'company-messages.create', 'POST', '/api/home-company-messages', 'Send an all-staff message using the existing specifically assigned author permission.', { bodyFields: ['title', 'body', 'attachment', 'new_hire_auto_send'] })
add('company-messages', 'company-messages.update', 'PATCH', '/api/home-company-messages', 'Set whether an existing all-staff message is automatically delivered to new hires.', { bodyFields: ['message_id', 'new_hire_auto_send'] })
add('company-messages', 'company-messages.dismiss', 'DELETE', '/api/home-company-messages', 'Dismiss a received all-staff message for the current principal.', { bodyFields: ['message_id'] })
add('sales', 'sales.ec.summary', 'GET', '/api/home/ec-sales', 'Read the EC sales summary currently shown on the TSG home screen.')
add('notifications', 'notifications.center.list', 'GET', '/api/notifications/center', 'Read the current principal’s notification feed or summary.', { queryFields: ['summary'] })
add('notifications', 'notifications.center.read', 'POST', '/api/notifications/center', 'Mark notification feed entries through a specified time as read.', { bodyFields: ['read_through'] })
add('notifications', 'notifications.posts.list', 'GET', '/api/notifications/posts', 'Read notification settings for specified authorized posts.', { queryFields: ['post_ids'] })
add('notifications', 'notifications.posts.update', 'POST', '/api/notifications/posts', 'Set the current principal’s post-notification mute setting.', { bodyFields: ['post_id', 'muted'] })
add('notifications', 'notifications.groups.list', 'GET', '/api/notifications/settings', 'Read the current principal’s group-notification settings.', { queryFields: ['group_id'] })
add('notifications', 'notifications.groups.update', 'POST', '/api/notifications/settings', 'Set the current principal’s group-notification mute setting.', { bodyFields: ['group_id', 'muted'] })
add('notifications', 'notifications.unread', 'GET', '/api/unread', 'Read unread counts for the current principal.')
add('notifications', 'notifications.unread.clear', 'POST', '/api/unread/clear', 'Mark the current principal’s visible groups as read.')
add('sos', 'sos.list', 'GET', '/api/sos', 'Read SOS alerts, delivery outcomes and manager registration counts; push endpoint keys are not returned.', { queryFields: ['active'] })
add('sos', 'sos.update', 'POST', '/api/sos', 'Acknowledge or resolve a specified SOS. Background heartbeat and device triggering are excluded.', { bodyFields: ['action', 'id'], actions: ['acknowledge', 'resolve'] })
add('files', 'files.upload', 'POST', '/api/upload', 'Upload a file through the existing TSG Drive uploader and receive its attachment metadata.', { bodyMode: 'multipart', fileFields: ['file'] })

export const BUSINESS_OPERATIONS: readonly BusinessOperation[] = Object.freeze(operations.map(operation => Object.freeze(operation)))
const byId = new Map(BUSINESS_OPERATIONS.map(operation => [operation.id, operation]))

export function getBusinessOperation(id: string) {
  return byId.get(id)
}

export function listBusinessOperations() {
  return BUSINESS_OPERATIONS.map(operation => ({ ...operation }))
}
