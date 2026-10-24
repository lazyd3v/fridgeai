import { z } from 'zod';
import { validDate } from './freshness.ts';

export const productDateSchema = z.object({
  id: z.string().uuid().describe('Package ID from inventory or package history. Never guess an ID.'),
  field: z.enum(['expirationDate', 'openedAt']).describe('Which date to change; the other date is preserved.'),
  date: z.string().refine(validDate, 'Use a valid calendar date in YYYY-MM-DD format.').nullable().describe('Absolute date in YYYY-MM-DD format, or null to explicitly clear this date.'),
}).strict();
export const productDateDescription = 'Set or clear one package expiration or opening date only when the user requests it. Read inventory/history first to identify the package; clarify ambiguous products. Use an absolute YYYY-MM-DD date, or null to clear the selected field. Preserves other fields and records the correction in history. Works for in-fridge, taken-out, and finished packages.';
