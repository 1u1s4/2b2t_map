import type { WorldBounds } from "./exploration-grid";
import type {
  HighlightRoutePlan,
  HighlightRoutePoint,
} from "./highlight-route";

export interface HighlightRouteWorkerRequest {
  readonly requestId: number;
  readonly points: readonly HighlightRoutePoint[];
  readonly bounds: WorldBounds;
  readonly startHighlightId: string | null;
}

export type HighlightRouteWorkerResponse =
  | {
      readonly requestId: number;
      readonly ok: true;
      readonly plan: HighlightRoutePlan<HighlightRoutePoint>;
    }
  | {
      readonly requestId: number;
      readonly ok: false;
      readonly error: string;
    };
