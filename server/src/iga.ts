// STUB — replaced by track A on merge. Matches the seam in docs/CONTRACTS.md "Module seams".
import type { Hono } from 'hono';
import type { ChangeRequest } from '../../shared/types.ts';

export type IgaErrorCode = 'FORBIDDEN' | 'CONFLICT' | 'QUORUM_NOT_MET' | 'ENTITY_VANISHED' | 'UNEXPECTED';

export class IgaError extends Error {
  constructor(public code: IgaErrorCode, public status: number, message?: string) {
    super(message ?? code);
    this.name = 'IgaError';
  }
}

let seq = 0;
export async function revokeRole(_sub: string, _role: string): Promise<{ change_request_id: string }> {
  return { change_request_id: `stub-cr-${++seq}` };
}

export async function listChangeRequests(_status?: string): Promise<ChangeRequest[]> {
  return [];
}

export function registerIgaRoutes(_app: Hono<any>): void {}
