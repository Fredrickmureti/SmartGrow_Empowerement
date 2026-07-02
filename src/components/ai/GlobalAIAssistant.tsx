import { useAuth } from "@/contexts/AuthContext";
import { useLocation } from "react-router-dom";
import { useSession } from "@/contexts/SessionContext";
import { useAIAssistantContext } from "@/contexts/AIAssistantContext";
import { AIAssistantChat } from "./AIAssistantChat";

const publicRoutes = [
  "/", "/login", "/signup", "/demo", "/help", "/docs", "/about", "/blog",
  "/features", "/forgot-password", "/reset-password", "/accept-invitation", "/admin/login",
];

const excludedRoutes = [
  "/pos/terminal", "/pos/customer-display", "/customer-display",
];

export function GlobalAIAssistant() {
  const { user } = useAuth();
  const { userType } = useSession();
  const location = useLocation();
  const { isOpen, setIsOpen } = useAIAssistantContext();

  const isPublicRoute = publicRoutes.some(
    (route) => location.pathname === route || location.pathname.startsWith("/admin/login")
  );
  const isExcludedRoute = excludedRoutes.some(
    (route) => location.pathname.startsWith(route)
  );

  if (!user || isPublicRoute || isExcludedRoute || userType === "portal") {
    return null;
  }

  return (
    <AIAssistantChat
      open={isOpen}
      onOpenChange={setIsOpen}
      currentPath={location.pathname}
    />
  );
}
