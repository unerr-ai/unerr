import { BrowserRouter, Route, Routes } from "react-router-dom";
import { DashboardLayout } from "@/layouts/DashboardLayout";
import { HealthPage } from "@/pages/Health";
import { SessionsPage } from "@/pages/Sessions";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route index element={<HealthPage />} />
          <Route path="sessions" element={<SessionsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
