import assert from "node:assert/strict";
import test from "node:test";

import {
  createExplorationState,
  serializeExplorationState,
  withCellReviewed,
  withCellSkipped,
  withCurrentIndex,
} from "../app/lib/exploration-grid.ts";
import { resolveExplorationSelection } from "../app/lib/exploration-session-selection.ts";

const TARGET = {
  dimension: "overworld",
  lod: 0,
  bounds: {
    minX: -1024,
    minZ: 2048,
    maxXExclusive: 1024,
    maxZExclusive: 3072,
  },
};

function stateFor({
  id = "persisted-region",
  lod = TARGET.lod,
  bounds = TARGET.bounds,
} = {}) {
  return createExplorationState({
    id,
    name: "Región persistida",
    bounds,
    lod,
    scale: 1 / 2 ** lod,
  });
}

function persistedSession(state) {
  return {
    id: state.region.id,
    state: JSON.parse(serializeExplorationState(state)),
  };
}

test("an exact selection rehydrates the persisted session without losing progress", () => {
  let persisted = stateFor();
  persisted = withCurrentIndex(persisted, 5);
  persisted = withCellReviewed(persisted, 0);
  persisted = withCellReviewed(persisted, 5);
  persisted = withCellSkipped(persisted, 3);
  const serialized = serializeExplorationState(persisted);
  let factoryCalls = 0;

  const resolution = resolveExplorationSelection(
    [persistedSession(persisted)],
    TARGET,
    () => {
      factoryCalls += 1;
      return stateFor({ id: "new-region" });
    },
  );

  assert.equal(resolution.resumed, true);
  assert.equal(factoryCalls, 0);
  assert.equal(resolution.state.region.id, "persisted-region");
  assert.equal(resolution.state.currentIndex, 5);
  assert.equal(serializeExplorationState(resolution.state), serialized);
});

test("dimension, LOD, and every half-open endpoint are exact-match criteria", () => {
  const matching = persistedSession(stateFor());
  const mismatches = [
    {
      ...matching,
      state: { ...matching.state, dimension: "nether" },
    },
    persistedSession(stateFor({ lod: 1 })),
    ...[
      "minX",
      "minZ",
      "maxXExclusive",
      "maxZExclusive",
    ].map((endpoint) =>
      persistedSession(
        stateFor({
          bounds: {
            ...TARGET.bounds,
            [endpoint]: TARGET.bounds[endpoint] + 512,
          },
        }),
      ),
    ),
  ];

  for (const session of mismatches) {
    let factoryCalls = 0;
    const created = stateFor({ id: `created-${factoryCalls}` });
    const resolution = resolveExplorationSelection(
      [session],
      TARGET,
      (target) => {
        factoryCalls += 1;
        assert.deepEqual(target, TARGET);
        return created;
      },
    );

    assert.equal(resolution.resumed, false);
    assert.equal(resolution.state, created);
    assert.equal(factoryCalls, 1);
  }
});

test("adjacent and overlapping sessions do not replace a new exact selection", () => {
  const adjacent = persistedSession(
    stateFor({
      id: "adjacent",
      bounds: {
        minX: TARGET.bounds.maxXExclusive,
        minZ: TARGET.bounds.minZ,
        maxXExclusive:
          TARGET.bounds.maxXExclusive +
          (TARGET.bounds.maxXExclusive - TARGET.bounds.minX),
        maxZExclusive: TARGET.bounds.maxZExclusive,
      },
    }),
  );
  const overlapping = persistedSession(
    stateFor({
      id: "overlapping",
      bounds: {
        minX: TARGET.bounds.minX + 512,
        minZ: TARGET.bounds.minZ,
        maxXExclusive: TARGET.bounds.maxXExclusive + 512,
        maxZExclusive: TARGET.bounds.maxZExclusive,
      },
    }),
  );
  const created = stateFor({ id: "new-exact-region" });

  const resolution = resolveExplorationSelection(
    [adjacent, overlapping],
    TARGET,
    () => created,
  );

  assert.equal(resolution.resumed, false);
  assert.equal(resolution.state, created);
});

test("the first exact session is selected without invoking the factory", () => {
  const first = stateFor({ id: "first-exact" });
  const second = stateFor({ id: "second-exact" });
  const resolution = resolveExplorationSelection(
    [persistedSession(first), persistedSession(second)],
    TARGET,
    () => stateFor({ id: "unused" }),
  );

  assert.equal(resolution.resumed, true);
  assert.equal(resolution.state.region.id, "first-exact");
});

test("an inconsistent persisted wrapper ID is rejected instead of losing progress", () => {
  const session = persistedSession(stateFor());
  assert.throws(
    () =>
      resolveExplorationSelection(
        [{ ...session, id: "different-wrapper-id" }],
        TARGET,
        () => stateFor({ id: "unused" }),
      ),
    /identificador de la sesión persistida/,
  );
});
