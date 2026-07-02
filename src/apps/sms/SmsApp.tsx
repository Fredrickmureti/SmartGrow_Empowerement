import { Routes, Route, Navigate } from "react-router-dom";
import { SmsLayout } from "./SmsLayout";
import SmsSettingsPage from "./pages/SmsSettingsPage";
import SmsTemplatesPage from "./pages/SmsTemplatesPage";
import SmsEventRulesPage from "./pages/SmsEventRulesPage";
import SmsLogPage from "./pages/SmsLogPage";
import SmsOptOutsPage from "./pages/SmsOptOutsPage";
import SmsRecipientGroupsPage from "./pages/SmsRecipientGroupsPage";

export function SmsApp() {
  return (
    <SmsLayout>
      <Routes>
        <Route path="settings" element={<SmsSettingsPage />} />
        <Route path="templates" element={<SmsTemplatesPage />} />
        <Route path="rules" element={<SmsEventRulesPage />} />
        <Route path="recipient-groups" element={<SmsRecipientGroupsPage />} />
        <Route path="log" element={<SmsLogPage />} />
        <Route path="opt-outs" element={<SmsOptOutsPage />} />
        <Route path="*" element={<Navigate to="settings" replace />} />
      </Routes>
    </SmsLayout>
  );
}

