# ProcureGuard — 2-minute demo script

Pre-flight: start the server (Setup A or B in the README), then click **Reset demo**. Use a browser window at 1366px or wider; keep the TideCloak console open in a second tab (mode B).

| Time | Screen | Action | Voice-over |
|---|---|---|---|
| 0:00 | Dashboard | — | "AI agents can automate procurement, but an agent that can spend money is a new god mode." |
| 0:15 | Dashboard | **Run AI agents** | "Three agents, each a TideCloak identity. Four routine orders, all within policy, executed with no human." |
| 0:35 | Dashboard | **Poison supplier data: ON** → **Run AI agents** | "A supplier hides an instruction in its price note. The agent obeys it: 2,000 bags from an unapproved supplier. The server blocks it, because the LLM is never the authority." |
| 0:55 | PO card | Open **Details** on the blocked card | "Every rule is checked on every call; the AI rationale is shown but marked untrusted." |
| 1:05 | Dashboard | **Hijacked agent: direct API call (80M)** | "Now someone steals the agent's token and calls the API directly. The order doesn't execute: it waits for a quorum." |
| 1:20 | TideCloak console | Change requests → approve `GRANT_ROLES` (mode A: **Simulate quorum approval**) | "Only a TideCloak change request can raise the agent's authority. Our own server can open the request but cannot approve it." |
| 1:35 | Dashboard | Card moves to Auto-executed | "The agent gets a fresh Tide-signed token, and the order executes once." |
| 1:45 | Audit | — | "Every step is in a hash-chained log. Autonomy for routine work; enforceable limits for everything else." |
