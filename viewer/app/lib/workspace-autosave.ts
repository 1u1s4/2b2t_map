export const WORKSPACE_AUTOSAVE_DELAY_MS = 300;

export interface WorkspaceAutosaveTimerRef<TimerHandle> {
  current: TimerHandle | null;
}

export type WorkspaceAutosaveSetTimeout<TimerHandle> = (
  callback: () => void,
  delayMs: number,
) => TimerHandle;

export type WorkspaceAutosaveClearTimeout<TimerHandle> = (
  timer: TimerHandle,
) => void;

/**
 * Schedules one save from the first dirty change in a burst.
 *
 * Later changes reuse the pending timer instead of postponing it, which puts a
 * hard upper bound on how long continuously changing workspace state remains
 * only in memory.
 */
export function scheduleWorkspaceAutosave<TimerHandle>(
  timerRef: WorkspaceAutosaveTimerRef<TimerHandle>,
  save: () => void,
  setTimer: WorkspaceAutosaveSetTimeout<TimerHandle>,
  delayMs = WORKSPACE_AUTOSAVE_DELAY_MS,
): boolean {
  if (timerRef.current !== null) return false;

  timerRef.current = setTimer(() => {
    timerRef.current = null;
    save();
  }, delayMs);
  return true;
}

/**
 * Cancels the pending save during teardown. Normal state changes should call
 * scheduleWorkspaceAutosave again and leave an existing timer untouched.
 */
export function cancelWorkspaceAutosave<TimerHandle>(
  timerRef: WorkspaceAutosaveTimerRef<TimerHandle>,
  clearTimer: WorkspaceAutosaveClearTimeout<TimerHandle>,
): boolean {
  const timer = timerRef.current;
  if (timer === null) return false;

  clearTimer(timer);
  timerRef.current = null;
  return true;
}
