let prefetched = false;
let routeReady = false;
let onReady: (() => void) | null = null;

export function preloadDefaultRoute() {
  if (prefetched) return;
  prefetched = true;
  // Trigger lazy chunk load for default /session page.
  import('./pages/RealTimeSessionPage');
}

export function isPrefetched() {
  return prefetched;
}

export function onRouteReady() {
  if (routeReady) return;
  routeReady = true;
  if (onReady) onReady();
}

export function whenRouteReady(): Promise<void> {
  if (routeReady) return Promise.resolve();
  return new Promise((resolve) => {
    onReady = resolve;
  });
}

export function resetRouteReady() {
  prefetched = false;
  routeReady = false;
  onReady = null;
}
