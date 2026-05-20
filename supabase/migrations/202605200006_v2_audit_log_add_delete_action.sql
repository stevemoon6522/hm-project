-- audit_log.action CHECK was missing 'delete' — delete_master_product RPC
-- (introduced 2026-05-20) needs it. Applied live via MCP.

alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log add constraint audit_log_action_check
  check (action = ANY (ARRAY[
    'create','update','approve','reject','publish','rollback','sync','alert_sent','delete'
  ]));
