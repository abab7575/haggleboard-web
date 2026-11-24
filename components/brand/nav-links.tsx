"use client";

import { usePathname } from "next/navigation";

export const NAV = [
  { href: "/ring", label: "Practice ring" },
  { href: "/ring#league", label: "The league" },
  { href: "/board", label: "The board" },
  { href: "/experiment", label: "The experiment" },
  { href: "/agents", label: "For agents" },
  { href: "/stores", label: "For stores" },
];

export function NavLinks({ label }: { label: string }) {
  const path = usePathname();
  return (
    <nav aria-label={label}>
      {NAV.map((item) => (
        <a key={item.href} href={item.href} aria-current={path && !item.href.includes("#") && (path === item.href || path.startsWith(`${item.href}/`)) ? "page" : undefined}>
          {item.label}
        </a>
      ))}
    </nav>
  );
}
