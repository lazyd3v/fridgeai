// Optional observation evidence for isolated audits; never sent downstream.
import { z } from 'zod';
import { doorEventsSchema } from '../server/door-normalize.ts';

export const diagnosticEventsSchema = z.object({ events: z.array(
  doorEventsSchema.shape.events.element.extend({
    notes: z.string().trim().max(2000).nullable(),
  }).strict(),
).max(300) }).strict();

export const diagnosticPrompt = `

## Audit output extension
For this run, each event has exactly product, action, expirationDate, and notes.
notes is a concise string describing readable labels, packaging, size, color, contents, location, or identification uncertainty, or null when there is nothing useful to add.
Use the same descriptive style as an initial inventory scan. Do not guess hidden contents, quantities, or unreadable labels. Use generic product names for unidentified containers and explain uncertainty in notes. Indicate when a detail comes from speech.
Use inventory notes as matching context, but write notes supported by this recording rather than copying unverified details. Notes are product observations, not an explanation of your reasoning. Do not include pickupTimestamp, releaseTimestamp, origin, or destination fields.`;

export function parseDiagnosticEvents(raw: string) {
  const diagnostics = diagnosticEventsSchema.parse(JSON.parse(raw));
  const observed = doorEventsSchema.parse({ events: diagnostics.events.map(
    ({ product, action, expirationDate }) => ({ product, action, expirationDate }),
  ) });
  return { diagnostics, observed };
}
