import { z } from 'zod';
import { type Actor } from '../auth';
import { rows, type DB } from '../db';
import { requireCondition } from '../errors';

/**
 * Internal Syndicate roles (SRS §3). A NULL role set means every role: operators created before roles existed and the
 * seeded super administrator keep working until the super administrator assigns roles. Holding a role never waives a
 * two-person rule; the maker-checker checks still compare the people involved.
 */
export const OPS_ROLES = ['relationship_manager', 'compliance_officer', 'credit_risk_officer', 'operations_analyst', 'treasury', 'platform_admin'] as const;
export type OpsRole = typeof OPS_ROLES[number];
export const OPS_ROLE_LABEL: Record<OpsRole, string> = {
  relationship_manager: 'Relationship manager', compliance_officer: 'Compliance / KYC officer', credit_risk_officer: 'Credit & risk officer',
  operations_analyst: 'Operations analyst', treasury: 'Finance / treasury', platform_admin: 'Platform administrator',
};

export async function opsRoles(actor: Actor, db?: DB): Promise<OpsRole[] | null> {
  if (actor.role !== 'platform_ops' || actor.delegation) return [];
  const [user] = await rows('SELECT ops_roles FROM users WHERE id=$1', [actor.id], db);
  return (user?.ops_roles ?? null) as OpsRole[] | null;
}
export async function hasOpsRole(actor: Actor, role: OpsRole, db?: DB) {
  if (actor.role !== 'platform_ops' || actor.delegation) return false;
  const roles = await opsRoles(actor, db);
  return roles === null || roles.includes(role);
}
export async function requireOpsRole(actor: Actor, role: OpsRole, db?: DB) {
  requireCondition(actor.role === 'platform_ops' && !actor.delegation, 403, 'This is performed by INVOX operations');
  requireCondition(await hasOpsRole(actor, role, db), 403, `This step needs the ${OPS_ROLE_LABEL[role].toLowerCase()} role`);
}
export const opsRolesInput = z.object({ roles: z.array(z.enum(OPS_ROLES)).max(OPS_ROLES.length).nullable() });
