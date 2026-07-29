import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelWorkspaceAutosave,
  scheduleWorkspaceAutosave,
} from "../app/lib/workspace-autosave.ts";

class FakeClock {
  #nextId = 1;
  #now = 0;
  #timers = new Map();

  setTimeout = (callback, delayMs) => {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#timers.set(id, {
      callback,
      dueAt: this.#now + delayMs,
    });
    return id;
  };

  clearTimeout = (id) => {
    this.#timers.delete(id);
  };

  get pendingCount() {
    return this.#timers.size;
  }

  advanceBy(milliseconds) {
    const target = this.#now + milliseconds;

    while (true) {
      const pending = [...this.#timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort(
          ([firstId, first], [secondId, second]) =>
            first.dueAt - second.dueAt || firstId - secondId,
        )[0];
      if (!pending) break;

      const [id, timer] = pending;
      this.#timers.delete(id);
      this.#now = timer.dueAt;
      timer.callback();
    }

    this.#now = target;
  }
}

test("a continuous burst keeps the first deadline and saves at 300 ms", () => {
  const clock = new FakeClock();
  const timerRef = { current: null };
  let saveCount = 0;
  const schedule = () =>
    scheduleWorkspaceAutosave(
      timerRef,
      () => {
        saveCount += 1;
      },
      clock.setTimeout,
    );

  assert.equal(schedule(), true);
  assert.equal(clock.pendingCount, 1);

  clock.advanceBy(100);
  assert.equal(schedule(), false);
  clock.advanceBy(100);
  assert.equal(schedule(), false);
  clock.advanceBy(99);
  assert.equal(schedule(), false);

  assert.equal(saveCount, 0);
  assert.equal(clock.pendingCount, 1);

  clock.advanceBy(1);
  assert.equal(saveCount, 1);
  assert.equal(clock.pendingCount, 0);
  assert.equal(timerRef.current, null);
});

test("a new change can schedule another save after the timer fires", () => {
  const clock = new FakeClock();
  const timerRef = { current: null };
  let saveCount = 0;
  const schedule = () =>
    scheduleWorkspaceAutosave(
      timerRef,
      () => {
        saveCount += 1;
      },
      clock.setTimeout,
    );

  assert.equal(schedule(), true);
  clock.advanceBy(300);
  assert.equal(saveCount, 1);

  assert.equal(schedule(), true);
  assert.equal(clock.pendingCount, 1);
  clock.advanceBy(300);
  assert.equal(saveCount, 2);
});

test("explicit cancellation prevents the pending save", () => {
  const clock = new FakeClock();
  const timerRef = { current: null };
  let saveCount = 0;

  scheduleWorkspaceAutosave(
    timerRef,
    () => {
      saveCount += 1;
    },
    clock.setTimeout,
  );

  assert.equal(
    cancelWorkspaceAutosave(timerRef, clock.clearTimeout),
    true,
  );
  assert.equal(timerRef.current, null);
  assert.equal(clock.pendingCount, 0);
  assert.equal(
    cancelWorkspaceAutosave(timerRef, clock.clearTimeout),
    false,
  );

  clock.advanceBy(300);
  assert.equal(saveCount, 0);
});
