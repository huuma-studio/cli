/** Upper bound on model calls per agent run, in calls — applied to every agent
 * the CLI builds (local, managed, and preset sub-agents) via @huuma/ai's
 * `maxModelCalls`. The library's own default (100) hard-stops large tasks with
 * `Agent run exceeded maxModelCalls (100) without finishing`, so the CLI bakes
 * in a generous cap instead of inheriting it. Set `maxModelCalls` on a run (via
 * `RunOptions`) to lower it, or `Infinity` to disable the cap. */
export const MAX_MODEL_CALLS = 1000;
