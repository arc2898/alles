'use strict';

/**
 * Small connectors between the app's parts. Each takes its collaborators as arguments (no Electron, no
 * globals), so the SAME code runs in the real app and in its tests.
 */

/**
 * Approval broker <-> island.
 *  - a question appears  -> the island shows it and the pill says "Needs your approval"
 *  - it is answered      -> the question is cleared and the pill returns to what the agent is doing
 *    (otherwise it would keep saying "Needs your approval" while the approved command runs)
 * Synthetic statuses are marked `replay`, so the page refreshes its label WITHOUT logging the action a
 * second time (the agent already announced it before asking).
 * @returns {{answer:(a:{id:string,allow:boolean})=>boolean}}  feed the page's 'approval-answer' into this
 */
function wireApprovals({ broker, dock, dockActive = () => true }) {
  // `dockActive` = is the pill's own task the one asking? A question that comes from the workspace window's coding area is shown
  // THERE, not on the island, and must not make the pill say "Needs your approval" for a task it is not running.
  const shown = new Set();
  broker.on('request', (q) => {
    if (!dockActive()) return;
    shown.add(q.id);
    dock.showApproval(q);
    dock.setStatus({ state: 'waiting', detail: q.title });
  });
  broker.on('resolved', (r) => {
    if (!shown.delete(r.id)) return;
    dock.showApproval(null);
    dock.setStatus(r.allow ? { state: 'acting', detail: r.tool, replay: true } : { state: 'thinking', detail: '', replay: true });
  });
  return { answer: (a) => broker.respond(a && a.id, a && a.allow) };
}

/**
 * Approval broker <-> workspace window: the same questions, shown in the window's own card. Both places may be able to answer
 * (the broker accepts the first answer and ignores the second); a question answered in one place is withdrawn from the other.
 */
function wireWorkspaceApprovals({ broker, workspace }) {
  broker.on('request', (q) => workspace.send({ type: 'approval', question: q }));
  broker.on('resolved', (r) => workspace.send({ type: 'approval-gone', id: r.id }));
}

module.exports = { wireApprovals, wireWorkspaceApprovals };
