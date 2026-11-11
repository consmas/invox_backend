-- A stable identifier keeps relationships with the same supplier in different
-- buyer organisations independently addressable in the operations workspace.
ALTER TABLE portal_supplier_relationships ADD COLUMN id bigserial UNIQUE;
