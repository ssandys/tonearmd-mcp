// The daemon keeps one BrowseSession per session key and never evicts one
// (tonearm's FOLLOWUPS item 9), and offers no verb to drop one. So the key
// space is bounded here instead: at most SLOT_COUNT keys are ever sent, no
// matter how many MCP sessions come and go. Exceeding the pool makes two
// sessions share a cursor -- which is exactly today's single-key behaviour,
// not corruption.
export const SLOT_COUNT = 8;

export function createSlots(n = SLOT_COUNT) {
  const slots = Array.from({ length: n }, (_, i) => ({ key: `mcp-${i}`, id: null, used: 0 }));
  let tick = 0;

  return {
    claim(id) {
      let slot = slots.find((s) => s.id === id);
      if (!slot) {
        slot = slots.find((s) => s.id === null)
            ?? slots.reduce((a, b) => (a.used <= b.used ? a : b));
        slot.id = id;
      }
      slot.used = ++tick;
      return slot.key;
    },
    release(id) {
      const slot = slots.find((s) => s.id === id);
      if (slot) slot.id = null;
    },
  };
}
