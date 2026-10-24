import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createAppRouter } from "@/app/router";
import { startSubscriptionListener } from "@/app/subscriptionEvents";
// 启动即应用已保存的阅读字体（模块加载时写 --font-reading），不必等打开设置页。
import "@/stores/readingFont";

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
