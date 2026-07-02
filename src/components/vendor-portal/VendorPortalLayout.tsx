/**
 * Vendor Portal Layout - Separate from main app layout
 * Clean, minimal layout for vendor users with nav badge counts
 */
import { ReactNode } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useVendorPortal } from "@/hooks/useVendorPortal";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { 
  Package, ClipboardList, User, LogOut, Home,
  Loader2
} from "lucide-react";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

interface VendorPortalLayoutProps {
  children: ReactNode;
}

export function VendorPortalLayout({ children }: VendorPortalLayoutProps) {
  const { signOut } = useAuth();
  const { portalData, isLoading, purchaseOrders, rfqs } = useVendorPortal();
  const location = useLocation();
  const navigate = useNavigate();

  const pendingRFQCount = rfqs.filter(r => r.vendor_status === "pending").length;
  const openPOCount = purchaseOrders.filter(po => !["received", "cancelled"].includes(po.status)).length;

  const navItems = [
    { path: "/vendor-portal", label: "Dashboard", icon: Home, badge: 0 },
    { path: "/vendor-portal/purchase-orders", label: "Purchase Orders", icon: Package, badge: openPOCount },
    { path: "/vendor-portal/rfqs", label: "RFQs", icon: ClipboardList, badge: pendingRFQCount },
    { path: "/vendor-portal/profile", label: "Profile", icon: User, badge: 0 },
  ];

  const handleSignOut = async () => {
    await signOut();
    navigate("/login");
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-orange-500 flex items-center justify-center">
                <Package className="h-4 w-4 text-white" />
              </div>
              <div>
                <h1 className="text-sm font-semibold text-foreground">Vendor Portal</h1>
                <p className="text-xs text-muted-foreground">
                  {portalData.organizationName || "Organization"}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground hidden sm:block">
                {portalData.contactName}
              </span>
              <ThemeToggle />
              <Button variant="ghost" size="sm" onClick={handleSignOut}>
                <LogOut className="h-4 w-4 mr-2" />
                Sign Out
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <nav className="border-b bg-card/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex gap-1 overflow-x-auto">
            {navItems.map((item) => {
              const isActive = location.pathname === item.path ||
                (item.path !== "/vendor-portal" && location.pathname.startsWith(item.path + "/"));
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                    isActive
                      ? "border-orange-500 text-orange-600"
                      : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                  }`}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                  {item.badge > 0 && (
                    <span className="ml-1 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-orange-500 text-white text-xs font-bold">
                      {item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
