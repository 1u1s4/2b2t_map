import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_EXACT_HIGHLIGHT_ROUTE_LIMIT,
  HIGHLIGHT_ROUTE_EXPORT_VERSION,
  createHighlightRouteExport,
  highlightRouteLabel,
  highlightRouteWaypointTitle,
  planHighlightRoute,
} from "../app/lib/highlight-route.ts";

const bounds = {
  minX: 0,
  minZ: 0,
  maxXExclusive: 100,
  maxZExclusive: 100,
};

function distance(left, right) {
  return Math.hypot(right.x - left.x, right.z - left.z);
}

function pathDistance(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1], points[index]);
  }
  return total;
}

function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    permutations([
      ...values.slice(0, index),
      ...values.slice(index + 1),
    ]).map((tail) => [value, ...tail]),
  );
}

test("empty and singleton routes expose a labeled overlay safely", () => {
  const empty = planHighlightRoute([], bounds);
  assert.equal(empty.algorithm, "exact-held-karp");
  assert.equal(empty.optimal, true);
  assert.equal(empty.startHighlightId, null);
  assert.equal(empty.startMode, "top-left");
  assert.equal(empty.totalDistance, 0);
  assert.deepEqual(empty.stops, []);
  assert.deepEqual(empty.overlay, { markers: [], segments: [] });

  const highlight = {
    id: "only",
    title: "Único",
    x: 42,
    z: 17,
  };
  const singleton = planHighlightRoute([highlight], bounds);
  assert.equal(singleton.startHighlightId, "only");
  assert.equal(singleton.startMode, "top-left");
  assert.equal(singleton.totalDistance, 0);
  assert.deepEqual(singleton.overlay.markers, [
    {
      highlightId: "only",
      order: 1,
      label: "A",
      x: 42,
      z: 17,
    },
  ]);
  assert.deepEqual(singleton.overlay.segments, []);
});

test("route labels progress through uppercase, lowercase, then suffixed cycles", () => {
  assert.deepEqual(
    [1, 26, 27, 52, 53, 54, 79, 104, 105].map(highlightRouteLabel),
    ["A", "Z", "a", "z", "A1", "B1", "a1", "z1", "A2"],
  );
  assert.throws(() => highlightRouteLabel(0), /positive integer/);
});

test("route waypoint titles replace old labels and stay workspace-safe", () => {
  assert.equal(
    highlightRouteWaypointTitle(1, "Portal norte"),
    "A · Portal norte",
  );
  assert.equal(
    highlightRouteWaypointTitle(2, "A · Portal norte"),
    "B · Portal norte",
  );
  assert.equal(
    highlightRouteWaypointTitle(53, "z9 · Base D"),
    "A1 · Base D",
  );
  assert.equal(
    highlightRouteWaypointTitle(1, "A · Portal norte"),
    highlightRouteWaypointTitle(
      1,
      highlightRouteWaypointTitle(1, "Portal norte"),
    ),
  );

  const longTitle = highlightRouteWaypointTitle(
    10_000,
    `Base ${"😀".repeat(200)}`,
  );
  assert.equal(longTitle.length <= 200, true);
  assert.doesNotMatch(longTitle, /[\uD800-\uDBFF]$/u);
});

test("the route starts nearest minX/minZ with canonical distance ties", () => {
  const points = [
    { id: "east-up", x: 5, z: 1 },
    { id: "west-down", x: 1, z: 5 },
    { id: "far", x: 80, z: 80 },
  ];

  const plan = planHighlightRoute(points, bounds);
  const permuted = planHighlightRoute([...points].reverse(), bounds);

  assert.deepEqual(plan.startCorner, { x: 0, z: 0 });
  assert.equal(plan.startHighlightId, "west-down");
  assert.deepEqual(
    plan.stops.map((stop) => stop.highlight.id),
    permuted.stops.map((stop) => stop.highlight.id),
  );
});

test("a selected highlight replaces the automatic start deterministically", () => {
  const points = [
    { id: "a", x: 1, z: 1 },
    { id: "b", x: 9, z: 1 },
    { id: "c", x: 1, z: 9 },
    { id: "d", x: 9, z: 9 },
  ];
  const selected = planHighlightRoute(points, bounds, {
    startHighlightId: "d",
  });
  const permuted = planHighlightRoute(
    [points[2], points[0], points[3], points[1]],
    bounds,
    { startHighlightId: "d" },
  );
  const automatic = planHighlightRoute(points, bounds, {
    startHighlightId: null,
  });

  assert.equal(selected.startMode, "selected");
  assert.equal(selected.startHighlightId, "d");
  assert.equal(selected.stops[0].highlight.id, "d");
  assert.equal(selected.algorithm, "exact-held-karp");
  assert.deepEqual(
    selected.stops.map((stop) => stop.highlight.id),
    permuted.stops.map((stop) => stop.highlight.id),
  );
  assert.equal(automatic.startMode, "top-left");
  assert.equal(automatic.startHighlightId, "a");
});

