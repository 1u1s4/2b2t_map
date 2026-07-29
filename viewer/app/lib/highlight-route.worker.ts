import { planHighlightRoute } from "./highlight-route";
import type {
  HighlightRouteWorkerRequest,
  HighlightRouteWorkerResponse,
} from "./highlight-route-worker-protocol";

type HighlightRouteWorkerScope = {
  onmessage:
    | ((event: MessageEvent<HighlightRouteWorkerRequest>) => void)
    | null;
  postMessage: (message: HighlightRouteWorkerResponse) => void;
};

const workerScope =
  globalThis as unknown as HighlightRouteWorkerScope;

workerScope.onmessage = (
  event: MessageEvent<HighlightRouteWorkerRequest>,
) => {
  const request = event.data;
  try {
    const plan = planHighlightRoute(request.points, request.bounds, {
      startHighlightId: request.startHighlightId,
    });
    workerScope.postMessage({
      requestId: request.requestId,
      ok: true,
      plan,
    });
  } catch (error) {
    workerScope.postMessage({
      requestId: request.requestId,
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "No se pudo calcular la ruta",
    });
  }
};

export {};
