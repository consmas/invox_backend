import { rows, type DB, type Row } from '../db';

/**
 * The compliance checklist is configuration (SRS A2.1, FR-JNY-A-003, FR-JNY-F-004, FR-JNY-S-004): resolved by
 * counterparty, jurisdiction, entity type and — for suppliers — diligence tier. For each item the most specific row
 * wins (this country before the default, this entity type before any); items configured as not applying to an entity
 * type are excluded explicitly, never by code.
 */
export const ENTITY_TYPES: Record<'ANCHOR' | 'FUNDER' | 'SUPPLIER', string[]> = {
  ANCHOR: ['limited_company', 'public_company', 'partnership', 'state_owned', 'other'],
  FUNDER: ['bank', 'non_bank_financial', 'fund', 'other'],
  SUPPLIER: ['limited_company', 'partnership', 'sole_proprietor', 'other'],
};
export async function checklistItems(counterparty: string, country: string, entityType: string, tier: string, db?: DB): Promise<Row[]> {
  const items = await rows(`SELECT DISTINCT ON (item_key) * FROM compliance_checklist_items
    WHERE counterparty=$1 AND tier=$2 AND country IN ($3,'*') AND entity_type IN ($4,'*')
      AND item_key NOT IN (SELECT item_key FROM compliance_checklist_exclusions WHERE counterparty=$1 AND entity_type=$4)
    ORDER BY item_key, (country='*'), (entity_type='*'), sort`, [counterparty, tier, String(country || '*').toUpperCase(), entityType], db);
  return items.sort((a, b) => a.sort - b.sort);
}
