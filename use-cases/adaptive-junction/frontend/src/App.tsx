import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { CapturePage } from "./pages/CapturePage";
import { Dashboard } from "./pages/Dashboard";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/capture/:side" element={<CapturePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
