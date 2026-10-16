import { useEffect, useState } from "react";
import {
  listOwnerInstructions,
  removeOwnerInstruction,
  replaceOwnerInstruction,
  type PersistentMemoryRow,
} from "../../lib/carson-persistent-memory";

export default function CarsonLearningPanel({ userId, onBack }: {
  userId: string | null;
  onBack: () => void;
}) {
  const [rows, setRows] = useState<PersistentMemoryRow[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    setRows([]);
    setEditing(null);
    setMessage("");
    if (userId) {
      setBusy(true);
      listOwnerInstructions().then(rows => { if (active) setRows(rows); })
        .catch(() => { if (active) setMessage("Couldn't load your instructions. Try reopening this panel."); })
        .finally(() => { if (active) setBusy(false); });
    }
    return () => { active = false; };
  }, [userId]);

  async function change(row: PersistentMemoryRow, remove: boolean) {
    if (busy || !userId) return;
    setBusy(true);
    setMessage("");
    try {
      if (remove) await removeOwnerInstruction(row.id);
      else await replaceOwnerInstruction(row.id, text);
      setEditing(null);
      const success = remove ? "Instruction removed." : "Correction saved for your next conversation.";
      try { setRows(await listOwnerInstructions()); setMessage(success); }
      catch { setMessage(`${success} Couldn't refresh the list; reopen this panel to review it.`); }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Couldn't save that change.");
    } finally { setBusy(false); }
  }

  return <section className="min-w-0 space-y-4 break-words text-ink" aria-label="Carson instructions">
    <button className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm" type="button" disabled={busy} onClick={onBack}>Back to Settings</button>
    <h2 className="text-lg font-semibold">What Carson remembers</h2>
    <p>Standing instructions you have taught Carson. To add one, tell Carson “Remember: …” by voice or text.</p>
    <p>This list covers standing instructions. People notes and other conversation memories are managed separately.</p>
    {!userId && <p>Sign in to review your instructions.</p>}
    {busy && <p role="status">Loading or saving…</p>}
    {message && <p role="status">{message}</p>}
    {userId && !busy && !message && rows.length === 0 && <p>No standing instructions saved yet.</p>}
    <ul className="space-y-4">{rows.map(row => <li key={row.id} className="min-w-0 space-y-2 rounded-xl border border-border p-3 [overflow-wrap:anywhere]">
      <p>{row.instruction}</p>
      {row.conflicted && <p role="alert">Conflicting versions — Carson will not apply this rule until you resolve it.</p>}
      {row.removalPending && <p role="alert">Carson has stopped using this rule. Retry removal to clear the stored text.</p>}
      <p className="text-sm">Owner instruction · Last confirmed {new Date(row.confirmed_at).toLocaleDateString()}</p>
      {editing === row.id ? <form onSubmit={event => { event.preventDefault(); void change(row, false); }}>
        <label className="block">Correct this instruction
          <textarea value={text} disabled={busy} onChange={event => setText(event.target.value)} className="block min-h-28 w-full min-w-0 rounded border border-border bg-cream p-2 text-base text-ink" />
        </label>
        <button className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm" type="submit" disabled={busy || !text.trim()}>Save correction</button>{" "}
        <button className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm" type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
      </form> : <>
        {row.category.startsWith("owner_rule:") && <button className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm" type="button" disabled={busy} onClick={() => { setEditing(row.id); setText(row.instruction); }}>{row.conflicted ? "Resolve conflict" : "Correct"}</button>}{" "}
        <button className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm" type="button" disabled={busy} onClick={() => void change(row, true)}>Remove instruction</button>
        {!row.category.startsWith("owner_rule:") && <p className="text-sm">To correct this older instruction, remove it, then teach Carson the replacement.</p>}
      </>}
    </li>)}</ul>
  </section>;
}
