import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createAppRouter } from "@/app/router";
import { startSubscriptionListener } from "@/app/subscriptionEvents";

const queryClient = new QueryClient();
const router = createAppRouter();
startSubscriptionListener(queryClient);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
