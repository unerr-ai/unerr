import { NavLink, Outlet } from "react-router-dom";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { to: "/", label: "Health", icon: "♥" },
  { to: "/sessions", label: "Sessions", icon: "◷" },
] as const;

export function DashboardLayout() {
  return (
    <div className="flex h-screen">
      <aside className="flex w-56 flex-col border-r border-border bg-zinc-950 p-4">
        <div className="mb-8 flex items-center gap-2 px-2">
          <span className="text-xl font-bold text-primary">unerr</span>
          <span className="text-xs text-muted-foreground">v0.1.0</span>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
                )
              }
            >
              <span>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-2 text-xs text-muted-foreground">
          Local Intelligence Proxy
        </div>
      </aside>
      <main className="flex-1 overflow-auto bg-background p-8">
        <Outlet />
      </main>
    </div>
  );
}
