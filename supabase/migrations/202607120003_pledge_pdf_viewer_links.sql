update public.gw_pledge_assignments
set signed_attachment = signed_attachment || jsonb_build_object(
  'url', '/pledges/pdf/' || id::text,
  'viewUrl', '/pledges/pdf/' || id::text
)
where status = 'submitted'
  and signed_attachment is not null;

update public.gw_posts posts
set attachments = (
  select coalesce(jsonb_agg(
    case
      when item->>'driveId' = assignments.signed_attachment->>'driveId'
        or item->>'url' like '/api/pledges/pdf?assignment_id=%'
      then item || jsonb_build_object(
        'url', '/pledges/pdf/' || assignments.id::text,
        'viewUrl', '/pledges/pdf/' || assignments.id::text
      )
      else item
    end
  ), '[]'::jsonb)
  from jsonb_array_elements(coalesce(posts.attachments, '[]'::jsonb)) item
)
from public.gw_pledge_assignments assignments
where posts.id = assignments.dm_post_id
  and assignments.status = 'submitted';