test("Held-Karp finds the globally shortest open path from the fixed start", () => {
  const points = [
    { id: "a", x: 76, z: 41 },
    { id: "b", x: 50, z: 94 },
    { id: "c", x: 1, z: 24 },
    { id: "d", x: 78, z: 26 },
    { id: "e", x: 69, z: 77 },
    { id: "f", x: 23, z: 66 },
  ];
  const plan = planHighlightRoute(points, bounds);
  const start = plan.stops[0].highlight;
  const remaining = points.filter((point) => point.id !== start.id);
  const bruteForceMinimum = Math.min(
    ...permutations(remaining).map((order) =>
      pathDistance([start, ...order]),
    ),
  );

  assert.equal(plan.algorithm, "exact-held-karp");
  assert.equal(plan.optimal, true);
  assert.ok(Math.abs(plan.totalDistance - bruteForceMinimum) < 1e-9);
  assert.equal(plan.stops.length, points.length);
  assert.equal(
    new Set(plan.stops.map((stop) => stop.highlight.id)).size,
    points.length,
  );
});

test("exact distance ties have the same route for every input order", () => {
  const square = [
    { id: "a", x: 1, z: 1 },
    { id: "b", x: 9, z: 1 },
    { id: "c", x: 1, z: 9 },
    { id: "d", x: 9, z: 9 },
  ];
  const expected = ["a", "b", "d", "c"];

  for (const points of [
    square,
    [...square].reverse(),
    [square[2], square[0], square[3], square[1]],
  ]) {
    const plan = planHighlightRoute(points, bounds);
    assert.deepEqual(
      plan.stops.map((stop) => stop.highlight.id),
      expected,
    );
    // This is an open path: it traverses three sides, not a closed square.
    assert.equal(plan.totalDistance, 24);
  }
});

test("large inputs switch to nearest-neighbor plus deterministic 2-opt", () => {
  const points = Array.from(
    { length: DEFAULT_EXACT_HIGHLIGHT_ROUTE_LIMIT + 1 },
    (_, index) => ({
      id: `point-${String(index).padStart(2, "0")}`,
      x: index * 4 + 1,
      z: 10,
    }),
  );
  const plan = planHighlightRoute([...points].reverse(), bounds);

  assert.equal(plan.algorithm, "nearest-neighbor-2-opt");
  assert.equal(plan.optimal, false);
  assert.equal(plan.startHighlightId, "point-00");
  assert.deepEqual(
    plan.stops.map((stop) => stop.highlight.id),
    points.map((point) => point.id),
  );
});

test("the heuristic also preserves a selected start across permutations", () => {
  const points = Array.from({ length: 40 }, (_, index) => ({
    id: `heuristic-${String(index).padStart(2, "0")}`,
    x: (index % 8) * 10 + 1,
    z: Math.floor(index / 8) * 10 + 1,
  }));
  const options = { startHighlightId: "heuristic-23" };
  const selected = planHighlightRoute(points, bounds, options);
  const permuted = planHighlightRoute([...points].reverse(), bounds, options);

  assert.equal(selected.algorithm, "nearest-neighbor-2-opt");
  assert.equal(selected.startMode, "selected");
  assert.equal(selected.startHighlightId, "heuristic-23");
  assert.equal(selected.stops[0].highlight.id, "heuristic-23");
  assert.deepEqual(
    selected.stops.map((stop) => stop.highlight.id),
    permuted.stops.map((stop) => stop.highlight.id),
  );
});

test("the adaptive large-route strategy retains every point", () => {
  const pointCount = 2_000;
  const points = Array.from({ length: pointCount }, (_, index) => ({
    id: `large-${String(index).padStart(4, "0")}`,
    x: (index % 50) * 100 + ((index * 17) % 13),
    z: Math.floor(index / 50) * 100 + ((index * 29) % 17),
  }));
  const plan = planHighlightRoute([...points].reverse(), {
    minX: 0,
    minZ: 0,
    maxXExclusive: 5_000,
    maxZExclusive: 4_000,
  });
  const visitedIds = plan.stops.map((stop) => stop.highlight.id);

  assert.equal(plan.algorithm, "nearest-neighbor-2-opt");
  assert.equal(plan.startHighlightId, "large-0000");
  assert.equal(plan.stops.length, pointCount);
  assert.equal(new Set(visitedIds).size, pointCount);
  assert.deepEqual(new Set(visitedIds), new Set(points.map(({ id }) => id)));
  assert.equal(plan.overlay.markers.length, pointCount);
  assert.equal(plan.overlay.segments.length, pointCount - 1);
  assert.equal(plan.stops.at(-1).order, pointCount);
});

