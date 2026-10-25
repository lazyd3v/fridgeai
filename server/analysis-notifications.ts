import type { Store, Item } from './store.ts';

export function publishAnalysisNotifications(store: Store, notify: (id: string, text: string, recordingId?: string) => void) {
  for (const event of store.analysisNotifications()) {
    const recording = store.recording(event.recordingId);
    const changes = store.recordingLog(event.recordingId, event.logThrough).flatMap(row => {
      // A batch split also logs the removed physical package; report it only once.
      if (row.reason === 'One unit taken from batch') return [];
      const before: Item | null = row.beforeJson ? JSON.parse(String(row.beforeJson)) : null;
      const after: Item | null = row.afterJson ? JSON.parse(String(row.afterJson)) : null;
      const present = (item: Item | null) => item && (!item.freshness || item.freshness.state === 'in_fridge') ? item.quantity : 0;
      const delta = present(after) - present(before);
      const name = (after ?? before)!.name.replace(/[\r\n]/g, ' ');
      return [delta > 0 ? `Added ${delta} × ${name}.` : delta < 0 ? `Removed ${-delta} × ${name}.` : `Updated ${name}.`];
    });
    const heading = event.status === 'completed' ? 'I analyzed the door recording.' : event.status === 'incomplete' ? 'The door recording was incomplete.' : 'I couldn’t finish analyzing the door recording.';
    const result = changes.length ? `Saved changes:\n${changes.map(line => `- ${line}`).join('\n')}` : event.status === 'completed' ? 'No inventory changes were made.' : 'No inventory changes were saved for this recording.';
    const warning = event.status === 'completed' ? '' : '\n\nPlease check the inventory; the recording may need review.';
    notify(`door-${event.id}`, `${heading}${recording ? ` (${recording.createdAt})` : ''}\n\n${result}${warning}\n\nIf I got anything wrong, reply here with the correct product or quantity and I’ll update the inventory.`, event.recordingId);
    store.acknowledgeAnalysis(event.id);
  }
}
