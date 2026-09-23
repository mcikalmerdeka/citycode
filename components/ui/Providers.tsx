"use client";

/**
 * Client providers — just TanStack Query for now. The QueryClient is created
 * once per browser session (lazy useState, never re-created on re-render)
 * with window-focus refetching off: an analysis is an explicit user action,
 * not something to silently refresh.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchOnWindowFocus: false },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