test("2-opt improves the nearest-neighbor seed without moving the start", () => {
  const points = [
    { id: "a", x: 76, z: 41 },
    { id: "b", x: 50, z: 94 },
    { id: "c", x: 1, z: 24 },
    { id: "d", x: 78, z: 26 },
    { id: "e", x: 69, z: 77 },
  ];
  const nearestOnly = planHighlightRoute(points, bounds, {
    exactPointLimit: 0,
    twoOptMaxPasses: 0,
  });
  const improved = planHighlightRoute(points, bounds, {
    exactPointLimit: 0,
  });
  const permuted = planHighlightRoute(
    [points[3], points[0], points[4], points[2], points[1]],
    bounds,
    { exactPointLimit: 0 },
  );

  assert.deepEqual(
    nearestOnly.stops.map((stop) => stop.highlight.id),
    ["c", "a", "d", "e", "b"],
  );
  assert.deepEqual(
    improved.stops.map((stop) => stop.highlight.id),
    ["c", "d", "a", "e", "b"],
  );
  assert.ok(improved.totalDistance < nearestOnly.totalDistance);
  assert.equal(improved.startHighlightId, nearestOnly.startHighlightId);
  assert.equal(improved.twoOptPasses, 1);
  assert.deepEqual(
    improved.stops.map((stop) => stop.highlight.id),
    permuted.stops.map((stop) => stop.highlight.id),
  );
});

test("overlay segments and the JSON-safe export preserve visit numbering", () => {
  const points = [
    { id: "alpha", title: "Alpha", x: 5, z: 5 },
    { id: "beta", title: "Beta", x: 25, z: 5 },
    { id: "gamma", x: 25, z: 25 },
  ];
  const plan = planHighlightRoute(points, bounds);
  const exported = createHighlightRouteExport(plan);

  assert.deepEqual(
    plan.overlay.markers.map(({ highlightId, order, label }) => ({
      highlightId,
      order,
      label,
    })),
    [
      { highlightId: "alpha", order: 1, label: "A" },
      { highlightId: "beta", order: 2, label: "B" },
      { highlightId: "gamma", order: 3, label: "C" },
    ],
  );
  assert.deepEqual(
    plan.overlay.segments.map(
      ({ fromHighlightId, toHighlightId, fromOrder, toOrder }) => ({
        fromHighlightId,
        toHighlightId,
        fromOrder,
        toOrder,
      }),
    ),
    [
      {
        fromHighlightId: "alpha",
        toHighlightId: "beta",
        fromOrder: 1,
        toOrder: 2,
      },
      {
        fromHighlightId: "beta",
        toHighlightId: "gamma",
        fromOrder: 2,
        toOrder: 3,
      },
    ],
  );
  assert.equal(exported.version, HIGHLIGHT_ROUTE_EXPORT_VERSION);
  assert.equal(exported.kind, "obsidian-atlas-highlight-route");
  assert.equal(exported.startMode, "top-left");
  assert.equal(exported.points[0].title, "Alpha");
  assert.equal("title" in exported.points[2], false);
  assert.deepEqual(JSON.parse(JSON.stringify(exported)), exported);

  const selectedExport = createHighlightRouteExport(
    planHighlightRoute(points, bounds, { startHighlightId: "gamma" }),
  );
  assert.equal(selectedExport.startMode, "selected");
  assert.equal(selectedExport.startHighlightId, "gamma");
  assert.equal(selectedExport.points[0].highlightId, "gamma");
});

test("invalid geometry, duplicate ids, and unsafe budgets are rejected", () => {
  assert.throws(
    () =>
      planHighlightRoute(
        [
          { id: "duplicate", x: 1, z: 1 },
          { id: "duplicate", x: 2, z: 2 },
        ],
        bounds,
      ),
    /Duplicate highlight route id/,
  );
  assert.throws(
    () =>
      planHighlightRoute(
        [{ id: "invalid", x: Number.NaN, z: 0 }],
        bounds,
      ),
    /points are invalid/,
  );
  assert.throws(
    () =>
      planHighlightRoute([], {
        ...bounds,
        maxXExclusive: bounds.minX,
      }),
    /bounds are invalid/,
  );
  assert.throws(
    () => planHighlightRoute([], bounds, { exactPointLimit: 19 }),
    /exactPointLimit/,
  );
  assert.throws(
    () => planHighlightRoute([], bounds, { twoOptMaxPasses: 257 }),
    /twoOptMaxPasses/,
  );
  assert.throws(
    () =>
      planHighlightRoute(
        [{ id: "existing", x: 1, z: 1 }],
        bounds,
        { startHighlightId: "missing" },
      ),
    /Selected start highlight does not exist: missing/,
  );
  assert.throws(
    () =>
      planHighlightRoute([], bounds, {
        startHighlightId: 42,
      }),
    /startHighlightId must be a string or null/,
  );
});
