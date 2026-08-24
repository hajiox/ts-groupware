update public.gw_shift_requirements as requirement
set
  notes2 = case
    when nullif(btrim(coalesce(requirement.notes2, '')), '') is null
      then btrim(requirement.notes)
    when btrim(requirement.notes2) = btrim(requirement.notes)
      then requirement.notes2
    else btrim(requirement.notes2) || E'\n' || btrim(requirement.notes)
  end,
  notes = null,
  updated_at = now()
from public.gw_shift_periods as period
where
  period.id = requirement.period_id
  and period.department in ('フロア', '製造')
  and nullif(btrim(coalesce(requirement.notes, '')), '') is not null;
