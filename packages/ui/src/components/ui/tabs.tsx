import { type ButtonHTMLAttributes, type HTMLAttributes, createContext, forwardRef, useContext, useState } from "react";
import { cn } from "@/lib/utils";

const TabsContext = createContext<{ value: string; onValueChange: (v: string) => void }>({
  value: "",
  onValueChange: () => {},
});

interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  defaultValue: string;
  onValueChange?: (value: string) => void;
}

function Tabs({ defaultValue, onValueChange, children, className, ...props }: TabsProps) {
  const [value, setValue] = useState(defaultValue);
  const handleChange = (v: string) => {
    setValue(v);
    onValueChange?.(v);
  };
  return (
    <TabsContext.Provider value={{ value, onValueChange: handleChange }}>
      <div className={cn("", className)} {...props}>{children}</div>
    </TabsContext.Provider>
  );
}

const TabsList = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground", className)} {...props} />
  ),
);
TabsList.displayName = "TabsList";

interface TabsTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

const TabsTrigger = forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, value, ...props }, ref) => {
    const ctx = useContext(TabsContext);
    const active = ctx.value === value;
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all",
          active ? "bg-background text-foreground shadow" : "hover:bg-background/50",
          className,
        )}
        onClick={() => ctx.onValueChange(value)}
        {...props}
      />
    );
  },
);
TabsTrigger.displayName = "TabsTrigger";

interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
}

const TabsContent = forwardRef<HTMLDivElement, TabsContentProps>(
  ({ className, value, ...props }, ref) => {
    const ctx = useContext(TabsContext);
    if (ctx.value !== value) return null;
    return <div ref={ref} className={cn("mt-2", className)} {...props} />;
  },
);
TabsContent.displayName = "TabsContent";

export { Tabs, TabsList, TabsTrigger, TabsContent };
