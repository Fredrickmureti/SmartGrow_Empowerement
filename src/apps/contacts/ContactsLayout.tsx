/**
 * Contacts App Layout — PlatformShell (rail + sidebar).
 */

import { ReactNode } from "react";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { CONTACTS_APP } from "@/lib/apps/registry";
import { CONTACTS_NAV } from "./nav";

interface ContactsLayoutProps {
  children: ReactNode;
}

export function ContactsLayout({ children }: ContactsLayoutProps) {
  return (
    <PlatformShell app={CONTACTS_APP} nav={CONTACTS_NAV}>
      {children}
    </PlatformShell>
  );
}

export default ContactsLayout;
