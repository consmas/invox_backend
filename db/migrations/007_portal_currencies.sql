-- Connect the five two-decimal currencies present in the supplied portal UI.
-- Currency conversion is deliberately not introduced; positions retain their own currency.
DO $$
DECLARE constraint_row record; definition text; revised text;
BEGIN
 FOR constraint_row IN SELECT c.oid,c.conname,c.conrelid::regclass AS relation
 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
 WHERE n.nspname=current_schema() AND c.contype='c'
 LOOP
  definition=pg_get_constraintdef(constraint_row.oid);
  IF definition NOT LIKE '%GHS%' OR definition NOT LIKE '%USD%' OR definition NOT LIKE '%EUR%' THEN CONTINUE; END IF;
  revised=replace(definition,'''EUR''::character varying','''EUR''::character varying, ''NGN''::character varying, ''KES''::character varying');
  revised=replace(revised,'''EUR''::text','''EUR''::text, ''NGN''::text, ''KES''::text');
  IF revised<>definition THEN
   EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',constraint_row.relation,constraint_row.conname);
   EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',constraint_row.relation,constraint_row.conname,revised);
  END IF;
 END LOOP;
END $$;
