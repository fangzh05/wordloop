-- Enable the additional mode without changing budget settings, evidence, or FSRS.
alter table public.learning_settings drop constraint learning_settings_bkt_mode_check;
alter table public.learning_settings add constraint learning_settings_bkt_mode_check
  check (bkt_mode in ('off','shadow','active'));

-- Fresh rows retain the shadow default. Activate a learner explicitly after deployment.
